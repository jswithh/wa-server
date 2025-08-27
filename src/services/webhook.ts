import axios, { AxiosResponse, AxiosError } from "axios";
import { Message } from "../models/database";
import { webhookLogger, logWebhookAttempt } from "../utils/logger";
import { messageDeduplicator } from "./message-deduplicator";

export interface WebhookPayload {
  from: string;
  to: string;
  message: string;
  timestamp: string;
  type: string;
  messageId: string;
}

export interface WebhookConfig {
  url: string;
  timeout: number;
  maxRetries: number;
  retryDelay: number;
  retryMultiplier: number;
}

export class WebhookService {
  private config: WebhookConfig;

  constructor(config: Partial<WebhookConfig> = {}) {
    this.config = {
      url:
        config.url ||
        process.env.WEBHOOK_URL ||
        "http://localhost:10022/hra_whatsapp/sub_channel/webhook",
      timeout: config.timeout || 10000,
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
      retryMultiplier: config.retryMultiplier || 2,
    };

    webhookLogger.info("Webhook service initialized", {
      url: this.config.url,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
    });
  }

  /**
   * Send message to webhook with retry mechanism
   */
  async sendMessage(
    message: Message,
  ): Promise<{ success: boolean; attempts: number; error?: string }> {
    // Check for duplicates before processing
    const messageIdentifier = {
      messageId: message.message_id,
      from: message.from,
      to: message.to,
      content: message.message,
      timestamp: parseInt(message.timestamp) * 1000,
    };

    // Check if webhook already sent for this message
    if (messageDeduplicator.isWebhookSent(messageIdentifier)) {
      webhookLogger.info("Webhook already sent for message, skipping:", {
        messageId: message.message_id,
        from: message.from,
        to: message.to,
      });
      return { success: true, attempts: 0 };
    }

    const payload: WebhookPayload = {
      from: message.from,
      to: message.to,
      message: message.message,
      timestamp: message.timestamp,
      type: message.type,
      messageId: message.id,
    };

    // Log the message being processed
    webhookLogger.info("Preparing webhook message:", {
      messageId: message.id,
      accountId: message.account_id,
      from: message.from,
      to: message.to,
      type: message.type,
    });

    let attempts = 0;
    let lastError: string | undefined;

    while (attempts < this.config.maxRetries) {
      attempts++;

      try {
        const response = await this.makeRequest(payload);

        logWebhookAttempt(message.id, this.config.url, true);
        webhookLogger.info(`Webhook successful on attempt ${attempts}`, {
          messageId: message.id,
          statusCode: response.status,
        });

        // Mark webhook as sent in deduplicator
        messageDeduplicator.markWebhookSent(messageIdentifier, attempts);

        return { success: true, attempts };
      } catch (error) {
        const errorMessage = this.extractErrorMessage(error);
        lastError = errorMessage;

        logWebhookAttempt(message.id, this.config.url, false, error);
        webhookLogger.warn(`Webhook attempt ${attempts} failed`, {
          messageId: message.id,
          error: errorMessage,
          willRetry: attempts < this.config.maxRetries,
        });

        // Don't retry on certain HTTP status codes
        if (this.shouldNotRetry(error)) {
          break;
        }

        // Wait before retry with exponential backoff
        if (attempts < this.config.maxRetries) {
          const delay = this.calculateRetryDelay(attempts);
          await this.sleep(delay);
        }
      }
    }

    webhookLogger.error(`Webhook failed after ${attempts} attempts`, {
      messageId: message.id,
      finalError: lastError,
    });

    // Don't mark as sent if failed, but track the attempts
    messageDeduplicator.markAsCompleted(messageIdentifier, false);

    return { success: false, attempts, error: lastError || "Unknown error" };
  }

  /**
   * Send batch of messages to webhook
   */
  async sendBatch(messages: Message[]): Promise<{
    successful: number;
    failed: number;
    results: Array<{
      messageId: string;
      success: boolean;
      attempts: number;
      error?: string;
    }>;
  }> {
    // Filter out messages that already have webhooks sent
    const filteredMessages = messages.filter((message) => {
      const messageIdentifier = {
        messageId: message.message_id,
        from: message.from,
        to: message.to,
        content: message.message,
        timestamp: parseInt(message.timestamp) * 1000,
      };

      return !messageDeduplicator.isWebhookSent(messageIdentifier);
    });

    webhookLogger.info(
      `Processing webhook batch: ${filteredMessages.length}/${messages.length} messages (${messages.length - filteredMessages.length} already sent)`,
    );

    if (filteredMessages.length === 0) {
      return {
        successful: 0,
        failed: 0,
        results: [],
      };
    }

    const results = await Promise.all(
      filteredMessages.map(async (message) => {
        const result = await this.sendMessage(message);
        return {
          messageId: message.id,
          ...result,
        };
      }),
    );

    const successful = results.filter((r) => r.success).length;
    const failed = results.length - successful;

    webhookLogger.info(`Webhook batch completed`, {
      total: messages.length,
      processed: filteredMessages.length,
      successful,
      failed,
      skipped: messages.length - filteredMessages.length,
    });

    return { successful, failed, results };
  }

  /**
   * Test webhook connectivity
   */
  async testConnection(): Promise<{
    success: boolean;
    responseTime?: number;
    error?: string;
  }> {
    const testPayload: WebhookPayload = {
      from: "6281234567890",
      to: "6289876543210",
      message: "Test connection from WhatsApp Server",
      timestamp: Math.floor(Date.now() / 1000).toString(),
      type: "text",
      messageId: "test_db_" + Date.now(),
    };

    const startTime = Date.now();

    try {
      const response = await this.makeRequest(testPayload);
      const responseTime = Date.now() - startTime;

      webhookLogger.info("Webhook test successful", {
        url: this.config.url,
        statusCode: response.status,
        responseTime,
      });

      return { success: true, responseTime };
    } catch (error) {
      const errorMessage = this.extractErrorMessage(error);

      webhookLogger.error("Webhook test failed", {
        url: this.config.url,
        error: errorMessage,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Update webhook configuration
   */
  updateConfig(newConfig: Partial<WebhookConfig>): void {
    this.config = { ...this.config, ...newConfig };

    webhookLogger.info("Webhook configuration updated", {
      newConfig: this.config,
    });
  }

  /**
   * Get current webhook configuration
   */
  getConfig(): WebhookConfig {
    return { ...this.config };
  }

  /**
   * Make HTTP request to webhook endpoint
   */
  private async makeRequest(payload: WebhookPayload): Promise<AxiosResponse> {
    const requestId = this.generateRequestId();

    // Log request information
    webhookLogger.debug("Webhook request:", {
      requestId,
      url: this.config.url,
      from: payload.from,
      to: payload.to,
      type: payload.type,
    });

    try {
      const response = await axios.post(this.config.url, payload, {
        timeout: this.config.timeout,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "WhatsApp-Server/1.0.0",
          "X-Request-ID": requestId,
        },
        validateStatus: (status) => status >= 200 && status < 300,
      });

      // Log successful response
      webhookLogger.debug("Webhook response success:", {
        requestId,
        statusCode: response.status,
      });

      return response;
    } catch (error) {
      // Log error information
      if (axios.isAxiosError(error)) {
        webhookLogger.error("Webhook request failed:", {
          requestId,
          url: this.config.url,
          errorMessage: error.message,
          responseStatus: error.response?.status,
          responseData: error.response?.data,
        });
      } else {
        webhookLogger.error("Webhook request failed:", {
          requestId,
          url: this.config.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * Extract error message from axios error
   */
  private extractErrorMessage(error: any): string {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      if (axiosError.response) {
        // Server responded with error status
        return `HTTP ${axiosError.response.status}: ${axiosError.response.statusText}`;
      } else if (axiosError.request) {
        // Request was made but no response received
        return `No response received: ${axiosError.code || "NETWORK_ERROR"}`;
      } else {
        // Something else happened
        return axiosError.message;
      }
    }

    return error?.message || "Unknown error";
  }

  /**
   * Determine if error should not be retried
   */
  private shouldNotRetry(error: any): boolean {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      if (axiosError.response) {
        const status = axiosError.response.status;
        // Don't retry on client errors (4xx) except for rate limiting
        return status >= 400 && status < 500 && status !== 429;
      }
    }

    return false;
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(attempt: number): number {
    const delay =
      this.config.retryDelay *
      Math.pow(this.config.retryMultiplier, attempt - 1);
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.1 * delay;
    return Math.min(delay + jitter, 30000); // Cap at 30 seconds
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return (
      "req_" + Date.now() + "_" + Math.random().toString(36).substring(2, 15)
    );
  }

  /**
   * Get webhook statistics
   */
  getStats(): {
    url: string;
    timeout: number;
    maxRetries: number;
    retryDelay: number;
    deduplication: {
      totalProcessed: number;
      currentlyProcessing: number;
      webhooksSent: number;
      cacheSize: number;
      contentHashesSize: number;
    };
  } {
    return {
      url: this.config.url,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      retryDelay: this.config.retryDelay,
      deduplication: messageDeduplicator.getStats(),
    };
  }
}

// Export singleton instance
export const webhookService = new WebhookService();
