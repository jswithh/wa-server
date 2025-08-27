/**
 * WhatsApp Multi-Account Server
 * Refactored main entry point with proper separation of concerns
 *
 * This file now focuses only on:
 * - Express app setup
 * - Middleware configuration
 * - Route registration
 * - Server startup and shutdown
 */

import express from "express";
import path from "path";
import { appConfig } from "./config";
import { logger } from "./utils/logger";
import {
  initializeApplication,
  shutdownApplication,
  performHealthCheck,
} from "./config/initialization";
import { ResponseService, ResponseOptions } from "./utils/response-service";
import { getRequestId } from "./middleware/request-logging";

// Middleware imports
import {
  createSecurityMiddleware,
  createCorsMiddleware,
  configureTrustProxy,
  securityHeadersMiddleware,
} from "./middleware/security";
import { createRateLimitMiddleware } from "./middleware/rate-limiting";
import {
  createRequestLoggingMiddleware,
  addRequestIdHeader,
} from "./middleware/request-logging";
import {
  createErrorHandler,
  createNotFoundHandler,
} from "./middleware/error-handling";

// Route imports
import accountsRouter from "./routes/accounts";
import dashboardRouter from "./routes/dashboard";
import deduplicationRouter from "./routes/deduplication";
import messagesRouter from "./routes/messages";
import webhooksRouter from "./routes/webhooks";

/**
 * Create and configure Express application
 */
function createExpressApp(): express.Application {
  const app = express();

  // Configure trust proxy
  configureTrustProxy(app);

  // Security middleware
  app.use(createSecurityMiddleware());
  app.use(createCorsMiddleware());
  app.use(securityHeadersMiddleware);

  // Body parsing middleware
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Request logging and ID tracking
  app.use(createRequestLoggingMiddleware());
  app.use(addRequestIdHeader);

  // Rate limiting
  app.use(createRateLimitMiddleware());

  // Serve static files
  app.use(express.static(path.join(__dirname, "../public")));

  return app;
}

/**
 * Register all application routes
 */
function registerRoutes(app: express.Application): void {
  // API Routes
  app.use("/api/accounts", accountsRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/deduplication", deduplicationRouter);
  app.use("/api/messages", messagesRouter);
  app.use("/api/webhooks", webhooksRouter);

  // Root endpoint
  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
  });

  // Health check endpoint
  app.get("/health", async (req, res) => {
    try {
      const healthStatus = await performHealthCheck();

      const requestId = getRequestId(req);
      ResponseService.health(res, healthStatus.status, healthStatus, {
        ...(requestId && { requestId }),
      });
    } catch (error) {
      logger.error("Health check failed:", error);
      const requestId = getRequestId(req);
      ResponseService.serviceUnavailable(res, "Health check failed", {
        ...(requestId && { requestId }),
      });
    }
  });

  // API info endpoint
  app.get("/api", (req, res) => {
    const requestId = getRequestId(req);
    const options: ResponseOptions = {
      includeVersion: true,
    };
    if (requestId) {
      options.requestId = requestId;
    }

    ResponseService.success(
      res,
      {
        name: "WhatsApp Multi-Account Server",
        version: "1.0.0",
        description:
          "REST API for managing multiple WhatsApp accounts with Baileys",
        environment: appConfig.server.nodeEnvironment,
        endpoints: {
          accounts: "/api/accounts",
          messages: "/api/messages",
          webhooks: "/api/webhooks",
          dashboard: "/api/dashboard",
          health: "/health",
        },
        documentation: "https://github.com/your-repo/wa-server",
        timestamp: new Date().toISOString(),
      },
      "API information retrieved successfully",
      options,
    );
  });

  // Catch-all route for SPA
  app.get("*", (req, res) => {
    // If it's an API request that doesn't exist, let 404 handler deal with it
    if (req.path.startsWith("/api/")) {
      const requestId = getRequestId(req);
      return ResponseService.notFound(res, "API endpoint not found", {
        ...(requestId && { requestId }),
      });
    }

    // Otherwise, serve the main page (for SPA routing)
    return res.sendFile(path.join(__dirname, "../public/index.html"));
  });
}

/**
 * Register error handling middleware (must be last)
 */
function registerErrorHandlers(app: express.Application): void {
  // 404 handler
  app.use(createNotFoundHandler());

  // Global error handler
  app.use(createErrorHandler());
}

/**
 * Display startup banner with server information
 */
function displayStartupBanner(): void {
  const banner = `
╔════════════════════════════════════════════════════════════╗
║              WhatsApp Multi-Account Server                 ║
║                                                            ║
║  🚀 Server running on: http://localhost:${appConfig.server.port.toString().padEnd(4)}              ║
║  📱 WhatsApp Service: Initialized                          ║
║  🔄 Webhook URL: ${appConfig.webhook.url.substring(0, 38).padEnd(38)} ║
║  📊 Dashboard: http://localhost:${appConfig.server.port}/                     ║
║  🌍 Environment: ${appConfig.server.nodeEnvironment.padEnd(11)}                          ║
║                                                            ║
║  📋 API Endpoints:                                         ║
║    • GET  /api/accounts           - List accounts         ║
║    • POST /api/accounts           - Create account        ║
║    • GET  /api/accounts/:id/qr    - Get QR code          ║
║    • GET  /api/messages           - List messages         ║
║    • POST /api/messages/test      - Send test message     ║
║    • POST /api/webhooks/send      - Send webhook          ║
║    • GET  /api/dashboard/stats    - System stats         ║
║    • GET  /health                 - Health check         ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `;
  console.log(banner);
}

/**
 * Start the server
 */
async function startServer(): Promise<void> {
  let server: any;

  try {
    console.log("Starting server initialization...");

    // Initialize application (database, services, etc.)
    const initResult = await initializeApplication();

    if (!initResult.success) {
      logger.error("Server initialization failed", {
        errors: initResult.errors,
        warnings: initResult.warnings,
        duration: initResult.duration,
      });

      console.error("❌ Server initialization failed:");
      initResult.errors.forEach((error) => console.error(`  - ${error}`));
      process.exit(1);
    }

    if (initResult.warnings.length > 0) {
      console.warn("⚠️  Server started with warnings:");
      initResult.warnings.forEach((warning) => console.warn(`  - ${warning}`));
    }

    console.log("✅ Server initialization completed successfully");

    // Create and configure Express app
    const app = createExpressApp();

    // Register routes
    registerRoutes(app);

    // Register error handlers (must be last)
    registerErrorHandlers(app);

    // Start HTTP server
    server = app.listen(appConfig.server.port, () => {
      logger.info("Server started successfully", {
        port: appConfig.server.port,
        environment: appConfig.server.nodeEnvironment,
        webhookUrl: appConfig.webhook.url,
        pid: process.pid,
        nodeVersion: process.version,
        initDuration: initResult.duration,
      });

      displayStartupBanner();
    });

    // Handle server errors
    server.on("error", (error: any) => {
      if (error.code === "EADDRINUSE") {
        logger.error(`Port ${appConfig.server.port} is already in use`);
        console.error(`❌ Port ${appConfig.server.port} is already in use`);
      } else {
        logger.error("Server error occurred:", error);
        console.error("❌ Server error:", error.message);
      }
      process.exit(1);
    });

    // Setup graceful shutdown handlers
    const handleShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Starting graceful shutdown...`);
      console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);

      // Stop accepting new connections
      if (server) {
        server.close(() => {
          logger.info("HTTP server closed");
          console.log("✅ HTTP server closed");
        });
      }

      try {
        // Shutdown application services
        await shutdownApplication(signal);
        console.log("✅ Application shutdown completed");
        process.exit(0);
      } catch (error) {
        logger.error("Error during graceful shutdown:", error);
        console.error("❌ Error during shutdown:", error);
        process.exit(1);
      }
    };

    // Register shutdown handlers
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
    process.on("SIGINT", () => handleShutdown("SIGINT"));

    // Handle uncaught exceptions and unhandled rejections
    // Note: Global error handlers are set up in initialization module
  } catch (error) {
    logger.error("Failed to start server:", error);
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Start the application
startServer();

// Export app for testing purposes
export default createExpressApp;
