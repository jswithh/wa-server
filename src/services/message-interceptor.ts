import { whatsappLogger } from "../utils/logger";
import { databaseManager } from "../models/database";
import { webhookService } from "./webhook";
import { generateMessageId, getCurrentTimestamp, normalizePhoneNumber } from "../utils/validation";

class MessageInterceptor {
  private processedMessages = new Set<string>();
  private accountPhoneNumbers = new Map<string, string>();

  registerAccount(accountId: string, phoneNumber: string): void {
    this.accountPhoneNumbers.set(accountId, phoneNumber);
    whatsappLogger.info(`Registered account ${accountId} with phone ${phoneNumber}`);
  }

  async processLogMessage(messageData: any): Promise<void> {
    console.error("INTERCEPTOR CALLED:", messageData ? "has data" : "no data");
    try {
      if (!messageData?.recv?.attrs?.id) return;
      const attrs = messageData.recv.attrs;
      if (this.processedMessages.has(attrs.id)) return;

      let targetAccountId: string | null = null;
      for (const [accountId, phoneNumber] of this.accountPhoneNumbers.entries()) {
        // Check if this message is for this account (incoming) or from this account (outgoing)
        if ((attrs.recipient && attrs.recipient.includes(phoneNumber)) || 
            (attrs.from && attrs.from.includes(phoneNumber))) {
          targetAccountId = accountId;
          break;
        }
      }
      if (!targetAccountId) return;
      this.processedMessages.add(attrs.id);
      const fromNumber = attrs.from.split("@")[0];
      const accountPhone = this.accountPhoneNumbers.get(targetAccountId);
      const isIncoming = fromNumber !== accountPhone;
      // Process both incoming and outgoing messages
      const direction = isIncoming ? "inbound" : "outbound";
      const messageFrom = isIncoming ? normalizePhoneNumber(attrs.from.split("@")[0]) : this.accountPhoneNumbers.get(targetAccountId) || "unknown";
      const messageTo = isIncoming ? this.accountPhoneNumbers.get(targetAccountId) || "unknown" : normalizePhoneNumber(attrs.recipient?.split("@")[0] || "unknown");
      whatsappLogger.error(`[${targetAccountId}] INTERCEPTED MESSAGE: ${attrs.id}`);
      await this.saveMessage(targetAccountId, attrs, direction, messageFrom, messageTo);
    } catch (error) {
      whatsappLogger.error("Error processing log message:", error);
    }
  }

  private async saveMessage(accountId: string, attrs: any, direction: string, messageFrom: string, messageTo: string): Promise<void> {
    try {
      const messageData = {
        id: generateMessageId(),
        account_id: accountId,
        from: messageFrom,
        to: messageTo,
        message: `Message from ${attrs.notify || "Unknown"} (ID: ${attrs.id})`,
        timestamp: getCurrentTimestamp(),
        type: "text" as const,
        direction: direction as any,
        message_id: attrs.id,
        raw_data: JSON.stringify(attrs),
        webhook_sent: false,
        webhook_attempts: 0,
      };
      await databaseManager.saveMessage(messageData);
      whatsappLogger.error(`[${accountId}] MESSAGE SAVED TO DATABASE!`);
      setTimeout(async () => {
        const pendingMessages = await databaseManager.getPendingWebhookMessages();
        if (pendingMessages.length > 0) {
          const results = await webhookService.sendBatch(pendingMessages);
          for (const result of results.results) {
            await databaseManager.updateMessageWebhookStatus(result.messageId, result.success, result.attempts);
          }
          whatsappLogger.error(`[${accountId}] WEBHOOK SENT: ${results.successful}/${results.failed}`);
        }
      }, 100);
    } catch (error) {
      whatsappLogger.error("Error saving message:", error);
    }
  }
}

export const messageInterceptor = new MessageInterceptor();
