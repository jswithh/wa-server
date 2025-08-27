import { LRUCache } from "lru-cache";
import { whatsappLogger } from "../utils/logger";
import { webhookService } from "./webhook";
import { databaseManager } from "../models/database";
import { messageDeduplicator } from "./message-deduplicator";

interface QueuedWebhook {
  messageId: string;
  messageDbId: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  type: string;
  priority: number;
  attempts: number;
  queuedAt: number;
}

export class WebhookQueue {
  private queue: LRUCache<string, QueuedWebhook>;
  private isProcessing: boolean = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 10;
  private readonly PROCESSING_INTERVAL = 1000; // 1 second
  private readonly MAX_QUEUE_SIZE = 1000;
  private readonly DEDUPLICATION_WINDOW = 5000; // 5 seconds
  private readonly QUEUE_TTL = 60 * 60 * 1000; // 1 hour

  constructor() {
    this.queue = new LRUCache({
      max: this.MAX_QUEUE_SIZE,
      ttl: this.QUEUE_TTL,
      allowStale: false,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
    });

    this.startProcessing();
    whatsappLogger.info("Webhook queue initialized with LRU cache", {
      maxQueueSize: this.MAX_QUEUE_SIZE,
      queueTtl: this.QUEUE_TTL,
    });
  }

  /**
   * Add message to webhook queue with deduplication
   */
  async addToQueue(
    messageId: string,
    messageDbId: string,
    from: string,
    to: string,
    content: string,
    timestamp: string,
    type: string = "text",
    priority: number = 1,
  ): Promise<boolean> {
    try {
      // Generate unique queue key
      const queueKey = this.generateQueueKey(messageId, from, to);

      // Check if already in queue
      if (this.queue.has(queueKey)) {
        whatsappLogger.debug("Message already in webhook queue", {
          messageId,
          queueKey,
          queueSize: this.queue.size,
        });
        return false;
      }

      // Check database-level deduplication
      const existingWebhook = await this.checkDatabaseDuplication(
        messageId,
        from,
        to,
        content,
      );
      if (existingWebhook) {
        whatsappLogger.debug("Message webhook already sent (database check)", {
          messageId,
          existingId: existingWebhook.id,
          from,
          to,
        });
        return false;
      }

      // Check memory-level deduplication
      const messageIdentifier = {
        messageId,
        from,
        to,
        content,
        timestamp: parseInt(timestamp) * 1000,
      };

      if (messageDeduplicator.isWebhookSent(messageIdentifier)) {
        whatsappLogger.debug("Message webhook already sent (memory check)", {
          messageId,
          from,
          to,
        });
        return false;
      }

      // LRU cache handles size limits automatically, but log if approaching limit
      if (this.queue.size >= this.MAX_QUEUE_SIZE * 0.9) {
        whatsappLogger.warn("Webhook queue approaching size limit", {
          currentSize: this.queue.size,
          maxSize: this.MAX_QUEUE_SIZE,
        });
      }

      // Add to queue
      const queuedWebhook: QueuedWebhook = {
        messageId,
        messageDbId,
        from,
        to,
        content,
        timestamp,
        type,
        priority,
        attempts: 0,
        queuedAt: Date.now(),
      };

      this.queue.set(queueKey, queuedWebhook);

      whatsappLogger.debug("Message added to webhook queue", {
        messageId,
        queueKey,
        queueSize: this.queue.size,
        priority,
      });

      return true;
    } catch (error) {
      whatsappLogger.error("Error adding message to webhook queue:", {
        error: error instanceof Error ? error.message : String(error),
        messageId,
        from,
        to,
      });
      return false;
    }
  }

  /**
   * Process webhook queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.size === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Get batch of messages to process (sorted by priority and time)
      const batch = this.getBatch();

      if (batch.length === 0) {
        return;
      }

      whatsappLogger.debug("Processing webhook batch", {
        batchSize: batch.length,
        queueSize: this.queue.size,
      });

      // Process batch atomically
      await this.processBatch(batch);
    } catch (error) {
      whatsappLogger.error("Error processing webhook queue:", error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get batch of messages to process
   */
  private getBatch(): QueuedWebhook[] {
    const entries: Array<{ key: string; webhook: QueuedWebhook }> = [];

    // Convert LRU entries to array
    this.queue.forEach((webhook: QueuedWebhook, key: string) => {
      entries.push({ key, webhook });
    });

    // Sort by priority (higher first), then by queuedAt (older first)
    const sortedEntries = entries
      .sort((a, b) => {
        if (a.webhook.priority !== b.webhook.priority) {
          return b.webhook.priority - a.webhook.priority;
        }
        return a.webhook.queuedAt - b.webhook.queuedAt;
      })
      .slice(0, this.BATCH_SIZE);

    return sortedEntries.map((entry) => entry.webhook);
  }

  /**
   * Process batch of webhooks atomically
   */
  private async processBatch(batch: QueuedWebhook[]): Promise<void> {
    for (const webhook of batch) {
      try {
        const queueKey = this.generateQueueKey(
          webhook.messageId,
          webhook.from,
          webhook.to,
        );

        // Double-check deduplication before sending
        const shouldSkip = await this.shouldSkipWebhook(webhook);
        if (shouldSkip) {
          this.queue.delete(queueKey);
          continue;
        }

        // Send webhook
        const result = await this.sendWebhookAtomic(webhook);

        // Update database and memory state atomically
        await this.updateWebhookStatus(
          webhook,
          result.success,
          result.attempts,
        );

        // Update memory deduplicator
        const messageIdentifier = {
          messageId: webhook.messageId,
          from: webhook.from,
          to: webhook.to,
          content: webhook.content,
          timestamp: parseInt(webhook.timestamp) * 1000,
        };

        if (result.success) {
          messageDeduplicator.markWebhookSent(
            messageIdentifier,
            result.attempts,
          );
        } else {
          messageDeduplicator.markAsCompleted(messageIdentifier, false);
        }

        // Remove from queue
        this.queue.delete(queueKey);

        whatsappLogger.debug("Webhook processed", {
          messageId: webhook.messageId,
          success: result.success,
          attempts: result.attempts,
          queueKey,
        });
      } catch (error) {
        whatsappLogger.error("Error processing individual webhook:", {
          error: error instanceof Error ? error.message : String(error),
          messageId: webhook.messageId,
          from: webhook.from,
          to: webhook.to,
        });

        // Increment attempts and retry later if not max attempts
        webhook.attempts++;
        if (webhook.attempts >= 3) {
          const queueKey = this.generateQueueKey(
            webhook.messageId,
            webhook.from,
            webhook.to,
          );
          this.queue.delete(queueKey);
          whatsappLogger.warn(
            "Webhook max attempts reached, removing from queue",
            {
              messageId: webhook.messageId,
              attempts: webhook.attempts,
            },
          );
        }
      }
    }
  }

  /**
   * Send webhook with atomic operation
   */
  private async sendWebhookAtomic(
    webhook: QueuedWebhook,
  ): Promise<{ success: boolean; attempts: number }> {
    const payload = {
      from: webhook.from,
      to: webhook.to,
      message: webhook.content,
      timestamp: webhook.timestamp,
      type: webhook.type,
    };

    // Use existing webhook service but track attempts
    const message = {
      id: webhook.messageDbId,
      message_id: webhook.messageId,
      from: webhook.from,
      to: webhook.to,
      message: webhook.content,
      timestamp: webhook.timestamp,
      type: webhook.type as
        | "text"
        | "image"
        | "video"
        | "audio"
        | "document"
        | "sticker",
      account_id: "unknown", // We don't have this in queue, but webhook service handles it
      direction: "inbound" as const,
      raw_data: JSON.stringify(payload),
      webhook_sent: false,
      webhook_attempts: webhook.attempts,
      created_at: new Date().toISOString(),
    };

    return await webhookService.sendMessage(message);
  }

  /**
   * Check if webhook should be skipped (final deduplication check)
   */
  private async shouldSkipWebhook(webhook: QueuedWebhook): Promise<boolean> {
    try {
      // ✅ CRITICAL: Check if message exists in database FIRST
      const messageExists = await databaseManager.getDatabase().get(
        `
        SELECT id, webhook_sent, webhook_attempts, created_at
        FROM messages
        WHERE message_id = ?
        LIMIT 1
      `,
        [webhook.messageId],
      );

      if (!messageExists) {
        whatsappLogger.error(
          "❌ CRITICAL: Message not found in database - skipping webhook",
          {
            messageId: webhook.messageId,
            webhookContent: webhook.content.substring(0, 50),
            from: webhook.from,
            to: webhook.to,
            reason: "message_not_in_database",
          },
        );
        return true; // Skip webhook if message doesn't exist in DB
      }

      // Check if webhook already sent
      if (messageExists.webhook_sent === 1) {
        whatsappLogger.debug("Webhook already sent (final database check)", {
          messageId: webhook.messageId,
          dbId: messageExists.id,
          webhookAttempts: messageExists.webhook_attempts,
        });
        return true;
      }

      whatsappLogger.debug(
        "✅ Message exists in database, proceeding with webhook",
        {
          messageId: webhook.messageId,
          dbId: messageExists.id,
          created: messageExists.created_at,
        },
      );

      // Check for recent similar content
      const now = Date.now();
      const windowStart = now - this.DEDUPLICATION_WINDOW;

      const contentCheck = await databaseManager.getDatabase().get(
        `
        SELECT id, message_id, webhook_sent
        FROM messages
        WHERE [from] = ? AND [to] = ?
          AND SUBSTR(message, 1, 100) = SUBSTR(?, 1, 100)
          AND webhook_sent = 1
          AND created_at > datetime(?, 'unixepoch')
        ORDER BY created_at DESC
        LIMIT 1
      `,
        [
          webhook.from,
          webhook.to,
          webhook.content,
          Math.floor(windowStart / 1000),
        ],
      );

      if (contentCheck) {
        whatsappLogger.debug("Similar content webhook already sent recently", {
          messageId: webhook.messageId,
          existingMessageId: contentCheck.message_id,
          from: webhook.from,
          to: webhook.to,
        });
        return true;
      }

      return false;
    } catch (error) {
      whatsappLogger.error("Error in final deduplication check:", error);
      return false; // When in doubt, don't skip
    }
  }

  /**
   * Update webhook status in database
   */
  private async updateWebhookStatus(
    webhook: QueuedWebhook,
    success: boolean,
    attempts: number,
  ): Promise<void> {
    try {
      await databaseManager.updateMessageWebhookStatus(
        webhook.messageDbId,
        success,
        attempts,
      );
    } catch (error) {
      whatsappLogger.error("Error updating webhook status in database:", {
        error: error instanceof Error ? error.message : String(error),
        messageId: webhook.messageId,
        messageDbId: webhook.messageDbId,
        success,
        attempts,
      });
    }
  }

  /**
   * Check database for existing webhook
   */
  private async checkDatabaseDuplication(
    messageId: string,
    from: string,
    to: string,
    content: string,
  ): Promise<any | null> {
    try {
      // Check exact message ID first
      let existing = await databaseManager.getDatabase().get(
        `
        SELECT id, message_id, webhook_sent, webhook_attempts, created_at
        FROM messages
        WHERE message_id = ? AND webhook_sent = 1
        LIMIT 1
      `,
        [messageId],
      );

      if (existing) {
        return existing;
      }

      // Check for similar content in recent time window
      const windowStart = Date.now() - this.DEDUPLICATION_WINDOW;
      existing = await databaseManager.getDatabase().get(
        `
        SELECT id, message_id, webhook_sent, webhook_attempts, created_at
        FROM messages
        WHERE [from] = ? AND [to] = ?
          AND SUBSTR(message, 1, 150) = SUBSTR(?, 1, 150)
          AND webhook_sent = 1
          AND created_at > datetime(?, 'unixepoch')
        ORDER BY created_at DESC
        LIMIT 1
      `,
        [from, to, content, Math.floor(windowStart / 1000)],
      );

      return existing;
    } catch (error) {
      whatsappLogger.error("Error checking database duplication:", error);
      return null;
    }
  }

  /**
   * Generate unique queue key
   */
  private generateQueueKey(
    messageId: string,
    from: string,
    to: string,
  ): string {
    return `${messageId}_${from}_${to}`;
  }

  /**
   * Force removal of oldest entries (LRU handles this automatically, but keeping for manual cleanup)
   */
  private removeOldestEntries(count: number): void {
    const entries: Array<{ key: string; webhook: QueuedWebhook }> = [];

    this.queue.forEach((webhook: QueuedWebhook, key: string) => {
      entries.push({ key, webhook });
    });

    const sortedEntries = entries
      .sort((a, b) => a.webhook.queuedAt - b.webhook.queuedAt)
      .slice(0, count);

    for (const entry of sortedEntries) {
      this.queue.delete(entry.key);
    }

    whatsappLogger.debug("Manually removed oldest queue entries", {
      removedCount: sortedEntries.length,
      newQueueSize: this.queue.size,
    });
  }

  /**
   * Start processing queue
   */
  private startProcessing(): void {
    this.processingInterval = setInterval(async () => {
      await this.processQueue();
    }, this.PROCESSING_INTERVAL);

    whatsappLogger.info("Webhook queue processing started", {
      interval: this.PROCESSING_INTERVAL,
      batchSize: this.BATCH_SIZE,
      maxQueueSize: this.MAX_QUEUE_SIZE,
    });
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    queueSize: number;
    isProcessing: boolean;
    oldestEntry: number | null;
    newestEntry: number | null;
    priorityDistribution: Record<number, number>;
  } {
    const priorityDistribution: Record<number, number> = {};
    let oldestEntry: number | null = null;
    let newestEntry: number | null = null;

    this.queue.forEach((entry: QueuedWebhook) => {
      priorityDistribution[entry.priority] =
        (priorityDistribution[entry.priority] || 0) + 1;

      if (oldestEntry === null || entry.queuedAt < oldestEntry) {
        oldestEntry = entry.queuedAt;
      }

      if (newestEntry === null || entry.queuedAt > newestEntry) {
        newestEntry = entry.queuedAt;
      }
    });

    return {
      queueSize: this.queue.size,
      isProcessing: this.isProcessing,
      oldestEntry,
      newestEntry,
      priorityDistribution,
    };
  }

  /**
   * Clear queue
   */
  clearQueue(): void {
    const clearedCount = this.queue.size;
    this.queue.clear();
    whatsappLogger.info("Webhook LRU queue cleared", {
      clearedCount,
    });
  }

  /**
   * Shutdown webhook queue
   */
  shutdown(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    this.clearQueue();
    whatsappLogger.info("Webhook queue shut down");
  }

  /**
   * Force process queue immediately
   */
  async forceProcess(): Promise<void> {
    whatsappLogger.info("Force processing webhook queue", {
      queueSize: this.queue.size,
    });
    await this.processQueue();
  }
}

// Export singleton instance
export const webhookQueue = new WebhookQueue();
