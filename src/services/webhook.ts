import axios, { AxiosResponse, AxiosError } from "axios";
import { Message } from "../models/database";
import { webhookLogger, logWebhookAttempt } from "../utils/logger";

export interface WebhookPayload {
  from: string;
  to: string;
  message: string;
  timestamp: string;
  type: string;
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
    const payload: WebhookPayload = {
      from: message.from,
      to: message.to,
      message: message.message,
      timestamp: message.timestamp,
      type: message.type,
    };

    // Log the message being processed
    webhookLogger.info("📤 Preparing webhook message:", {
      messageId: message.id,
      accountId: message.account_id,
      messageDirection: message.direction,
      messageType: message.type,
      originalMessage: {
        id: message.id,
        from: message.from,
        to: message.to,
        message: message.message,
        timestamp: message.timestamp,
        type: message.type,
        direction: message.direction,
        webhook_sent: message.webhook_sent,
        webhook_attempts: message.webhook_attempts
      },
      webhookPayload: payload,
      webhookPayloadJSON: JSON.stringify(payload, null, 2)
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
          accountId: message.account_id,
          statusCode: response.status,
          responseTime: response.headers["x-response-time"],
        });

        return { success: true, attempts };
      } catch (error) {
        const errorMessage = this.extractErrorMessage(error);
        lastError = errorMessage;

        logWebhookAttempt(message.id, this.config.url, false, error);
        webhookLogger.warn(`Webhook attempt ${attempts} failed`, {
          messageId: message.id,
          accountId: message.account_id,
          error: errorMessage,
          willRetry: attempts < this.config.maxRetries,
        });

        // Don't retry on certain HTTP status codes
        if (this.shouldNotRetry(error)) {
          webhookLogger.error(`Webhook failed with non-retryable error`, {
            messageId: message.id,
            error: errorMessage,
          });
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
      accountId: message.account_id,
      finalError: lastError,
    });

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
    webhookLogger.info(
      `Processing webhook batch of ${messages.length} messages`,
    );

    const results = await Promise.all(
      messages.map(async (message) => {
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
      successful,
      failed,
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

    // Log detailed request information
    webhookLogger.info("🚀 Webhook Request Details:", {
      requestId,
      url: this.config.url,
      method: "POST",
      timeout: this.config.timeout,
      payload: payload,
      payloadJSON: JSON.stringify(payload, null, 2),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "WhatsApp-Server/1.0.0",
        "X-Request-ID": requestId,
      }
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
      webhookLogger.info("✅ Webhook Response Success:", {
        requestId,
        statusCode: response.status,
        statusText: response.statusText,
        responseHeaders: response.headers,
        responseData: response.data,
        responseSize: JSON.stringify(response.data).length
      });

      return response;
    } catch (error) {
      // Log detailed error information
      if (axios.isAxiosError(error)) {
        webhookLogger.error("❌ Webhook Request Failed:", {
          requestId,
          url: this.config.url,
          payload: payload,
          payloadJSON: JSON.stringify(payload, null, 2),
          errorType: "AxiosError",
          errorMessage: error.message,
          errorCode: error.code,
          responseStatus: error.response?.status,
          responseStatusText: error.response?.statusText,
          responseData: error.response?.data,
          responseHeaders: error.response?.headers,
          requestConfig: {
            timeout: error.config?.timeout,
            headers: error.config?.headers,
            url: error.config?.url,
            method: error.config?.method
          }
        });
      } else {
        webhookLogger.error("❌ Webhook Request Failed (Non-Axios):", {
          requestId,
          url: this.config.url,
          payload: payload,
          payloadJSON: JSON.stringify(payload, null, 2),
          error: error
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
  } {
    return {
      url: this.config.url,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      retryDelay: this.config.retryDelay,
    };
  }
}

// Export singleton instance
export const webhookService = new WebhookService();
