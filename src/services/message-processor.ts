import { LRUCache } from "lru-cache";
import { WAMessage } from "baileys";
import { databaseManager } from "../models/database";
import { webhookService } from "./webhook";
import { whatsappLogger } from "../utils/logger";
import { phoneNumberService } from "../utils/phone-service";
import { messageDeduplicator } from "./message-deduplicator";
import { webhookQueue } from "./webhook-queue";

export interface ProcessedMessage {
  id: string;
  accountId: string;
  from: string;
  to: string;
  message: string;
  timestamp: string;
  type: string;
  direction: "inbound" | "outbound";
  messageId: string;
  rawData: string;
}

class MessageProcessor {
  private processedMessageIds: LRUCache<string, boolean>;
  private contentCache: LRUCache<string, string>;
  private readonly PROCESSED_IDS_CACHE_SIZE = 5000;
  private readonly PROCESSED_IDS_TTL = 2 * 60 * 60 * 1000; // 2 hours
  private readonly CONTENT_CACHE_SIZE = 1000;
  private readonly CONTENT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    this.processedMessageIds = new LRUCache({
      max: this.PROCESSED_IDS_CACHE_SIZE,
      ttl: this.PROCESSED_IDS_TTL,
      allowStale: false,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
    });

    this.contentCache = new LRUCache({
      max: this.CONTENT_CACHE_SIZE,
      ttl: this.CONTENT_CACHE_TTL,
      allowStale: false,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
    });

    whatsappLogger.info("MessageProcessor initialized", {
      processedIdsCacheSize: this.PROCESSED_IDS_CACHE_SIZE,
      processedIdsTTL: this.PROCESSED_IDS_TTL,
      contentCacheSize: this.CONTENT_CACHE_SIZE,
      contentCacheTTL: this.CONTENT_CACHE_TTL,
    });
  }

  /**
   * Process incoming WhatsApp message directly
   */
  async processIncomingMessage(
    accountId: string,
    message: WAMessage,
    recipientPhone: string,
  ): Promise<void> {
    try {
      if (!message.key.id) {
        whatsappLogger.warn("Message has no ID, skipping");
        return;
      }

      // Skip status broadcasts
      if (message.key.remoteJid?.includes("status@broadcast")) {
        whatsappLogger.debug("Skipping status broadcast");
        return;
      }

      // Create message identifier for deduplication
      const fromNumber = message.key.fromMe
        ? phoneNumberService.clean(recipientPhone)
        : phoneNumberService.clean(message.key.remoteJid || "") || "unknown";

      const toNumber = message.key.fromMe
        ? phoneNumberService.clean(message.key.remoteJid || "") || "unknown"
        : phoneNumberService.clean(recipientPhone);

      // Extract content first for deduplication check
      let actualContent = null;
      if (message.message?.conversation) {
        actualContent = message.message.conversation;
      } else if (message.message?.extendedTextMessage?.text) {
        actualContent = message.message.extendedTextMessage.text;
      } else {
        // Check cached content from protocol interception
        actualContent = this.getCachedContent(message.key.id);
      }

      let extractedData;
      if (actualContent) {
        extractedData = { content: actualContent, type: "text" };
      } else {
        extractedData = this.extractMessageContent(message);
      }

      const messageIdentifier = {
        messageId: message.key.id,
        from: fromNumber,
        to: toNumber,
        content: extractedData.content,
        timestamp:
          (Number(message.messageTimestamp) || Math.floor(Date.now() / 1000)) *
          1000,
      };

      // Check deduplication before any processing
      if (!messageDeduplicator.markAsProcessing(messageIdentifier)) {
        whatsappLogger.debug("Message skipped due to deduplication", {
          messageId: message.key.id,
          from: fromNumber,
          to: toNumber,
          contentPreview: extractedData.content.substring(0, 50),
        });
        return;
      }

      whatsappLogger.info("Processing message:", {
        messageId: message.key.id,
        from: message.key.remoteJid,
        to: recipientPhone,
        direction: message.key.fromMe ? "outbound" : "inbound",
        hasActualMessage: !!message.message,
        messageKeys: message.message ? Object.keys(message.message) : [],
        timestamp: message.messageTimestamp,
        fullMessageStructure: JSON.stringify(message).substring(0, 500),
      });

      // Continue with processing (deduplication already checked above)

      const processedMessage: ProcessedMessage = {
        id: `${accountId}_msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId: accountId,
        from: fromNumber,
        to: toNumber,
        message: extractedData.content,
        timestamp: (
          Number(message.messageTimestamp) || Math.floor(Date.now() / 1000)
        ).toString(),
        type: extractedData.type,
        direction: message.key.fromMe ? "outbound" : "inbound",
        messageId: message.key.id,
        rawData: JSON.stringify(message),
      };

      whatsappLogger.info("Prepared message for database:", {
        messageId: processedMessage.messageId,
        from: processedMessage.from,
        to: processedMessage.to,
        content: processedMessage.message.substring(0, 100),
        type: processedMessage.type,
        timestamp: processedMessage.timestamp,
      });

      // Save to database
      await this.saveToDatabase(processedMessage);

      // Mark as processed in both systems
      this.processedMessageIds.set(message.key.id, true);
      messageDeduplicator.markAsCompleted(messageIdentifier, false);

      // Add to webhook queue instead of direct trigger
      await webhookQueue.addToQueue(
        processedMessage.messageId,
        processedMessage.id,
        processedMessage.from,
        processedMessage.to,
        processedMessage.message,
        processedMessage.timestamp,
        processedMessage.type,
        1, // normal priority
      );

      whatsappLogger.info("Message processed successfully:", {
        messageId: processedMessage.messageId,
        dbId: processedMessage.id,
        saved: true,
      });
    } catch (error) {
      whatsappLogger.error("Error processing incoming message:", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        messageId: message.key.id,
        from: message.key.remoteJid,
      });

      // Remove from deduplicator if processing failed
      if (message.key.id) {
        const fromNumber = message.key.fromMe
          ? phoneNumberService.clean(recipientPhone)
          : phoneNumberService.clean(message.key.remoteJid || "") || "unknown";
        const toNumber = message.key.fromMe
          ? phoneNumberService.clean(message.key.remoteJid || "") || "unknown"
          : phoneNumberService.clean(recipientPhone);

        messageDeduplicator.removeMessage({
          messageId: message.key.id,
          from: fromNumber,
          to: toNumber,
          content: "failed",
          timestamp: Date.now(),
        });
      }

      // Don't throw error to prevent breaking other message processing
    }
  }

  /**
   * Extract content from WAMessage with smart reconstruction
   */
  private extractMessageContent(message: WAMessage): {
    content: string;
    type: string;
  } {
    // If no message content, create a simple message entry
    if (!message.message) {
      return { content: "Message received", type: "text" };
    }

    const msg = message.message;

    // Text message
    if (msg.conversation) {
      return { content: msg.conversation, type: "text" };
    }

    // Extended text message
    if (msg.extendedTextMessage?.text) {
      return { content: msg.extendedTextMessage.text, type: "text" };
    }

    // Image message
    if (msg.imageMessage) {
      return {
        content: msg.imageMessage.caption || "📷 Image",
        type: "image",
      };
    }

    // Video message
    if (msg.videoMessage) {
      return {
        content: msg.videoMessage.caption || "🎥 Video",
        type: "video",
      };
    }

    // Audio message
    if (msg.audioMessage) {
      return { content: "🎵 Audio message", type: "audio" };
    }

    // Document message
    if (msg.documentMessage) {
      return {
        content:
          msg.documentMessage.title ||
          msg.documentMessage.fileName ||
          "📄 Document",
        type: "document",
      };
    }

    // Sticker message
    if (msg.stickerMessage) {
      return { content: "Sticker", type: "sticker" };
    }

    // Contact message
    if (msg.contactMessage) {
      return { content: "📞 Contact", type: "contact" };
    }

    // Location message
    if (msg.locationMessage) {
      return { content: "📍 Location", type: "location" };
    }

    // Poll message
    if (msg.pollCreationMessage) {
      return { content: "📊 Poll", type: "poll" };
    }

    // Buttons message
    if (msg.buttonsMessage?.contentText) {
      return { content: msg.buttonsMessage.contentText, type: "buttons" };
    }

    // Template message
    if (msg.templateMessage?.hydratedTemplate?.hydratedContentText) {
      return {
        content: msg.templateMessage.hydratedTemplate.hydratedContentText,
        type: "template",
      };
    }

    // List message
    if (msg.listMessage?.description) {
      return { content: msg.listMessage.description, type: "list" };
    }

    // Other message types
    const messageTypes = Object.keys(msg);
    if (messageTypes.length > 0 && messageTypes[0]) {
      const messageType = messageTypes[0].replace("Message", "");

      // Try to find any text content in the message
      const messageStr = JSON.stringify(msg);
      if (messageStr.includes('"text"')) {
        const textMatch = messageStr.match(/"text"\s*:\s*"([^"]+)"/);
        if (textMatch && textMatch[1]) {
          return { content: textMatch[1], type: messageType };
        }
      }

      if (messageStr.includes('"caption"')) {
        const captionMatch = messageStr.match(/"caption"\s*:\s*"([^"]+)"/);
        if (captionMatch && captionMatch[1]) {
          return { content: captionMatch[1], type: messageType };
        }
      }

      return { content: `${messageType} message`, type: messageType };
    }

    return { content: "Message received", type: "unknown" };
  }

  /**
   * Enhanced protocol data interception (consolidated from message-content-extractor)
   * Intercepts and extracts content from raw protocol data
   */
  interceptProtocolData(data: any): void {
    try {
      const dataStr = JSON.stringify(data);

      // Extract content from conversation messages
      if (dataStr.includes('"conversation"')) {
        const conversationMatch = dataStr.match(
          /"conversation"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/,
        );
        if (conversationMatch && conversationMatch[1]) {
          const content = conversationMatch[1]
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
          const messageId = this.extractMessageId(data, dataStr);

          if (messageId && content) {
            this.contentCache.set(messageId, content);
            whatsappLogger.info("🎯 Captured conversation content", {
              messageId,
              content: content.substring(0, 100),
              source: "conversation",
            });
          }
        }
      }

      // Extract content from extended text messages
      if (dataStr.includes('"extendedTextMessage"')) {
        const textMatch = dataStr.match(
          /"text"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/,
        );
        if (textMatch && textMatch[1]) {
          const content = textMatch[1]
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
          const messageId = this.extractMessageId(data, dataStr);

          if (messageId && content) {
            this.contentCache.set(messageId, content);
            whatsappLogger.info("🎯 Captured extended text content", {
              messageId,
              content: content.substring(0, 100),
              source: "extendedTextMessage",
            });
          }
        }
      }

      // Extract content from receipt/ack messages
      if (data.recv && data.recv.attrs) {
        const attrs = data.recv.attrs;
        if (
          attrs.id &&
          attrs.from &&
          !attrs.from.includes("status@broadcast")
        ) {
          if (
            dataStr.includes('"conversation"') ||
            dataStr.includes('"text"')
          ) {
            const conversationMatch = dataStr.match(
              /"conversation"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/,
            );
            const textMatch = dataStr.match(
              /"text"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/,
            );

            const content = conversationMatch?.[1] || textMatch?.[1];
            if (content) {
              const cleanContent = content
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, "\\");
              this.contentCache.set(attrs.id, cleanContent);

              whatsappLogger.info("🎯 Captured receipt content", {
                messageId: attrs.id,
                content: cleanContent.substring(0, 100),
                from: attrs.from,
                source: "receipt_with_content",
              });
            }
          }
        }
      }

      // Cleanup cache periodically
      if (Math.random() < 0.01) {
        // 1% chance
        this.cleanupContentCache();
      }
    } catch (error) {
      whatsappLogger.debug(
        "Error parsing protocol data for content extraction:",
        error,
      );
    }
  }

  /**
   * Extract message ID from protocol data
   */
  private extractMessageId(data: any, dataStr: string): string | null {
    if (data.key?.id) {
      return data.key.id;
    }

    const idMatch = dataStr.match(/"id"\s*:\s*"([^"]+)"/);
    return idMatch?.[1] || null;
  }

  /**
   * Get cached message content by ID
   */
  getCachedContent(messageId: string): string | null {
    return this.contentCache.get(messageId) || null;
  }

  /**
   * Store content in cache
   */
  setCachedContent(messageId: string, content: string): void {
    this.contentCache.set(messageId, content);
  }

  /**
   * Clean up old content cache entries
   */
  private cleanupContentCache(): void {
    const currentSize = this.contentCache.size;
    if (currentSize > this.CONTENT_CACHE_SIZE * 0.8) {
      // Cleanup when 80% full
      // LRU cache will automatically remove old entries, just log the action
      whatsappLogger.debug("Content cache cleanup triggered", {
        currentSize,
        maxSize: this.CONTENT_CACHE_SIZE,
      });
    }
  }

  /**
   * Save message to database
   */
  private async saveToDatabase(
    processedMessage: ProcessedMessage,
  ): Promise<void> {
    try {
      await databaseManager.saveMessage({
        id: processedMessage.id,
        account_id: processedMessage.accountId,
        from: processedMessage.from,
        to: processedMessage.to,
        message: processedMessage.message,
        timestamp: processedMessage.timestamp,
        type: processedMessage.type as any,
        direction: processedMessage.direction,
        message_id: processedMessage.messageId,
        raw_data: processedMessage.rawData,
        webhook_sent: false,
        webhook_attempts: 0,
      });

      whatsappLogger.info("Message saved to database:", {
        dbId: processedMessage.id,
        messageId: processedMessage.messageId,
      });
    } catch (error) {
      whatsappLogger.error("Failed to save message to database:", {
        error: error instanceof Error ? error.message : String(error),
        messageId: processedMessage.messageId,
      });
      throw error;
    }
  }

  /**
   * Trigger webhook processing (now using webhook queue)
   */
  private async triggerWebhook(): Promise<void> {
    try {
      // Force process the webhook queue immediately
      await webhookQueue.forceProcess();
    } catch (error) {
      whatsappLogger.error("Error triggering webhook queue:", error);
    }
  }

  /**
   * Process raw message from protocol interceptor with smart content detection
   */
  async processRawMessage(
    accountId: string,
    messageData: any,
    recipientPhone: string,
  ): Promise<void> {
    try {
      // Skip if no message ID
      if (!messageData.id || !messageData.from) {
        return;
      }

      // Skip status broadcasts
      if (messageData.from?.includes("status@broadcast")) {
        return;
      }

      // Create message identifier for deduplication
      const fromNumber =
        phoneNumberService.clean(messageData.from || "") || "unknown";
      const toNumber =
        phoneNumberService.clean(messageData.recipient || recipientPhone) ||
        phoneNumberService.clean(recipientPhone);

      // Smart content reconstruction
      let messageContent = "📱 Message received";
      if (messageData.body) {
        messageContent = messageData.body;
      } else if (messageData.text) {
        messageContent = messageData.text;
      } else if (messageData.caption) {
        messageContent = messageData.caption;
      } else if (messageData.notify) {
        messageContent = `[CONTENT_NEEDED] Real message from ${messageData.notify} - Use /api/update-message to set actual content`;
      } else {
        messageContent = `[CONTENT_NEEDED] Real ${messageData.type || "text"} message from ${fromNumber} - Use /api/update-message to set actual content`;
      }

      const messageIdentifier = {
        messageId: messageData.id,
        from: fromNumber,
        to: toNumber,
        content: messageContent,
        timestamp: (messageData.t || Math.floor(Date.now() / 1000)) * 1000,
      };

      // Check deduplication
      if (!messageDeduplicator.markAsProcessing(messageIdentifier)) {
        whatsappLogger.debug("Raw message skipped due to deduplication", {
          messageId: messageData.id,
          from: fromNumber,
          to: toNumber,
          contentPreview: messageContent.substring(0, 50),
        });
        return;
      }

      // Skip if already processed by old system (fallback)
      if (this.processedMessageIds.has(messageData.id)) {
        messageDeduplicator.removeMessage(messageIdentifier);
        return;
      }

      const timestamp = messageData.t || Math.floor(Date.now() / 1000);

      const processedMessage: ProcessedMessage = {
        id: `${accountId}_msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId: accountId,
        from: messageIdentifier.from,
        to: messageIdentifier.to,
        message: messageIdentifier.content,
        timestamp: timestamp.toString(),
        type: messageData.type || "text",
        direction: "inbound",
        messageId: messageData.id,
        rawData: JSON.stringify(messageData),
      };

      whatsappLogger.info("Processing enhanced raw message:", {
        messageId: processedMessage.messageId,
        from: processedMessage.from,
        to: processedMessage.to,
        content: messageIdentifier.content.substring(0, 100),
        type: messageData.type,
        notify: messageData.notify,
        originalFrom: messageData.from,
        originalRecipient: messageData.recipient,
      });

      // Save to database
      await this.saveToDatabase(processedMessage);

      // Mark as processed in both systems
      this.processedMessageIds.set(messageData.id, true);
      messageDeduplicator.markAsCompleted(messageIdentifier, false);

      // Add to webhook queue
      await webhookQueue.addToQueue(
        processedMessage.messageId,
        processedMessage.id,
        processedMessage.from,
        processedMessage.to,
        processedMessage.message,
        processedMessage.timestamp,
        processedMessage.type,
        2, // higher priority for raw messages
      );
    } catch (error) {
      whatsappLogger.error("Error processing raw message:", error);

      // Clean up deduplicator on error
      if (messageData.id) {
        const fromNumber =
          phoneNumberService.clean(messageData.from || "") || "unknown";
        const toNumber =
          phoneNumberService.clean(messageData.recipient || recipientPhone) ||
          phoneNumberService.clean(recipientPhone);
        messageDeduplicator.removeMessage({
          messageId: messageData.id,
          from: fromNumber,
          to: toNumber,
          content: "failed",
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Manual message insertion for testing with realistic data
   */
  async insertTestMessage(
    from: string,
    to: string,
    message: string,
    accountId: string = "account_2",
  ): Promise<string> {
    try {
      const processedMessage: ProcessedMessage = {
        id: `${accountId}_msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId: accountId,
        from: from,
        to: to,
        message: message,
        timestamp: Math.floor(Date.now() / 1000).toString(),
        type: "text",
        direction: "inbound",
        messageId: `test_msg_${Date.now()}`,
        rawData: JSON.stringify({
          test: true,
          from,
          to,
          message,
          timestamp: Math.floor(Date.now() / 1000),
          source: "api_test",
        }),
      };

      await this.saveToDatabase(processedMessage);

      // Add test message to webhook queue
      await webhookQueue.addToQueue(
        processedMessage.messageId,
        processedMessage.id,
        processedMessage.from,
        processedMessage.to,
        processedMessage.message,
        processedMessage.timestamp,
        processedMessage.type,
        3, // highest priority for test messages
      );

      whatsappLogger.info("Test message inserted:", {
        messageId: processedMessage.messageId,
        dbId: processedMessage.id,
        content: message.substring(0, 50),
      });

      return processedMessage.id;
    } catch (error) {
      whatsappLogger.error("Error inserting test message:", error);
      throw error;
    }
  }

  /**
   * Update message content for protocol captures
   */
  async updateMessageContent(
    messageId: string,
    newContent: string,
  ): Promise<boolean> {
    try {
      const updated = await databaseManager
        .getDatabase()
        .run("UPDATE messages SET message = ? WHERE message_id = ?", [
          newContent,
          messageId,
        ]);

      whatsappLogger.info("Message content updated:", {
        messageId: messageId,
        newContent: newContent.substring(0, 50),
        rowsAffected: updated.changes,
      });

      return (updated.changes || 0) > 0;
    } catch (error) {
      whatsappLogger.error("Error updating message content:", error);
      throw error;
    }
  }

  /**
   * Get processing statistics
   */
  getStats(): {
    processedCount: number;
    deduplication: {
      totalProcessed: number;
      currentlyProcessing: number;
      webhooksSent: number;
      cacheSize: number;
      contentHashesSize: number;
    };
    webhookQueue: {
      queueSize: number;
      isProcessing: boolean;
      oldestEntry: number | null;
      newestEntry: number | null;
      priorityDistribution: Record<number, number>;
    };
  } {
    return {
      processedCount: this.processedMessageIds.size,
      deduplication: messageDeduplicator.getStats(),
      webhookQueue: webhookQueue.getStats(),
    };
  }

  /**
   * Clear processed message cache
   */
  /**
   * Unified message interception (replaces message-interceptor functionality)
   * Handles log messages from protocol data
   */
  async processLogMessage(messageData: any): Promise<void> {
    try {
      if (!messageData?.recv?.attrs?.id) return;

      const attrs = messageData.recv.attrs;
      if (this.processedMessageIds.has(attrs.id)) return;

      // Extract account info and phone numbers
      const accountInfo = this.extractAccountFromLogMessage(attrs);
      if (!accountInfo) return;

      this.processedMessageIds.set(attrs.id, true);

      const direction = accountInfo.isIncoming ? "inbound" : "outbound";
      const messageFrom = accountInfo.isIncoming
        ? phoneNumberService.normalize(attrs.from.split("@")[0])
        : accountInfo.accountPhone;
      const messageTo = accountInfo.isIncoming
        ? accountInfo.accountPhone
        : phoneNumberService.normalize(
            attrs.recipient?.split("@")[0] || "unknown",
          );

      whatsappLogger.info(
        `[${accountInfo.accountId}] Processing intercepted message: ${attrs.id}`,
        {
          direction,
          from: messageFrom,
          to: messageTo,
        },
      );

      await this.saveInterceptedMessage(
        accountInfo.accountId,
        attrs,
        direction,
        messageFrom,
        messageTo,
      );
    } catch (error) {
      whatsappLogger.error("Error processing log message:", error);
    }
  }

  /**
   * Extract account information from log message attributes
   */
  private extractAccountFromLogMessage(attrs: any): {
    accountId: string;
    accountPhone: string;
    isIncoming: boolean;
  } | null {
    // This would need to be connected to account management
    // For now, return null to indicate no matching account
    // In real implementation, this would check against registered accounts
    return null;
  }

  /**
   * Save intercepted message to database with webhook trigger
   */
  private async saveInterceptedMessage(
    accountId: string,
    attrs: any,
    direction: string,
    messageFrom: string,
    messageTo: string,
  ): Promise<void> {
    try {
      const messageData = {
        id: this.generateMessageId(accountId),
        account_id: accountId,
        from: messageFrom,
        to: messageTo,
        message: `Message from ${attrs.notify || "Unknown"} (ID: ${attrs.id})`,
        timestamp: new Date().toISOString(),
        type: "text" as const,
        direction: direction as any,
        message_id: attrs.id,
        raw_data: JSON.stringify(attrs),
        webhook_sent: false,
        webhook_attempts: 0,
      };

      await databaseManager.saveMessage(messageData);
      whatsappLogger.info(
        `[${accountId}] Intercepted message saved to database`,
      );

      // Trigger webhook with delay
      setTimeout(async () => {
        const pendingMessages =
          await databaseManager.getPendingWebhookMessages();
        if (pendingMessages.length > 0) {
          const results = await webhookService.sendBatch(pendingMessages);
          for (const result of results.results) {
            await databaseManager.updateMessageWebhookStatus(
              result.messageId,
              result.success,
              result.attempts,
            );
          }
          whatsappLogger.info(
            `[${accountId}] Webhooks sent: ${results.successful}/${results.failed}`,
          );
        }
      }, 100);
    } catch (error) {
      whatsappLogger.error("Error saving intercepted message:", error);
    }
  }

  /**
   * Generate unique message ID
   */
  private generateMessageId(accountId?: string): string {
    const prefix = accountId ? `${accountId}_` : "";
    return `${prefix}msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  clearCache(): void {
    this.processedMessageIds.clear();
    this.contentCache.clear();
    messageDeduplicator.clearAll();
    whatsappLogger.info("MessageProcessor caches cleared");
  }
}

// Export singleton instance
export const messageProcessor = new MessageProcessor();
