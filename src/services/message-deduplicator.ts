import { LRUCache } from "lru-cache";
import { whatsappLogger } from "../utils/logger";

interface MessageIdentifier {
  messageId: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

interface ProcessingState {
  isProcessing: boolean;
  processedAt: number;
  webhookSent: boolean;
  attempts: number;
}

export class MessageDeduplicator {
  private processedMessages: LRUCache<string, ProcessingState>;
  private contentHashes: LRUCache<string, string>;
  private readonly MAX_CACHE_SIZE = 10000;
  private readonly CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    this.processedMessages = new LRUCache({
      max: this.MAX_CACHE_SIZE,
      ttl: this.CACHE_EXPIRY_MS,
      allowStale: false,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
    });

    this.contentHashes = new LRUCache({
      max: this.MAX_CACHE_SIZE,
      ttl: this.CACHE_EXPIRY_MS,
      allowStale: false,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
    });

    whatsappLogger.info("Message deduplicator initialized with LRU cache", {
      maxCacheSize: this.MAX_CACHE_SIZE,
      cacheExpiryMs: this.CACHE_EXPIRY_MS,
    });
  }

  /**
   * Generate unique identifier for a message
   */
  private generateMessageKey(identifier: MessageIdentifier): string {
    return `${identifier.messageId}_${identifier.from}_${identifier.to}`;
  }

  /**
   * Generate content hash for duplicate content detection
   */
  private generateContentHash(
    content: string,
    from: string,
    to: string,
  ): string {
    const normalizedContent = content.trim().toLowerCase();
    return `${from}_${to}_${normalizedContent}`;
  }

  /**
   * Check if message is already processed or currently being processed
   */
  isMessageProcessed(identifier: MessageIdentifier): boolean {
    const key = this.generateMessageKey(identifier);
    const state = this.processedMessages.get(key);

    if (!state) {
      return false;
    }

    whatsappLogger.debug("Message already processed", {
      messageId: identifier.messageId,
      from: identifier.from,
      to: identifier.to,
      processedAt: new Date(state.processedAt).toISOString(),
      isProcessing: state.isProcessing,
      webhookSent: state.webhookSent,
    });

    return true;
  }

  /**
   * Check if similar content was recently sent (content-based deduplication)
   */
  isDuplicateContent(
    identifier: MessageIdentifier,
    windowMs: number = 30000,
  ): boolean {
    const contentHash = this.generateContentHash(
      identifier.content,
      identifier.from,
      identifier.to,
    );
    const existingMessageId = this.contentHashes.get(contentHash);

    if (!existingMessageId) {
      return false;
    }

    const existingState = this.processedMessages.get(existingMessageId);
    if (!existingState) {
      // Clean up orphaned content hash (LRU will handle automatic cleanup)
      this.contentHashes.delete(contentHash);
      return false;
    }

    const timeDiff = Date.now() - existingState.processedAt;
    if (timeDiff > windowMs) {
      // Outside duplicate detection window
      return false;
    }

    whatsappLogger.warn("Duplicate content detected", {
      messageId: identifier.messageId,
      existingMessageId: existingMessageId,
      content: identifier.content.substring(0, 50),
      timeDiffMs: timeDiff,
      from: identifier.from,
      to: identifier.to,
    });

    return true;
  }

  /**
   * Mark message as being processed
   */
  markAsProcessing(identifier: MessageIdentifier): boolean {
    const key = this.generateMessageKey(identifier);

    // Check if already processed or processing
    if (this.isMessageProcessed(identifier)) {
      return false;
    }

    // Check for duplicate content in recent time window
    if (this.isDuplicateContent(identifier)) {
      return false;
    }

    const now = Date.now();
    this.processedMessages.set(key, {
      isProcessing: true,
      processedAt: now,
      webhookSent: false,
      attempts: 0,
    });

    // Store content hash for duplicate detection
    const contentHash = this.generateContentHash(
      identifier.content,
      identifier.from,
      identifier.to,
    );
    this.contentHashes.set(contentHash, key);

    whatsappLogger.debug("Message marked as processing", {
      messageId: identifier.messageId,
      from: identifier.from,
      to: identifier.to,
      key: key,
    });

    return true;
  }

  /**
   * Mark message as fully processed
   */
  markAsCompleted(
    identifier: MessageIdentifier,
    webhookSent: boolean = false,
  ): void {
    const key = this.generateMessageKey(identifier);
    const state = this.processedMessages.get(key);

    if (state) {
      this.processedMessages.set(key, {
        ...state,
        isProcessing: false,
        webhookSent: webhookSent,
        processedAt: Date.now(),
      });

      whatsappLogger.debug("Message marked as completed", {
        messageId: identifier.messageId,
        from: identifier.from,
        to: identifier.to,
        webhookSent: webhookSent,
      });
    }
  }

  /**
   * Mark webhook as sent for a message
   */
  markWebhookSent(identifier: MessageIdentifier, attempts: number = 1): void {
    const key = this.generateMessageKey(identifier);
    const state = this.processedMessages.get(key);

    if (state) {
      this.processedMessages.set(key, {
        ...state,
        webhookSent: true,
        attempts: attempts,
      });

      whatsappLogger.debug("Webhook marked as sent", {
        messageId: identifier.messageId,
        from: identifier.from,
        to: identifier.to,
        attempts: attempts,
      });
    }
  }

  /**
   * Check if webhook was already sent for this message
   */
  isWebhookSent(identifier: MessageIdentifier): boolean {
    const key = this.generateMessageKey(identifier);
    const state = this.processedMessages.get(key);
    return state?.webhookSent === true;
  }

  /**
   * Remove message from tracking (for cleanup or manual removal)
   */
  removeMessage(identifier: MessageIdentifier): void {
    const key = this.generateMessageKey(identifier);

    // Remove from processed messages
    this.processedMessages.delete(key);

    // Remove associated content hash
    const contentHash = this.generateContentHash(
      identifier.content,
      identifier.from,
      identifier.to,
    );
    if (this.contentHashes.get(contentHash) === key) {
      this.contentHashes.delete(contentHash);
    }

    whatsappLogger.debug("Message removed from deduplicator", {
      messageId: identifier.messageId,
      from: identifier.from,
      to: identifier.to,
    });
  }

  /**
   * Get processing statistics
   */
  getStats(): {
    totalProcessed: number;
    currentlyProcessing: number;
    webhooksSent: number;
    cacheSize: number;
    contentHashesSize: number;
  } {
    let currentlyProcessing = 0;
    let webhooksSent = 0;

    // Iterate through LRU cache values
    this.processedMessages.forEach((state: ProcessingState) => {
      if (state.isProcessing) {
        currentlyProcessing++;
      }
      if (state.webhookSent) {
        webhooksSent++;
      }
    });

    return {
      totalProcessed: this.processedMessages.size,
      currentlyProcessing,
      webhooksSent,
      cacheSize: this.processedMessages.size,
      contentHashesSize: this.contentHashes.size,
    };
  }

  /**
   * Clear all tracking data (use with caution)
   */
  clearAll(): void {
    this.processedMessages.clear();
    this.contentHashes.clear();
    whatsappLogger.info("Message deduplicator LRU cache cleared");
  }

  /**
   * Clean up orphaned content hashes (LRU handles automatic TTL cleanup)
   */
  private cleanupOrphanedHashes(): void {
    let contentHashesCleanedCount = 0;

    // Clean up orphaned content hashes
    this.contentHashes.forEach((messageKey: string, contentHash: string) => {
      if (!this.processedMessages.has(messageKey)) {
        this.contentHashes.delete(contentHash);
        contentHashesCleanedCount++;
      }
    });

    if (contentHashesCleanedCount > 0) {
      whatsappLogger.debug("Cleaned up orphaned content hashes", {
        contentHashesCleanedCount: contentHashesCleanedCount,
        remainingMessages: this.processedMessages.size,
        remainingContentHashes: this.contentHashes.size,
      });
    }
  }

  /**
   * Stop cleanup task (for shutdown) - LRU handles most cleanup automatically
   */
  shutdown(): void {
    // Cleanup orphaned hashes one final time
    this.cleanupOrphanedHashes();
    whatsappLogger.info("Message deduplicator shutdown completed");
  }

  /**
   * Get recent duplicate attempts for debugging
   */
  getRecentDuplicates(limit: number = 10): Array<{
    messageId: string;
    contentHash: string;
    attempts: number;
    lastAttempt: string;
  }> {
    const duplicates: Array<{
      messageId: string;
      contentHash: string;
      attempts: number;
      lastAttempt: string;
    }> = [];

    const entries: Array<[string, ProcessingState]> = [];

    // Convert LRU entries to array for sorting
    this.processedMessages.forEach((state: ProcessingState, key: string) => {
      if (state.attempts > 1) {
        entries.push([key, state]);
      }
    });

    const sortedEntries = entries
      .sort(([, a], [, b]) => b.processedAt - a.processedAt)
      .slice(0, limit);

    for (const [key, state] of sortedEntries) {
      const parts = key.split("_");
      duplicates.push({
        messageId: parts[0] || "unknown",
        contentHash: key,
        attempts: state.attempts,
        lastAttempt: new Date(state.processedAt).toISOString(),
      });
    }

    return duplicates;
  }
}

// Export singleton instance
export const messageDeduplicator = new MessageDeduplicator();
