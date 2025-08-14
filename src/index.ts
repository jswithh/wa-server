import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs/promises";

// Import services and models
import { databaseManager } from "./models/database";
import { whatsappService, MessageData } from "./services/whatsapp";
import { webhookService } from "./services/webhook";

// Import routes
import accountsRouter from "./routes/accounts";
import dashboardRouter from "./routes/dashboard";

// Import utilities
import { logger, serverLogger } from "./utils/logger";
import { createErrorResponse } from "./utils/validation";

// Global error handling for logger.trace issues
process.on("unhandledRejection", (reason, promise) => {
  if (reason && typeof reason === "object" && "message" in reason) {
    const errorMessage = (reason as Error).message;
    if (errorMessage.includes("logger.trace is not a function")) {
      console.warn(
        "Baileys logger.trace error caught and handled:",
        errorMessage,
      );
      return; // Don't crash the app for this specific error
    }
  }

  serverLogger.error("Unhandled promise rejection:", {
    reason,
    promise,
  });

  // Don't exit the process, just log the error
  console.error("Unhandled rejection details:", reason);
});

process.on("uncaughtException", (error) => {
  if (
    error.message &&
    error.message.includes("logger.trace is not a function")
  ) {
    console.warn(
      "Baileys logger.trace uncaught exception handled:",
      error.message,
    );
    return; // Don't crash the app for this specific error
  }

  serverLogger.error("Uncaught exception:", error);
  console.error("Uncaught exception details:", error);

  // For other uncaught exceptions, we should still exit
  if (!error.message.includes("logger.trace")) {
    process.exit(1);
  }
});

// Environment configuration
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const WEBHOOK_URL =
  process.env.WEBHOOK_URL ||
  "http://localhost:10022/hra_whatsapp/sub_channel/webhook";

// Create Express application
const app = express();

// Trust proxy for accurate client IP addresses
app.set("trust proxy", true);

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// CORS configuration
app.use(
  cors({
    origin: NODE_ENV === "production" ? false : true, // Allow all origins in development
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  }),
);

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - startTime;
    serverLogger.info(`${req.method} ${req.path}`, {
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get("User-Agent"),
    });
  });

  next();
});

// Rate limiting middleware (simple implementation)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

app.use((req: Request, res: Response, next: NextFunction) => {
  const clientIP = req.ip || "unknown";
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxRequests = 1000; // Max requests per window

  const clientData = rateLimitMap.get(clientIP);

  if (!clientData || now > clientData.resetTime) {
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + windowMs });
    next();
  } else if (clientData.count < maxRequests) {
    clientData.count++;
    next();
  } else {
    res
      .status(429)
      .json(
        createErrorResponse(
          "Too many requests. Please try again later.",
          "RATE_LIMIT_EXCEEDED",
        ),
      );
  }
});

// Clean up rate limit map periodically
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, data] of rateLimitMap.entries()) {
      if (now > data.resetTime) {
        rateLimitMap.delete(ip);
      }
    }
  },
  5 * 60 * 1000,
); // Clean up every 5 minutes

// Serve static files
app.use(express.static(path.join(__dirname, "../public")));

// API Routes
app.use("/api/accounts", accountsRouter);
app.use("/api/dashboard", dashboardRouter);

// Test endpoint for manual message insertion
app.post("/api/test-message", async (req: Request, res: Response): Promise<void> => {
  try {
    const { from, to, message } = req.body;

    if (!from || !to || !message) {
      res.status(400).json({ error: "Missing required fields: from, to, message" });
      return;
    }

    // Use message processor to insert test message
    const messageId = await (whatsappService as any).insertTestMessage(from, to, message);

    serverLogger.info("Test message processed successfully", {
      messageId: messageId,
      from: from,
      to: to,
      message: message
    });

    res.json({
      success: true,
      messageId: messageId,
      message: "Test message processed and webhook triggered"
    });
  } catch (error) {
    serverLogger.error("Error in test-message endpoint:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Endpoint to update message content for protocol captures
app.post("/api/update-message", async (req: Request, res: Response): Promise<void> => {
  try {
    const { messageId, message } = req.body;

    if (!messageId || !message) {
      res.status(400).json({ error: "Missing required fields: messageId, message" });
      return;
    }

    // Update the message content in database
    await databaseManager.getDatabase().run(
      "UPDATE messages SET message = ? WHERE message_id = ?",
      [message, messageId]
    );

    serverLogger.info("Message content updated:", {
      messageId: messageId,
      newContent: message.substring(0, 100)
    });

    res.json({
      success: true,
      messageId: messageId,
      message: "Message content updated successfully"
    });
  } catch (error) {
    serverLogger.error("Error updating message content:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Endpoint to get recent protocol messages that need content update
app.get("/api/protocol-messages", async (req: Request, res: Response): Promise<void> => {
  try {
    const messages = await databaseManager.getDatabase().all(`
      SELECT id, message_id, [from], [to], message, timestamp, created_at
      FROM messages
      WHERE message LIKE '%Message from%' OR message LIKE '%💬 New message%' OR message LIKE '%message from%'
      ORDER BY created_at DESC
      LIMIT 10
    `);

    res.json({
      success: true,
      messages: messages,
      count: messages.length
    });
  } catch (error) {
    serverLogger.error("Error fetching protocol messages:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Dashboard for managing message content
app.get("/api/dashboard/messages", async (req: Request, res: Response): Promise<void> => {
  try {
    const needsContentMessages = await databaseManager.getDatabase().all(`
      SELECT id, message_id, [from], [to], message, timestamp, created_at, webhook_sent
      FROM messages
      WHERE message LIKE '%[CONTENT_NEEDED]%'
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const recentMessages = await databaseManager.getDatabase().all(`
      SELECT id, message_id, [from], [to], message, timestamp, created_at, webhook_sent
      FROM messages
      WHERE message NOT LIKE '%[CONTENT_NEEDED]%'
      ORDER BY created_at DESC
      LIMIT 10
    `);

    const placeholderMessages = await databaseManager.getDatabase().all(`
      SELECT id, message_id, [from], [to], message, timestamp, created_at, webhook_sent
      FROM messages
      WHERE message LIKE '%Message from%(%)'
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const stats = await databaseManager.getDatabase().get(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN message LIKE '%[CONTENT_NEEDED]%' THEN 1 END) as needsContent,
        COUNT(CASE WHEN message LIKE '%Message from%(%' THEN 1 END) as placeholderContent,
        COUNT(CASE WHEN webhook_sent = 1 THEN 1 END) as webhookSent
      FROM messages
    `);

    res.json({
      success: true,
      dashboard: {
        stats: stats,
        needsContentMessages: needsContentMessages,
        recentMessages: recentMessages,
        placeholderMessages: placeholderMessages
      }
    });
  } catch (error) {
    serverLogger.error("Error fetching dashboard data:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Set real message content and trigger webhook
app.post("/api/set-real-content", async (req: Request, res: Response): Promise<void> => {
  try {
    const { messageId, realContent } = req.body;

    if (!messageId || !realContent) {
      res.status(400).json({ error: "Missing required fields: messageId, realContent" });
      return;
    }

    // Update message content
    const updateResult = await databaseManager.getDatabase().run(
      "UPDATE messages SET message = ? WHERE message_id = ?",
      [realContent, messageId]
    );

    if ((updateResult.changes || 0) === 0) {
      res.status(404).json({ error: "Message not found" });
      return;
    }

    // Get updated message for webhook
    const message = await databaseManager.getDatabase().get(
      "SELECT * FROM messages WHERE message_id = ?",
      [messageId]
    );

    if (message) {
      // Send webhook immediately
      const webhookPayload = {
        from: message.from,
        to: message.to,
        message: realContent,
        timestamp: message.timestamp,
        type: message.type
      };

      try {
        const response = await fetch(process.env.WEBHOOK_URL || "http://localhost:10022/hra_whatsapp/sub_channel/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(webhookPayload)
        });

        if (response.ok) {
          // Mark webhook as sent
          await databaseManager.getDatabase().run(
            "UPDATE messages SET webhook_sent = 1, webhook_attempts = 1 WHERE message_id = ?",
            [messageId]
          );
        }

        serverLogger.info("Real content set and webhook sent:", {
          messageId: messageId,
          content: realContent.substring(0, 50),
          webhookSuccess: response.ok
        });

        res.json({
          success: true,
          messageId: messageId,
          content: realContent,
          webhookSent: response.ok,
          message: "Content updated and webhook sent successfully"
        });
      } catch (webhookError) {
        serverLogger.error("Error sending webhook after content update:", webhookError);
        res.json({
          success: true,
          messageId: messageId,
          content: realContent,
          webhookSent: false,
          warning: "Content updated but webhook failed"
        });
      }
    } else {
      res.status(404).json({ error: "Message not found after update" });
    }
  } catch (error) {
    serverLogger.error("Error setting real content:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Helper endpoint to format webhook payload for testing
app.post("/api/send-webhook", async (req: Request, res: Response): Promise<void> => {
  try {
    const { from, to, message, timestamp, type } = req.body;

    if (!from || !to || !message) {
      res.status(400).json({ error: "Missing required fields: from, to, message" });
      return;
    }

    const webhookPayload = {
      from: from,
      to: to,
      message: message,
      timestamp: timestamp || Math.floor(Date.now() / 1000).toString(),
      type: type || "text"
    };

    // Send to actual webhook
    const response = await fetch(process.env.WEBHOOK_URL || "http://localhost:10022/hra_whatsapp/sub_channel/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(webhookPayload)
    });

    const result = await response.json();

    serverLogger.info("Manual webhook sent:", {
      payload: webhookPayload,
      response: result
    });

    res.json({
      success: true,
      payload: webhookPayload,
      webhookResponse: result
    });
  } catch (error) {
    serverLogger.error("Error sending manual webhook:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

// Root endpoint
app.get("/", (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Health check endpoint
app.get("/health", async (req: Request, res: Response) => {
  try {
    const health = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
      services: {
        whatsapp: whatsappService.getStats().isInitialized
          ? "healthy"
          : "unhealthy",
        database: "healthy",
        webhook: "unknown",
      },
    };

    // Test webhook if requested
    if (req.query.testWebhook === "true") {
      try {
        const webhookTest = await webhookService.testConnection();
        health.services.webhook = webhookTest.success ? "healthy" : "unhealthy";
      } catch (error) {
        health.services.webhook = "unhealthy";
      }
    }

    const isHealthy = Object.values(health.services).every(
      (status) => status === "healthy" || status === "unknown",
    );

    if (isHealthy) {
      res.json(health);
    } else {
      res.status(503).json({
        ...health,
        status: "unhealthy",
      });
    }
  } catch (error) {
    serverLogger.error("Health check failed:", error);
    res.status(503).json({
      status: "unhealthy",
      error: "Health check failed",
    });
  }
});

// API info endpoint
app.get("/api", (req: Request, res: Response) => {
  res.json({
    name: "WhatsApp Multi-Account Server",
    version: "1.0.0",
    description:
      "REST API for managing multiple WhatsApp accounts with Baileys",
    endpoints: {
      accounts: "/api/accounts",
      dashboard: "/api/dashboard",
      health: "/health",
    },
    documentation: "https://github.com/your-repo/wa-server",
    timestamp: new Date().toISOString(),
  });
});

// Catch-all route for SPA
app.get("*", (req: Request, res: Response) => {
  // If it's an API request that doesn't exist, return 404
  if (req.path.startsWith("/api/")) {
    return res.status(404).json(createErrorResponse("API endpoint not found"));
  }

  // Otherwise, serve the main page (for SPA routing)
  return res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Global error handler
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  serverLogger.error("Unhandled error:", {
    error: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
  });

  res
    .status(500)
    .json(
      createErrorResponse(
        NODE_ENV === "production" ? "Internal server error" : error.message,
        "INTERNAL_ERROR",
        NODE_ENV === "development" ? { stack: error.stack } : undefined,
      ),
    );
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json(createErrorResponse("Resource not found"));
});

// Initialize application
async function initializeApp(): Promise<void> {
  try {
    serverLogger.info("Starting WhatsApp Multi-Account Server...");

    // Ensure logs directory exists
    const logsDir = path.join(process.cwd(), "logs");
    try {
      await fs.access(logsDir);
      serverLogger.info(`Logs directory exists: ${logsDir}`);
    } catch {
      await fs.mkdir(logsDir, { recursive: true });
      serverLogger.info(`Created logs directory: ${logsDir}`);
    }

    // Initialize database
    serverLogger.info("Initializing database...");
    try {
      await databaseManager.initialize();
      serverLogger.info("Database initialized successfully");
    } catch (error) {
      serverLogger.error("Database initialization failed:", error);
      throw error;
    }

    // Initialize WhatsApp service
    serverLogger.info("Initializing WhatsApp service...");
    try {
      await whatsappService.initialize();
      serverLogger.info("WhatsApp service initialized successfully");
    } catch (error) {
      serverLogger.error("WhatsApp service initialization failed:", error);
      throw error;
    }

    // Setup WhatsApp service event listeners
    whatsappService.on("qr-generated", (data: { accountId: string }) => {
      serverLogger.info(`QR code generated for account: ${data.accountId}`);
    });

    whatsappService.on(
      "account-connected",
      (data: { accountId: string; phoneNumber: string }) => {
        serverLogger.info(`Account connected: ${data.accountId}`, {
          phoneNumber: data.phoneNumber,
        });
      },
    );

    whatsappService.on(
      "account-disconnected",
      (data: { accountId: string; shouldReconnect: boolean }) => {
        serverLogger.info(`Account disconnected: ${data.accountId}`, {
          shouldReconnect: data.shouldReconnect,
        });
      },
    );

    whatsappService.on(
      "message-received",
      (data: { accountId: string; from: string; type: string }) => {
        serverLogger.debug(`Message received: ${data.accountId}`, {
          from: data.from,
          type: data.type,
        });
      },
    );

    whatsappService.on(
      "message-sent",
      (data: { accountId: string; to: string; type: string }) => {
        serverLogger.debug(`Message sent: ${data.accountId}`, {
          to: data.to,
          type: data.type,
        });
      },
    );

    // Webhook configuration ready (test disabled to prevent test messages)
    serverLogger.info("Webhook service configured", {
      url: webhookService.getConfig().url,
      timeout: webhookService.getConfig().timeout,
      maxRetries: webhookService.getConfig().maxRetries,
    });

    serverLogger.info("Application initialized successfully");
  } catch (error) {
    serverLogger.error("Failed to initialize application:", error);
    console.error("Initialization error details:", error);
    process.exit(1);
  }
}

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  serverLogger.info(`Received ${signal}. Starting graceful shutdown...`);

  try {
    // Stop accepting new connections
    server.close(() => {
      serverLogger.info("HTTP server closed");
    });

    // Shutdown WhatsApp service
    await whatsappService.shutdown();

    // Close database connections
    await databaseManager.close();

    serverLogger.info("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    serverLogger.error("Error during graceful shutdown:", error);
    process.exit(1);
  }
}

// Start server
let server: any;

async function startServer(): Promise<void> {
  try {
    console.log("Starting server initialization...");
    await initializeApp();
    console.log("Server initialization completed");

    server = app.listen(PORT, () => {
      serverLogger.info(`Server started successfully`, {
        port: PORT,
        environment: NODE_ENV,
        webhookUrl: WEBHOOK_URL,
        pid: process.pid,
      });

      console.log(`
╔════════════════════════════════════════════════════════════╗
║              WhatsApp Multi-Account Server                 ║
║                                                            ║
║  🚀 Server running on: http://localhost:${PORT}              ║
║  📱 WhatsApp Service: Initialized                          ║
║  🔄 Webhook URL: ${WEBHOOK_URL.padEnd(38)} ║
║  📊 Dashboard: http://localhost:${PORT}/                     ║
║                                                            ║
║  📋 API Endpoints:                                         ║
║    • GET  /api/accounts           - List accounts         ║
║    • POST /api/accounts           - Create account        ║
║    • GET  /api/accounts/:id/qr    - Get QR code          ║
║    • GET  /api/dashboard/stats    - System stats         ║
║    • GET  /health                 - Health check         ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
      `);
    });

    // Handle server errors
    server.on("error", (error: any) => {
      if (error.code === "EADDRINUSE") {
        serverLogger.error(`Port ${PORT} is already in use`);
      } else {
        serverLogger.error("Server error:", error);
      }
      process.exit(1);
    });

    // Setup graceful shutdown handlers
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

    // Note: Global error handlers are already set up at the top of the file
    // to handle logger.trace errors specifically
  } catch (error) {
    serverLogger.error("Failed to start server:", error);
    console.error("Server startup error:", error);
    process.exit(1);
  }
}

// Start the application
startServer();

// Export app for testing
export default app;
