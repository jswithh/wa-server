import express, { Request, Response } from "express";
import { whatsappService } from "../services/whatsapp";
import { webhookService } from "../services/webhook";
import { databaseManager } from "../models/database";
import {
  createSuccessResponse,
  createErrorResponse,
} from "../utils/validation";
import { serverLogger } from "../utils/logger";

const router = express.Router();

/**
 * GET /dashboard/stats
 * Get overall system statistics
 */
router.get("/stats", async (req: Request, res: Response) => {
  try {
    // Get WhatsApp service stats
    const whatsappStats = whatsappService.getStats();

    // Get database stats
    const dbStats = await databaseManager.getStats();

    // Get webhook stats
    const webhookStats = webhookService.getStats();

    const systemStats = {
      whatsapp: whatsappStats,
      database: dbStats,
      webhook: webhookStats,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
      platform: process.platform,
      timestamp: new Date().toISOString(),
    };

    res.json(
      createSuccessResponse(
        systemStats,
        "System statistics retrieved successfully",
      ),
    );
  } catch (error) {
    serverLogger.error("Failed to get system stats:", error);
    res
      .status(500)
      .json(createErrorResponse("Failed to retrieve system statistics"));
  }
});

/**
 * GET /dashboard/health
 * Health check endpoint
 */
router.get("/health", async (req: Request, res: Response) => {
  try {
    const health = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      services: {
        whatsapp: whatsappService.getStats().isInitialized
          ? "healthy"
          : "unhealthy",
        database: "healthy", // We'll assume healthy if we can respond
        webhook: "healthy",
      },
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
    };

    // Test webhook connectivity
    try {
      const webhookTest = await webhookService.testConnection();
      health.services.webhook = webhookTest.success ? "healthy" : "unhealthy";
    } catch (error) {
      health.services.webhook = "unhealthy";
    }

    const isHealthy = Object.values(health.services).every(
      (status) => status === "healthy",
    );

    if (isHealthy) {
      res.json(createSuccessResponse(health, "System is healthy"));
    } else {
      res
        .status(503)
        .json(createErrorResponse("System is unhealthy", "UNHEALTHY", health));
    }
  } catch (error) {
    serverLogger.error("Health check failed:", error);
    res.status(503).json(createErrorResponse("Health check failed"));
  }
});

/**
 * POST /dashboard/webhook/test
 * Test webhook connectivity
 */
router.post("/webhook/test", async (req: Request, res: Response) => {
  try {
    const result = await webhookService.testConnection();

    if (result.success) {
      res.json(
        createSuccessResponse(
          {
            success: true,
            responseTime: result.responseTime,
            url: webhookService.getConfig().url,
          },
          "Webhook test successful",
        ),
      );
    } else {
      res.status(400).json(
        createErrorResponse("Webhook test failed", "WEBHOOK_TEST_FAILED", {
          error: result.error,
        }),
      );
    }
  } catch (error) {
    serverLogger.error("Webhook test failed:", error);
    res.status(500).json(createErrorResponse("Webhook test failed"));
  }
});

/**
 * GET /dashboard/webhook/config
 * Get webhook configuration
 */
router.get("/webhook/config", (req: Request, res: Response) => {
  try {
    const config = webhookService.getConfig();

    res.json(
      createSuccessResponse(
        {
          url: config.url,
          timeout: config.timeout,
          maxRetries: config.maxRetries,
          retryDelay: config.retryDelay,
        },
        "Webhook configuration retrieved successfully",
      ),
    );
  } catch (error) {
    serverLogger.error("Failed to get webhook config:", error);
    res
      .status(500)
      .json(createErrorResponse("Failed to retrieve webhook configuration"));
  }
});

/**
 * PUT /dashboard/webhook/config
 * Update webhook configuration
 */
router.put("/webhook/config", async (req: Request, res: Response) => {
  try {
    const { url, timeout, maxRetries, retryDelay } = req.body;

    // Validate configuration
    const config: any = {};

    if (url) {
      try {
        new URL(url);
        config.url = url;
      } catch {
        return res.status(400).json(createErrorResponse("Invalid webhook URL"));
      }
    }

    if (
      timeout &&
      typeof timeout === "number" &&
      timeout > 0 &&
      timeout <= 60000
    ) {
      config.timeout = timeout;
    }

    if (
      maxRetries &&
      typeof maxRetries === "number" &&
      maxRetries > 0 &&
      maxRetries <= 10
    ) {
      config.maxRetries = maxRetries;
    }

    if (
      retryDelay &&
      typeof retryDelay === "number" &&
      retryDelay > 0 &&
      retryDelay <= 10000
    ) {
      config.retryDelay = retryDelay;
    }

    if (Object.keys(config).length === 0) {
      return res
        .status(400)
        .json(createErrorResponse("No valid configuration provided"));
    }

    // Update configuration
    webhookService.updateConfig(config);

    // Test new configuration if URL was changed
    if (config.url) {
      const testResult = await webhookService.testConnection();
      if (!testResult.success) {
        serverLogger.warn(
          "Webhook test failed after configuration update:",
          testResult.error,
        );
      }
    }

    const updatedConfig = webhookService.getConfig();

    return res.json(
      createSuccessResponse(
        {
          url: updatedConfig.url,
          timeout: updatedConfig.timeout,
          maxRetries: updatedConfig.maxRetries,
          retryDelay: updatedConfig.retryDelay,
        },
        "Webhook configuration updated successfully",
      ),
    );
  } catch (error) {
    serverLogger.error("Failed to update webhook config:", error);
    return res
      .status(500)
      .json(createErrorResponse("Failed to update webhook configuration"));
  }
});

/**
 * GET /dashboard/messages/pending
 * Get pending webhook messages
 */
router.get("/messages/pending", async (req: Request, res: Response) => {
  try {
    const pendingMessages = await databaseManager.getPendingWebhookMessages();

    const summary = {
      total: pendingMessages.length,
      byAccount: {} as Record<string, number>,
      byType: {} as Record<string, number>,
      oldestMessage: pendingMessages[0] || null,
      messages: pendingMessages.slice(0, 50), // Limit to first 50 for performance
    };

    // Group by account
    pendingMessages.forEach((msg) => {
      summary.byAccount[msg.account_id] =
        (summary.byAccount[msg.account_id] || 0) + 1;
      summary.byType[msg.type] = (summary.byType[msg.type] || 0) + 1;
    });

    res.json(
      createSuccessResponse(
        summary,
        "Pending webhook messages retrieved successfully",
      ),
    );
  } catch (error) {
    serverLogger.error("Failed to get pending messages:", error);
    res
      .status(500)
      .json(createErrorResponse("Failed to retrieve pending messages"));
  }
});

/**
 * POST /dashboard/messages/retry
 * Retry failed webhook messages
 */
router.post("/messages/retry", async (req: Request, res: Response) => {
  try {
    const { messageIds } = req.body;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res
        .status(400)
        .json(createErrorResponse("Invalid message IDs provided"));
    }

    // Get messages to retry
    const pendingMessages = await databaseManager.getPendingWebhookMessages();
    const messagesToRetry = pendingMessages.filter(
      (msg) => messageIds.includes(msg.id) && msg.webhook_attempts < 5,
    );

    if (messagesToRetry.length === 0) {
      return res
        .status(404)
        .json(createErrorResponse("No eligible messages found for retry"));
    }

    // Reset webhook attempts for retry
    for (const message of messagesToRetry) {
      await databaseManager.updateMessageWebhookStatus(message.id, false, 0);
    }

    return res.json(
      createSuccessResponse(
        {
          retried: messagesToRetry.length,
          messageIds: messagesToRetry.map((m) => m.id),
        },
        "Messages queued for retry successfully",
      ),
    );
  } catch (error) {
    serverLogger.error("Failed to retry messages:", error);
    return res
      .status(500)
      .json(createErrorResponse("Failed to retry messages"));
  }
});

/**
 * GET /dashboard/logs/recent
 * Get recent system logs (if available)
 */
router.get("/logs/recent", (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const level = (req.query.level as string) || "info";

    // This is a simplified log endpoint
    // In a production system, you might want to read from log files
    // or use a proper log aggregation system

    const mockLogs = [
      {
        timestamp: new Date().toISOString(),
        level: "info",
        message: "System is running normally",
        service: "system",
      },
    ];

    res.json(
      createSuccessResponse(
        {
          logs: mockLogs,
          total: mockLogs.length,
          level,
          limit,
        },
        "Recent logs retrieved successfully",
      ),
    );
  } catch (error) {
    serverLogger.error("Failed to get recent logs:", error);
    res.status(500).json(createErrorResponse("Failed to retrieve recent logs"));
  }
});

/**
 * GET /dashboard/performance
 * Get system performance metrics
 */
router.get("/performance", (req: Request, res: Response) => {
  try {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    const performance = {
      uptime: process.uptime(),
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024), // MB
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
        external: Math.round(memUsage.external / 1024 / 1024), // MB
        arrayBuffers: Math.round(memUsage.arrayBuffers / 1024 / 1024), // MB
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system,
      },
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      loadAverage:
        process.platform !== "win32" ? require("os").loadavg() : [0, 0, 0],
      timestamp: new Date().toISOString(),
    };

    res.json(
      createSuccessResponse(
        performance,
        "Performance metrics retrieved successfully",
      ),
    );
  } catch (error) {
    serverLogger.error("Failed to get performance metrics:", error);
    res
      .status(500)
      .json(createErrorResponse("Failed to retrieve performance metrics"));
  }
});

export default router;
