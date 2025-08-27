import express, { Request, Response } from "express";
import { messageDeduplicator } from "../services/message-deduplicator";
import { webhookService } from "../services/webhook";
import { messageProcessor } from "../services/message-processor";
import { webhookQueue } from "../services/webhook-queue";
import { whatsappLogger } from "../utils/logger";
import { databaseManager } from "../models/database";

const router = express.Router();

/**
 * Get deduplication statistics
 */
router.get("/stats", async (req: Request, res: Response): Promise<void> => {
  try {
    const deduplicationStats = messageDeduplicator.getStats();
    const webhookStats = webhookService.getStats();
    const processorStats = messageProcessor.getStats();
    const queueStats = webhookQueue.getStats();

    // Get database statistics
    const dbStats = await databaseManager.getDatabase().get(`
      SELECT
        COUNT(*) as total_messages,
        COUNT(CASE WHEN webhook_sent = 1 THEN 1 END) as webhooks_sent,
        COUNT(CASE WHEN webhook_sent = 0 THEN 1 END) as webhooks_pending,
        COUNT(CASE WHEN webhook_attempts > 0 THEN 1 END) as messages_with_attempts,
        AVG(webhook_attempts) as avg_webhook_attempts,
        MAX(webhook_attempts) as max_webhook_attempts
      FROM messages
    `);

    const stats = {
      deduplication: deduplicationStats,
      webhook: {
        url: webhookStats.url,
        timeout: webhookStats.timeout,
        maxRetries: webhookStats.maxRetries,
        retryDelay: webhookStats.retryDelay,
      },
      processor: processorStats,
      webhookQueue: queueStats,
      database: dbStats,
      summary: {
        duplicatesPrevented:
          deduplicationStats.totalProcessed - deduplicationStats.webhooksSent,
        successRate:
          deduplicationStats.totalProcessed > 0
            ? (
                (deduplicationStats.webhooksSent /
                  deduplicationStats.totalProcessed) *
                100
              ).toFixed(2) + "%"
            : "0%",
      },
    };

    whatsappLogger.info("Deduplication stats requested", {
      totalProcessed: deduplicationStats.totalProcessed,
      webhooksSent: deduplicationStats.webhooksSent,
      duplicatesPrevented: stats.summary.duplicatesPrevented,
    });

    res.json({
      success: true,
      stats: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    whatsappLogger.error("Error getting deduplication stats:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Get recent duplicate attempts
 */
router.get(
  "/duplicates",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;

      if (limit > 100) {
        res.status(400).json({
          success: false,
          error: "Limit cannot exceed 100",
        });
        return;
      }

      const recentDuplicates = messageDeduplicator.getRecentDuplicates(limit);

      // Get additional duplicate info from database
      const duplicateMessages = await databaseManager.getDatabase().all(
        `
      SELECT
        message_id,
        [from],
        [to],
        message,
        webhook_attempts,
        webhook_sent,
        created_at,
        COUNT(*) OVER (PARTITION BY [from], [to], SUBSTR(message, 1, 50)) as content_similarity_count
      FROM messages
      WHERE webhook_attempts > 1 OR message_id IN (
        SELECT message_id
        FROM messages
        GROUP BY [from], [to], SUBSTR(message, 1, 50)
        HAVING COUNT(*) > 1
      )
      ORDER BY created_at DESC
      LIMIT ?
    `,
        [limit],
      );

      res.json({
        success: true,
        data: {
          fromDeduplicator: recentDuplicates,
          fromDatabase: duplicateMessages,
          summary: {
            totalDuplicatesInMemory: recentDuplicates.length,
            totalDuplicatesInDatabase: duplicateMessages.length,
          },
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      whatsappLogger.error("Error getting duplicate attempts:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * Clear deduplication cache
 */
router.post(
  "/clear-cache",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { confirmClear } = req.body;

      if (!confirmClear) {
        res.status(400).json({
          success: false,
          error: "Please provide confirmClear: true to clear the cache",
        });
        return;
      }

      const statsBefore = messageDeduplicator.getStats();
      messageDeduplicator.clearAll();
      const statsAfter = messageDeduplicator.getStats();

      whatsappLogger.info("Deduplication cache cleared", {
        clearedEntries: statsBefore.totalProcessed,
        clearedContentHashes: statsBefore.contentHashesSize,
      });

      res.json({
        success: true,
        message: "Deduplication cache cleared successfully",
        statsBefore: statsBefore,
        statsAfter: statsAfter,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      whatsappLogger.error("Error clearing deduplication cache:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * Check if specific message would be duplicated
 */
router.post(
  "/check-duplicate",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { messageId, from, to, content, timestamp } = req.body;

      if (!messageId || !from || !to || !content) {
        res.status(400).json({
          success: false,
          error: "Missing required fields: messageId, from, to, content",
        });
        return;
      }

      const messageIdentifier = {
        messageId: messageId,
        from: from,
        to: to,
        content: content,
        timestamp: timestamp || Date.now(),
      };

      const isProcessed =
        messageDeduplicator.isMessageProcessed(messageIdentifier);
      const isWebhookSent =
        messageDeduplicator.isWebhookSent(messageIdentifier);
      const isDuplicateContent =
        messageDeduplicator.isDuplicateContent(messageIdentifier);

      // Check database for existing messages
      const existingMessages = await databaseManager.getDatabase().all(
        `
      SELECT
        id,
        message_id,
        [from],
        [to],
        message,
        webhook_sent,
        webhook_attempts,
        created_at
      FROM messages
      WHERE message_id = ? OR ([from] = ? AND [to] = ? AND SUBSTR(message, 1, 100) = SUBSTR(?, 1, 100))
      ORDER BY created_at DESC
    `,
        [messageId, from, to, content],
      );

      res.json({
        success: true,
        data: {
          messageId: messageId,
          checks: {
            isProcessed: isProcessed,
            isWebhookSent: isWebhookSent,
            isDuplicateContent: isDuplicateContent,
            existsInDatabase: existingMessages.length > 0,
          },
          existingMessages: existingMessages,
          recommendation:
            isProcessed || isWebhookSent || isDuplicateContent
              ? "SKIP - Message would be considered duplicate"
              : "PROCESS - Message appears to be unique",
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      whatsappLogger.error("Error checking duplicate:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * Force remove message from deduplication tracking
 */
router.post(
  "/remove-message",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { messageId, from, to, content } = req.body;

      if (!messageId || !from || !to) {
        res.status(400).json({
          success: false,
          error: "Missing required fields: messageId, from, to",
        });
        return;
      }

      const messageIdentifier = {
        messageId: messageId,
        from: from,
        to: to,
        content: content || "unknown",
        timestamp: Date.now(),
      };

      const wasTracked =
        messageDeduplicator.isMessageProcessed(messageIdentifier);
      messageDeduplicator.removeMessage(messageIdentifier);

      whatsappLogger.info("Message removed from deduplication tracking", {
        messageId: messageId,
        from: from,
        to: to,
        wasTracked: wasTracked,
      });

      res.json({
        success: true,
        message: "Message removed from deduplication tracking",
        data: {
          messageId: messageId,
          wasTracked: wasTracked,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      whatsappLogger.error("Error removing message from tracking:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * Get deduplication health status
 */
router.get("/health", async (req: Request, res: Response): Promise<void> => {
  try {
    const stats = messageDeduplicator.getStats();
    const now = Date.now();

    // Define health thresholds
    const healthStatus = {
      overall: "healthy",
      checks: {
        cacheSize: {
          status:
            stats.cacheSize < 8000
              ? "healthy"
              : stats.cacheSize < 9500
                ? "warning"
                : "critical",
          value: stats.cacheSize,
          threshold: 10000,
          message:
            stats.cacheSize < 8000
              ? "Cache size normal"
              : stats.cacheSize < 9500
                ? "Cache size approaching limit"
                : "Cache size critical",
        },
        contentHashSize: {
          status:
            stats.contentHashesSize < 8000
              ? "healthy"
              : stats.contentHashesSize < 9500
                ? "warning"
                : "critical",
          value: stats.contentHashesSize,
          threshold: 10000,
          message:
            stats.contentHashesSize < 8000
              ? "Content hash size normal"
              : stats.contentHashesSize < 9500
                ? "Content hash size approaching limit"
                : "Content hash size critical",
        },
        processingBacklog: {
          status:
            stats.currentlyProcessing < 10
              ? "healthy"
              : stats.currentlyProcessing < 50
                ? "warning"
                : "critical",
          value: stats.currentlyProcessing,
          threshold: 50,
          message:
            stats.currentlyProcessing < 10
              ? "Processing backlog normal"
              : stats.currentlyProcessing < 50
                ? "Processing backlog elevated"
                : "Processing backlog critical",
        },
        successRate: {
          status:
            stats.totalProcessed === 0
              ? "unknown"
              : stats.webhooksSent / stats.totalProcessed > 0.95
                ? "healthy"
                : stats.webhooksSent / stats.totalProcessed > 0.85
                  ? "warning"
                  : "critical",
          value:
            stats.totalProcessed > 0
              ? ((stats.webhooksSent / stats.totalProcessed) * 100).toFixed(2) +
                "%"
              : "0%",
          message:
            stats.totalProcessed === 0
              ? "No messages processed yet"
              : stats.webhooksSent / stats.totalProcessed > 0.95
                ? "Success rate excellent"
                : stats.webhooksSent / stats.totalProcessed > 0.85
                  ? "Success rate acceptable"
                  : "Success rate poor",
        },
      },
    };

    // Determine overall health
    const checkStatuses = Object.values(healthStatus.checks).map(
      (check) => check.status,
    );
    if (checkStatuses.includes("critical")) {
      healthStatus.overall = "critical";
    } else if (checkStatuses.includes("warning")) {
      healthStatus.overall = "warning";
    }

    res.json({
      success: true,
      health: healthStatus,
      stats: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    whatsappLogger.error("Error getting deduplication health:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      health: {
        overall: "critical",
        message: "Health check failed",
      },
    });
  }
});

/**
 * Simulate message processing for testing deduplication
 */
router.post(
  "/test-deduplication",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { messageId, from, to, content, simulateCount = 1 } = req.body;

      if (!messageId || !from || !to || !content) {
        res.status(400).json({
          success: false,
          error: "Missing required fields: messageId, from, to, content",
        });
        return;
      }

      if (simulateCount > 10) {
        res.status(400).json({
          success: false,
          error: "simulateCount cannot exceed 10",
        });
        return;
      }

      const results = [];

      for (let i = 0; i < simulateCount; i++) {
        const messageIdentifier = {
          messageId: `${messageId}_${i}`,
          from: from,
          to: to,
          content: content,
          timestamp: Date.now() + i * 1000, // Space out by 1 second
        };

        const canProcess =
          messageDeduplicator.markAsProcessing(messageIdentifier);

        results.push({
          attempt: i + 1,
          messageId: messageIdentifier.messageId,
          canProcess: canProcess,
          reason: canProcess
            ? "Allowed to process"
            : "Blocked by deduplication",
        });

        if (canProcess) {
          // Simulate completion
          setTimeout(() => {
            messageDeduplicator.markAsCompleted(messageIdentifier, true);
          }, 100);
        }
      }

      whatsappLogger.info("Deduplication test completed", {
        originalMessageId: messageId,
        simulateCount: simulateCount,
        allowedToProcess: results.filter((r) => r.canProcess).length,
        blockedByDeduplication: results.filter((r) => !r.canProcess).length,
      });

      res.json({
        success: true,
        message: "Deduplication test completed",
        data: {
          testParams: { messageId, from, to, content, simulateCount },
          results: results,
          summary: {
            total: results.length,
            allowed: results.filter((r) => r.canProcess).length,
            blocked: results.filter((r) => !r.canProcess).length,
          },
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      whatsappLogger.error("Error testing deduplication:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * Get webhook queue statistics
 */
router.get(
  "/queue/stats",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const queueStats = webhookQueue.getStats();

      res.json({
        success: true,
        data: queueStats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      whatsappLogger.error("Error getting webhook queue stats:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * Force process webhook queue
 */
router.post(
  "/queue/process",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const statsBefore = webhookQueue.getStats();

      await webhookQueue.forceProcess();

      // Wait a bit for processing to complete
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const statsAfter = webhookQueue.getStats();

      whatsappLogger.info("Webhook queue force processed", {
        queueSizeBefore: statsBefore.queueSize,
        queueSizeAfter: statsAfter.queueSize,
        processed: statsBefore.queueSize - statsAfter.queueSize,
      });

      res.json({
        success: true,
        message: "Webhook queue processed",
        data: {
          before: statsBefore,
          after: statsAfter,
          processed: statsBefore.queueSize - statsAfter.queueSize,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      whatsappLogger.error("Error processing webhook queue:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * Clear webhook queue
 */
router.post(
  "/queue/clear",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { confirmClear } = req.body;

      if (!confirmClear) {
        res.status(400).json({
          success: false,
          error: "Please provide confirmClear: true to clear the queue",
        });
        return;
      }

      const statsBefore = webhookQueue.getStats();
      webhookQueue.clearQueue();
      const statsAfter = webhookQueue.getStats();

      whatsappLogger.info("Webhook queue cleared", {
        clearedEntries: statsBefore.queueSize,
      });

      res.json({
        success: true,
        message: "Webhook queue cleared successfully",
        data: {
          before: statsBefore,
          after: statsAfter,
          clearedEntries: statsBefore.queueSize,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      whatsappLogger.error("Error clearing webhook queue:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

export default router;
