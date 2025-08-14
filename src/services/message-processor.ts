import { WAMessage, WASocket } from "baileys";
import { databaseManager } from "../models/database";
import { webhookService } from "./webhook";
import { whatsappLogger } from "../utils/logger";
import { messageContentExtractor } from "./message-content-extractor";
import { cleanPhoneNumber } from "../utils/phone-utils";

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
  private processedMessageIds: Set<string> = new Set();

  /**
   * Process incoming WhatsApp message directly
   */
  async processIncomingMessage(
    accountId: string,
    message: WAMessage,
    recipientPhone: string
  ): Promise<void> {
    try {
      if (!message.key.id) {
        whatsappLogger.warn("Message has no ID, skipping");
        return;
      }

      // Skip if already processed
      if (this.processedMessageIds.has(message.key.id)) {
        whatsappLogger.debug(`Message ${message.key.id} already processed`);
        return;
      }

      // Skip status broadcasts
      if (message.key.remoteJid?.includes("status@broadcast")) {
        whatsappLogger.debug("Skipping status broadcast");
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

      // Extract message content - prioritas pada konten asli
      let actualContent = null;

      // Pertama coba ambil dari message object langsung (yang sudah didekripsi)
      if (message.message?.conversation) {
        actualContent = message.message.conversation;
        whatsappLogger.info("Found conversation content in message:", {
          messageId: message.key.id,
          content: actualContent.substring(0, 100),
          source: "direct_conversation"
        });
      } else if (message.message?.extendedTextMessage?.text) {
        actualContent = message.message.extendedTextMessage.text;
        whatsappLogger.info("Found extended text content in message:", {
          messageId: message.key.id,
          content: actualContent.substring(0, 100),
          source: "direct_extended_text"
        });
      }

      // Jika tidak ada, coba dari content extractor
      if (!actualContent) {
        actualContent = messageContentExtractor.getMessageContent(message.key.id);
        if (actualContent) {
          whatsappLogger.info("Using extracted content from extractor:", {
            messageId: message.key.id,
            content: actualContent.substring(0, 100),
            source: "content_extractor"
          });
        }
      }

      let extractedData;
      if (actualContent) {
        // Gunakan konten asli yang sudah ditemukan
        extractedData = {
          content: actualContent,
          type: "text"
        };
      } else {
        // Fallback ke metode ekstraksi normal
        extractedData = this.extractMessageContent(message);
        whatsappLogger.debug("Using fallback content extraction:", {
          messageId: message.key.id,
          content: extractedData.content.substring(0, 100),
          source: "fallback_extraction"
        });
      }

      // Create processed message with correct from/to logic
      const fromNumber = message.key.fromMe
        ? cleanPhoneNumber(recipientPhone) // If it's from me, I am the sender
        : cleanPhoneNumber(message.key.remoteJid || "") || "unknown"; // If it's to me, they are the sender

      const toNumber = message.key.fromMe
        ? cleanPhoneNumber(message.key.remoteJid || "") || "unknown" // If it's from me, they are the recipient
        : cleanPhoneNumber(recipientPhone); // If it's to me, I am the recipient

      const processedMessage: ProcessedMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId: accountId,
        from: fromNumber,
        to: toNumber,
        message: extractedData.content,
        timestamp: (message.messageTimestamp || Math.floor(Date.now() / 1000)).toString(),
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

      // Mark as processed
      this.processedMessageIds.add(message.key.id);

      // Trigger webhook
      await this.triggerWebhook();

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

      // Don't throw error to prevent breaking other message processing
    }
  }

  /**
   * Extract content from WAMessage with smart reconstruction
   */
  private extractMessageContent(message: WAMessage): { content: string; type: string } {
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
        type: "image"
      };
    }

    // Video message
    if (msg.videoMessage) {
      return {
        content: msg.videoMessage.caption || "🎥 Video",
        type: "video"
      };
    }

    // Audio message
    if (msg.audioMessage) {
      return { content: "🎵 Audio message", type: "audio" };
    }

    // Document message
    if (msg.documentMessage) {
      return {
        content: msg.documentMessage.title || msg.documentMessage.fileName || "📄 Document",
        type: "document"
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
      return { content: msg.templateMessage.hydratedTemplate.hydratedContentText, type: "template" };
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
   * Save message to database
   */
  private async saveToDatabase(processedMessage: ProcessedMessage): Promise<void> {
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
   * Trigger webhook processing
   */
  private async triggerWebhook(): Promise<void> {
    try {
      setTimeout(async () => {
        const pendingMessages = await databaseManager.getPendingWebhookMessages();
        if (pendingMessages.length > 0) {
          const results = await webhookService.sendBatch(pendingMessages);

          // Update webhook status
          for (const result of results.results) {
            await databaseManager.updateMessageWebhookStatus(
              result.messageId,
              result.success,
              result.attempts
            );
          }

          whatsappLogger.info("Webhook processing completed:", {
            total: results.results.length,
            successful: results.successful,
            failed: results.failed,
          });
        }
      }, 100);
    } catch (error) {
      whatsappLogger.error("Error triggering webhook:", error);
    }
  }

  /**
   * Process raw message from protocol interceptor with smart content detection
   */
  async processRawMessage(
    accountId: string,
    messageData: any,
    recipientPhone: string
  ): Promise<void> {
    try {
      // Skip if no message ID
      if (!messageData.id || !messageData.from) {
        return;
      }

      // Skip if already processed
      if (this.processedMessageIds.has(messageData.id)) {
        return;
      }

      // Skip status broadcasts
      if (messageData.from?.includes("status@broadcast")) {
        return;
      }

      // Fix from/to mapping for protocol messages
      const fromNumber = cleanPhoneNumber(messageData.from || "") || "unknown";
      const toNumber = cleanPhoneNumber(messageData.recipient || recipientPhone) || cleanPhoneNumber(recipientPhone);
      const timestamp = messageData.t || Math.floor(Date.now() / 1000);
      const timeStr = new Date(timestamp * 1000).toLocaleTimeString();

      // Smart content reconstruction - try to get actual message content
      let messageContent = "📱 Message received";

      // Try to extract any available text content
      if (messageData.body) {
        messageContent = messageData.body;
      } else if (messageData.text) {
        messageContent = messageData.text;
      } else if (messageData.caption) {
        messageContent = messageData.caption;
      } else if (messageData.notify) {
        // Create smart placeholder that indicates manual update needed
        messageContent = `[CONTENT_NEEDED] Real message from ${messageData.notify} - Use /api/update-message to set actual content`;
      } else {
        messageContent = `[CONTENT_NEEDED] Real ${messageData.type || 'text'} message from ${fromNumber} - Use /api/update-message to set actual content`;
      }

      const processedMessage: ProcessedMessage = {
        id: `raw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        accountId: accountId,
        from: fromNumber,
        to: toNumber,
        message: messageContent,
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
        content: messageContent.substring(0, 100),
        type: messageData.type,
        notify: messageData.notify,
        originalFrom: messageData.from,
        originalRecipient: messageData.recipient,
      });

      // Save to database
      await this.saveToDatabase(processedMessage);

      // Mark as processed
      this.processedMessageIds.add(messageData.id);

      // Trigger webhook
      await this.triggerWebhook();

    } catch (error) {
      whatsappLogger.error("Error processing raw message:", error);
    }
  }

  /**
   * Manual message insertion for testing with realistic data
   */
  async insertTestMessage(
    from: string,
    to: string,
    message: string,
    accountId: string = "account_2"
  ): Promise<string> {
    try {
      const processedMessage: ProcessedMessage = {
        id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
          source: "api_test"
        }),
      };

      await this.saveToDatabase(processedMessage);
      await this.triggerWebhook();

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
  async updateMessageContent(messageId: string, newContent: string): Promise<boolean> {
    try {
      const updated = await databaseManager.getDatabase().run(
        "UPDATE messages SET message = ? WHERE message_id = ?",
        [newContent, messageId]
      );

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
  getStats(): { processedCount: number } {
    return {
      processedCount: this.processedMessageIds.size,
    };
  }

  /**
   * Clear processed message cache
   */
  clearCache(): void {
    this.processedMessageIds.clear();
    whatsappLogger.info("Message processor cache cleared");
  }
}

// Export singleton instance
export const messageProcessor = new MessageProcessor();
