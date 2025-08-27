import express, { Request, Response } from "express";
import { databaseManager } from "../models/database";
import { whatsappService } from "../services/whatsapp";
import { appConfig } from "../config";
import { logger } from "../utils/logger";
import { ResponseService } from "../utils/response-service";
import { asyncHandler, ErrorFactory } from "../middleware/error-handling";
import { getRequestId } from "../middleware/request-logging";

const router = express.Router();

/**
 * POST /api/messages/test
 * Insert a test message for development and testing purposes
 */
router.post(
  "/test",
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req);
    const { from, to, message } = req.body;

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

    // Validate phone numbers format (basic validation)
    const phoneRegex = /^\d{10,15}$/;
    if (!phoneRegex.test(from.replace(/\D/g, ""))) {
      throw ErrorFactory.validation('Invalid "from" phone number format');
    }

    if (!phoneRegex.test(to.replace(/\D/g, ""))) {
      throw ErrorFactory.validation('Invalid "to" phone number format');
    }

    try {
      // Use whatsapp service to insert test message
      const messageId = await (whatsappService as any).insertTestMessage(
        from,
        to,
        message,
      );

      logger.info("Test message processed successfully", {
        requestId,
        messageId,
        from,
        to,
        messagePreview: message.substring(0, 50),
        messageLength: message.length,
      });

      ResponseService.success(
        res,
        {
          messageId,
          from,
          to,
          message: "Test message processed and webhook triggered",
          timestamp: new Date().toISOString(),
        },
        "Test message created successfully",
        requestId ? { requestId } : {},
      );
    } catch (error) {
      logger.error("Failed to process test message", {
        requestId,
        error: error instanceof Error ? error.message : "Unknown error",
        from,
        to,
      });

      throw ErrorFactory.whatsapp("Failed to process test message", {
        originalError: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }),
);

/**
 * PUT /api/messages/:messageId/content
 * Update message content for protocol captures and manual corrections
 */
router.put(
  "/:messageId/content",
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req);
    const { messageId } = req.params;
    const { message } = req.body;

    // Validate required fields
    if (!messageId) {
      throw ErrorFactory.validation("Message ID is required");
    }

    if (!message || typeof message !== "string") {
      throw ErrorFactory.validation(
        "Message content is required and must be a string",
      );
    }

    if (message.trim().length === 0) {
      throw ErrorFactory.validation("Message content cannot be empty");
    }

    try {
      // Update the message content in database
      const updateResult = await databaseManager
        .getDatabase()
        .run(
          "UPDATE messages SET message = ?, updated_at = CURRENT_TIMESTAMP WHERE message_id = ?",
          [message.trim(), messageId],
        );

      if ((updateResult.changes || 0) === 0) {
        throw ErrorFactory.notFound(`Message with ID "${messageId}" not found`);
      }

      logger.info("Message content updated successfully", {
        requestId,
        messageId,
        newContentPreview: message.substring(0, 100),
        contentLength: message.length,
      });

      ResponseService.success(
        res,
        {
          messageId,
          updatedContent: message,
          updatedAt: new Date().toISOString(),
        },
        "Message content updated successfully",
        requestId ? { requestId } : {},
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw error; // Re-throw our custom not found error
      }

      logger.error("Failed to update message content", {
        requestId,
        messageId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw ErrorFactory.database("Failed to update message content", {
        messageId,
        originalError: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }),
);

/**
 * GET /api/messages/protocol
 * Get recent protocol messages that need content updates
 */
router.get(
  "/protocol",
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req);
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50); // Max 50 messages

    try {
      const protocolMessages = await databaseManager.getDatabase().all(
        `
      SELECT id, message_id, [from], [to], message, timestamp, created_at, webhook_sent
      FROM messages
      WHERE message LIKE '%Message from%'
         OR message LIKE '%💬 New message%'
         OR message LIKE '%message from%'
         OR message LIKE '%[CONTENT_NEEDED]%'
      ORDER BY created_at DESC
      LIMIT ?
    `,
        [limit],
      );

      logger.info("Protocol messages retrieved", {
        requestId,
        count: protocolMessages.length,
        limit,
      });

      ResponseService.success(
        res,
        {
          messages: protocolMessages,
          count: protocolMessages.length,
          limit,
          retrievedAt: new Date().toISOString(),
        },
        "Protocol messages retrieved successfully",
        requestId ? { requestId } : {},
      );
    } catch (error) {
      logger.error("Failed to fetch protocol messages", {
        requestId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw ErrorFactory.database("Failed to retrieve protocol messages", {
        originalError: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }),
);

/**
 * POST /api/messages/:messageId/set-real-content
 * Set real message content and trigger webhook immediately
 */
router.post(
  "/:messageId/set-real-content",
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req);
    const { messageId } = req.params;
    const { realContent } = req.body;

    // Validate required fields
    if (!messageId) {
      throw ErrorFactory.validation("Message ID is required");
    }

    if (!realContent || typeof realContent !== "string") {
      throw ErrorFactory.validation(
        "Real content is required and must be a string",
      );
    }

    if (realContent.trim().length === 0) {
      throw ErrorFactory.validation("Real content cannot be empty");
    }

    try {
      // Update message content
      const updateResult = await databaseManager
        .getDatabase()
        .run(
          "UPDATE messages SET message = ?, updated_at = CURRENT_TIMESTAMP WHERE message_id = ?",
          [realContent.trim(), messageId],
        );

      if ((updateResult.changes || 0) === 0) {
        throw ErrorFactory.notFound(`Message with ID "${messageId}" not found`);
      }

      // Get updated message for webhook
      const updatedMessage = await databaseManager
        .getDatabase()
        .get("SELECT * FROM messages WHERE message_id = ?", [messageId]);

      if (!updatedMessage) {
        throw ErrorFactory.notFound("Message not found after update");
      }

      // Prepare webhook payload
      const webhookPayload = {
        from: updatedMessage.from,
        to: updatedMessage.to,
        message: realContent.trim(),
        timestamp: updatedMessage.timestamp,
        type: updatedMessage.type || "text",
        messageId: updatedMessage.id,
      };

      let webhookSuccess = false;
      let webhookError: string | null = null;

      // Send webhook
      try {
        const response = await fetch(appConfig.webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "WhatsApp-Server/1.0.0",
          },
          body: JSON.stringify(webhookPayload),
          signal: AbortSignal.timeout(appConfig.webhook.timeout),
        });

        webhookSuccess = response.ok;

        if (!response.ok) {
          const errorText = await response
            .text()
            .catch(() => "Unknown response error");
          webhookError = `HTTP ${response.status}: ${errorText}`;
        }

        // Update webhook status in database
        await databaseManager
          .getDatabase()
          .run(
            "UPDATE messages SET webhook_sent = ?, webhook_attempts = COALESCE(webhook_attempts, 0) + 1, webhook_last_attempt = CURRENT_TIMESTAMP WHERE message_id = ?",
            [webhookSuccess ? 1 : 0, messageId],
          );
      } catch (webhookErr) {
        webhookError =
          webhookErr instanceof Error
            ? webhookErr.message
            : "Unknown webhook error";

        // Update webhook status in database
        await databaseManager
          .getDatabase()
          .run(
            "UPDATE messages SET webhook_sent = 0, webhook_attempts = COALESCE(webhook_attempts, 0) + 1, webhook_last_attempt = CURRENT_TIMESTAMP WHERE message_id = ?",
            [messageId],
          );
      }

      logger.info("Real content set and webhook processed", {
        requestId,
        messageId,
        contentPreview: realContent.substring(0, 50),
        webhookSuccess,
        webhookError,
      });

      const responseData = {
        messageId,
        content: realContent,
        webhookSent: webhookSuccess,
        updatedAt: new Date().toISOString(),
      };

      if (webhookSuccess) {
        ResponseService.success(
          res,
          responseData,
          "Content updated and webhook sent successfully",
          requestId ? { requestId } : {},
        );
      } else {
        ResponseService.success(
          res,
          { ...responseData, webhookError },
          "Content updated but webhook failed",
          requestId ? { requestId } : {},
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw error; // Re-throw our custom not found error
      }

      logger.error("Failed to set real content", {
        requestId,
        messageId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw ErrorFactory.database("Failed to set real content", {
        messageId,
        originalError: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }),
);

/**
 * GET /api/messages/:messageId
 * Get a specific message by ID
 */
router.get(
  "/:messageId",
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req);
    const { messageId } = req.params;

    if (!messageId) {
      throw ErrorFactory.validation("Message ID is required");
    }

    try {
      const message = await databaseManager
        .getDatabase()
        .get("SELECT * FROM messages WHERE message_id = ?", [messageId]);

      if (!message) {
        throw ErrorFactory.notFound(`Message with ID "${messageId}" not found`);
      }

      logger.debug("Message retrieved", {
        requestId,
        messageId,
        from: message.from,
        to: message.to,
      });

      ResponseService.success(
        res,
        message,
        "Message retrieved successfully",
        requestId ? { requestId } : {},
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw error; // Re-throw our custom not found error
      }

      logger.error("Failed to retrieve message", {
        requestId,
        messageId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw ErrorFactory.database("Failed to retrieve message", {
        messageId,
        originalError: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }),
);

/**
 * GET /api/messages
 * Get messages with optional filtering and pagination
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req);
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;
    const from = req.query.from as string;
    const to = req.query.to as string;
    const hasContent = req.query.hasContent as string;

    try {
      let query = "SELECT * FROM messages WHERE 1=1";
      const params: any[] = [];

      // Add filters
      if (from) {
        query += " AND [from] = ?";
        params.push(from);
      }

      if (to) {
        query += " AND [to] = ?";
        params.push(to);
      }

      if (hasContent === "false") {
        query +=
          ' AND (message LIKE "%[CONTENT_NEEDED]%" OR message LIKE "%Message from%")';
      } else if (hasContent === "true") {
        query +=
          ' AND message NOT LIKE "%[CONTENT_NEEDED]%" AND message NOT LIKE "%Message from%"';
      }

      // Add pagination
      query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);

      const messages = await databaseManager.getDatabase().all(query, params);

      // Get total count for pagination
      let countQuery = "SELECT COUNT(*) as total FROM messages WHERE 1=1";
      const countParams: any[] = [];

      if (from) {
        countQuery += " AND [from] = ?";
        countParams.push(from);
      }

      if (to) {
        countQuery += " AND [to] = ?";
        countParams.push(to);
      }

      if (hasContent === "false") {
        countQuery +=
          ' AND (message LIKE "%[CONTENT_NEEDED]%" OR message LIKE "%Message from%")';
      } else if (hasContent === "true") {
        countQuery +=
          ' AND message NOT LIKE "%[CONTENT_NEEDED]%" AND message NOT LIKE "%Message from%"';
      }

      const countResult = await databaseManager
        .getDatabase()
        .get(countQuery, countParams);
      const totalMessages = countResult?.total || 0;
      const totalPages = Math.ceil(totalMessages / limit);

      logger.info("Messages retrieved with pagination", {
        requestId,
        page,
        limit,
        totalMessages,
        totalPages,
        filters: { from, to, hasContent },
      });

      ResponseService.paginated(
        res,
        messages,
        {
          page,
          limit,
          total: totalMessages,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
        "Messages retrieved successfully",
        requestId ? { requestId } : {},
      );
    } catch (error) {
      logger.error("Failed to retrieve messages", {
        requestId,
        error: error instanceof Error ? error.message : "Unknown error",
        filters: { from, to, hasContent, page, limit },
      });

      throw ErrorFactory.database("Failed to retrieve messages", {
        originalError: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }),
);

export default router;
