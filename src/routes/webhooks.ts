import express, { Request, Response } from "express";
import { appConfig } from "../config";
import { logger } from "../utils/logger";
import { ResponseService } from "../utils/response-service";
import { asyncHandler, ErrorFactory } from "../middleware/error-handling";
import { getRequestId } from "../middleware/request-logging";

const router = express.Router();

/**
 * POST /api/webhooks/send
 * Send a manual webhook with custom payload for testing
 */
router.post(
  "/send",
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req);
    const { from, to, message, timestamp, type, ...additionalData } = req.body;

    // Validate required fields
    if (!from || !to || !message) {
      throw ErrorFactory.validation(
        "Missing required fields: from, to, message",
        {
          requiredFields: ["from", "to", "message"],
          provided: Object.keys(req.body),
        },
      );
    }

    // Validate message content
    if (typeof message !== "string" || message.trim().length === 0) {
      throw ErrorFactory.validation(
        "Message content must be a non-empty string",
      );
    }

    // Prepare webhook payload
    const webhookPayload = {
      from: from.toString(),
      to: to.toString(),
      message: message.trim(),
      timestamp: timestamp || Math.floor(Date.now() / 1000).toString(),
      type: type || "text",
      messageId: "manual_db_" + Date.now(),
      ...additionalData,
    };

    try {
      logger.info("Sending manual webhook", {
        requestId,
        webhookUrl: appConfig.webhook.url,
        payloadPreview: {
          from: webhookPayload.from,
          to: webhookPayload.to,
          messagePreview: webhookPayload.message.substring(0, 50),
          type: webhookPayload.type,
        },
      });

      // Send webhook request
      const response = await fetch(appConfig.webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "WhatsApp-Server/1.0.0",
          "X-Request-ID": requestId || "manual-webhook",
        },
        body: JSON.stringify(webhookPayload),
        signal: AbortSignal.timeout(appConfig.webhook.timeout),
      });

      let responseData: any = null;
      let responseText = "";

      // Try to parse response
      try {
        responseText = await response.text();
        if (responseText) {
          responseData = JSON.parse(responseText);
        }
      } catch (parseError) {
        // If JSON parsing fails, keep the raw text
        responseData = { rawResponse: responseText };
      }

      const webhookResult = {
        success: response.ok,
        statusCode: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data: responseData,
        sentAt: new Date().toISOString(),
      };

      logger.info("Manual webhook response received", {
        requestId,
        success: response.ok,
        statusCode: response.status,
        responseDataPreview: responseData
          ? JSON.stringify(responseData).substring(0, 200)
          : null,
      });

      if (response.ok) {
        ResponseService.success(
          res,
          {
            payload: webhookPayload,
            webhook: webhookResult,
          },
          "Webhook sent successfully",
          requestId ? { requestId } : {},
        );
      } else {
        ResponseService.error(
          res,
          `Webhook failed with status ${response.status}`,
          "WEBHOOK_ERROR",
          requestId ? { requestId } : {},
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error("Failed to send manual webhook", {
        requestId,
        webhookUrl: appConfig.webhook.url,
        error: errorMessage,
        payload: webhookPayload,
      });

      // Check for common network errors
      if (error instanceof TypeError && error.message.includes("fetch")) {
        throw ErrorFactory.webhook("Failed to connect to webhook endpoint", {
          webhookUrl: appConfig.webhook.url,
          originalError: errorMessage,
          payload: webhookPayload,
        });
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw ErrorFactory.webhook("Webhook request timed out", {
          timeout: appConfig.webhook.timeout,
          webhookUrl: appConfig.webhook.url,
          payload: webhookPayload,
        });
      }

      throw ErrorFactory.webhook("Failed to send webhook", {
        originalError: errorMessage,
        webhookUrl: appConfig.webhook.url,
        payload: webhookPayload,
      });
    }
  }),
);

/**
 * POST /api/webhooks/test
 * Test webhook connectivity with a simple ping message
 */
router.post(
  "/test",
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req);

    const testPayload = {
      from: "test_sender",
      to: "test_receiver",
      message: "Test webhook connectivity",
      timestamp: Math.floor(Date.now() / 1000).toString(),
      type: "test",
      isTest: true,
      testId: requestId || `test_${Date.now()}`,
    };

    try {
      logger.info("Testing webhook connectivity", {
        requestId,
        webhookUrl: appConfig.webhook.url,
        timeout: appConfig.webhook.timeout,
      });

      const startTime = Date.now();

      const response = await fetch(appConfig.webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "WhatsApp-Server/1.0.0",
          "X-Request-ID": requestId || "webhook-test",
        },
        body: JSON.stringify(testPayload),
        signal: AbortSignal.timeout(appConfig.webhook.timeout),
      });

      const responseTime = Date.now() - startTime;

      let responseData: any = null;
      try {
        const responseText = await response.text();
        if (responseText) {
          responseData = JSON.parse(responseText);
        }
      } catch (parseError) {
        // Response is not JSON, that's okay for a test
      }

      const testResult = {
        success: response.ok,
        statusCode: response.status,
        statusText: response.statusText,
        responseTime: `${responseTime}ms`,
        headers: Object.fromEntries(response.headers.entries()),
        data: responseData,
        webhookUrl: appConfig.webhook.url,
        testedAt: new Date().toISOString(),
      };

      logger.info("Webhook test completed", {
        requestId,
        success: response.ok,
        statusCode: response.status,
        responseTime,
      });

      if (response.ok) {
        ResponseService.success(
          res,
          testResult,
          "Webhook test successful",
          requestId ? { requestId } : {},
        );
      } else {
        ResponseService.error(
          res,
          `Webhook test failed with status ${response.status}`,
          "WEBHOOK_ERROR",
          requestId ? { requestId } : {},
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error("Webhook test failed", {
        requestId,
        webhookUrl: appConfig.webhook.url,
        error: errorMessage,
      });

      const testResult = {
        success: false,
        error: errorMessage,
        webhookUrl: appConfig.webhook.url,
        testedAt: new Date().toISOString(),
      };

      if (error instanceof Error && error.name === "AbortError") {
        throw ErrorFactory.webhook("Webhook test timed out", {
          ...testResult,
          timeout: appConfig.webhook.timeout,
        });
      }

      throw ErrorFactory.webhook("Webhook test failed", {
        ...testResult,
        originalError: errorMessage,
      });
    }
  }),
);

/**
 * GET /api/webhooks/config
 * Get current webhook configuration
 */
router.get(
  "/config",
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req);

    logger.debug("Webhook configuration requested", { requestId });

    const config = {
      url: appConfig.webhook.url,
      timeout: appConfig.webhook.timeout,
      retryAttempts: appConfig.webhook.retryAttempts,
      retryDelayMs: appConfig.webhook.retryDelayMs,
      configuredAt: new Date().toISOString(),
    };

    ResponseService.success(
      res,
      config,
      "Webhook configuration retrieved",
      requestId ? { requestId } : {},
    );
  }),
);

/**
 * POST /api/webhooks/bulk-send
 * Send multiple webhooks in sequence (useful for testing)
 */
router.post(
  "/bulk-send",
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req);
    const { webhooks, delayMs } = req.body;

    // Validate input
    if (!Array.isArray(webhooks) || webhooks.length === 0) {
      throw ErrorFactory.validation(
        "Webhooks array is required and must not be empty",
      );
    }

    if (webhooks.length > 10) {
      throw ErrorFactory.validation(
        "Maximum 10 webhooks allowed per bulk request",
      );
    }

    const delay = Math.min(Math.max(parseInt(delayMs) || 0, 0), 5000); // Max 5 second delay

    const results = [];

    logger.info("Starting bulk webhook send", {
      requestId,
      webhookCount: webhooks.length,
      delayMs: delay,
    });

    for (let i = 0; i < webhooks.length; i++) {
      const webhook = webhooks[i];
      const { from, to, message, timestamp, type, ...additionalData } = webhook;

      // Validate each webhook
      if (!from || !to || !message) {
        results.push({
          index: i,
          success: false,
          error: "Missing required fields: from, to, message",
          webhook: webhook,
        });
        continue;
      }

      try {
        const webhookPayload = {
          from: from.toString(),
          to: to.toString(),
          message: message.toString().trim(),
          timestamp: timestamp || Math.floor(Date.now() / 1000).toString(),
          type: type || "text",
          messageId: `bulk_db_${requestId}_${i}`,
          bulkIndex: i,
          bulkTotal: webhooks.length,
          bulkRequestId: requestId,
          ...additionalData,
        };

        const response = await fetch(appConfig.webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "WhatsApp-Server/1.0.0",
            "X-Request-ID": `${requestId}_bulk_${i}`,
          },
          body: JSON.stringify(webhookPayload),
          signal: AbortSignal.timeout(appConfig.webhook.timeout),
        });

        results.push({
          index: i,
          success: response.ok,
          statusCode: response.status,
          statusText: response.statusText,
          payload: webhookPayload,
          sentAt: new Date().toISOString(),
        });

        // Add delay between requests if specified
        if (delay > 0 && i < webhooks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        results.push({
          index: i,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          payload: webhook,
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;

    logger.info("Bulk webhook send completed", {
      requestId,
      total: results.length,
      successful: successCount,
      failed: failureCount,
    });

    ResponseService.success(
      res,
      {
        results,
        summary: {
          total: results.length,
          successful: successCount,
          failed: failureCount,
          delayMs: delay,
        },
        completedAt: new Date().toISOString(),
      },
      `Bulk webhook send completed: ${successCount}/${results.length} successful`,
      requestId ? { requestId } : {},
    );
  }),
);

export default router;
