/**
 * Application initialization module
 * Handles the startup sequence for the WhatsApp Multi-Account Server
 */

import path from "path";
import fs from "fs/promises";
import { databaseManager } from "../models/database";
import { whatsappService } from "../services/whatsapp";
import { webhookService } from "../services/webhook";
import { logger } from "../utils/logger";
import { appConfig } from "./index";
import { setupGlobalErrorHandlers } from "../middleware/error-handling";

export interface InitializationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  startTime: Date;
  endTime: Date;
  duration: number;
}

export interface ServiceStatus {
  database: boolean;
  whatsapp: boolean;
  webhook: boolean;
  filesystem: boolean;
}

/**
 * Initialize the application with proper error handling and logging
 */
export async function initializeApplication(): Promise<InitializationResult> {
  const startTime = new Date();
  const errors: string[] = [];
  const warnings: string[] = [];

  logger.info("Starting WhatsApp Multi-Account Server initialization...", {
    environment: appConfig.server.nodeEnvironment,
    port: appConfig.server.port,
    webhookUrl: appConfig.webhook.url,
    startTime: startTime.toISOString(),
  });

  try {
    // Setup global error handlers first
    setupGlobalErrorHandlers();
    logger.info("Global error handlers configured");

    // Initialize filesystem structure
    await initializeFilesystem();
    logger.info("Filesystem structure verified");

    // Initialize database
    await initializeDatabase();
    logger.info("Database initialization completed");

    // Initialize WhatsApp service
    await initializeWhatsAppService();
    logger.info("WhatsApp service initialization completed");

    // Configure webhook service
    await initializeWebhookService();
    logger.info("Webhook service configuration completed");

    // Setup service event listeners
    setupServiceEventListeners();
    logger.info("Service event listeners configured");

    const endTime = new Date();
    const duration = endTime.getTime() - startTime.getTime();

    logger.info("Application initialization completed successfully", {
      duration: `${duration}ms`,
      endTime: endTime.toISOString(),
    });

    return {
      success: true,
      errors,
      warnings,
      startTime,
      endTime,
      duration,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown initialization error";
    errors.push(errorMessage);

    const endTime = new Date();
    const duration = endTime.getTime() - startTime.getTime();

    logger.error("Application initialization failed", {
      error: errorMessage,
      duration: `${duration}ms`,
      errors,
      warnings,
    });

    return {
      success: false,
      errors,
      warnings,
      startTime,
      endTime,
      duration,
    };
  }
}

/**
 * Initialize filesystem structure (logs, sessions, etc.)
 */
async function initializeFilesystem(): Promise<void> {
  const requiredDirectories = [
    appConfig.logging.directory,
    path.join(process.cwd(), "sessions"),
    path.join(process.cwd(), "public"),
    path.join(process.cwd(), "dist"),
  ];

  for (const directory of requiredDirectories) {
    try {
      await fs.access(directory);
      logger.debug(`Directory exists: ${directory}`);
    } catch {
      await fs.mkdir(directory, { recursive: true });
      logger.info(`Created directory: ${directory}`);
    }
  }

  // Verify write permissions
  const testFile = path.join(appConfig.logging.directory, ".write-test");
  try {
    await fs.writeFile(testFile, "test");
    await fs.unlink(testFile);
    logger.debug("Filesystem write permissions verified");
  } catch (error) {
    throw new Error(
      `Insufficient write permissions in ${appConfig.logging.directory}: ${error}`,
    );
  }
}

/**
 * Initialize database connection and schema
 */
async function initializeDatabase(): Promise<void> {
  try {
    await databaseManager.initialize();

    // Test database connectivity
    const testQuery = await databaseManager
      .getDatabase()
      .get("SELECT 1 as test");
    if (!testQuery || testQuery.test !== 1) {
      throw new Error("Database connectivity test failed");
    }

    // Get database statistics
    const stats = await databaseManager.getStats();
    logger.info("Database connection established", {
      path: appConfig.database.path,
      totalAccounts: stats.totalAccounts,
      totalMessages: stats.totalMessages,
      pendingWebhooks: stats.pendingWebhooks,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown database error";
    logger.error("Database initialization failed", { error: errorMessage });
    throw new Error(`Database initialization failed: ${errorMessage}`);
  }
}

/**
 * Initialize WhatsApp service
 */
async function initializeWhatsAppService(): Promise<void> {
  try {
    await whatsappService.initialize();

    // Get service status
    const stats = whatsappService.getStats();
    logger.info("WhatsApp service initialized", {
      isInitialized: stats.isInitialized,
      connectedAccounts: stats.connectedAccounts,
      totalAccounts: stats.totalAccounts,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown WhatsApp service error";
    logger.error("WhatsApp service initialization failed", {
      error: errorMessage,
    });
    throw new Error(`WhatsApp service initialization failed: ${errorMessage}`);
  }
}

/**
 * Initialize webhook service
 */
async function initializeWebhookService(): Promise<void> {
  try {
    // Test webhook connectivity (optional, don't fail if webhook is down)
    try {
      const testResult = await webhookService.testConnection();
      if (testResult.success) {
        logger.info("Webhook service connectivity verified", {
          url: appConfig.webhook.url,
          responseTime: testResult.responseTime,
        });
      } else {
        logger.warn("Webhook service test failed (service will continue)", {
          url: appConfig.webhook.url,
          error: testResult.error,
        });
      }
    } catch (webhookError) {
      logger.warn("Webhook connectivity test failed (service will continue)", {
        url: appConfig.webhook.url,
        error:
          webhookError instanceof Error
            ? webhookError.message
            : "Unknown error",
      });
    }

    logger.info("Webhook service configured", {
      url: appConfig.webhook.url,
      timeout: appConfig.webhook.timeout,
      retryAttempts: appConfig.webhook.retryAttempts,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown webhook service error";
    logger.error("Webhook service initialization failed", {
      error: errorMessage,
    });
    throw new Error(`Webhook service initialization failed: ${errorMessage}`);
  }
}

/**
 * Setup event listeners for various services
 */
function setupServiceEventListeners(): void {
  // WhatsApp service events
  whatsappService.on("qr-generated", (data: { accountId: string }) => {
    logger.info("QR code generated", {
      accountId: data.accountId,
      event: "qr-generated",
    });
  });

  whatsappService.on(
    "account-connected",
    (data: { accountId: string; phoneNumber: string }) => {
      logger.info("WhatsApp account connected", {
        accountId: data.accountId,
        phoneNumber: data.phoneNumber,
        event: "account-connected",
      });
    },
  );

  whatsappService.on(
    "account-disconnected",
    (data: { accountId: string; shouldReconnect: boolean }) => {
      logger.warn("WhatsApp account disconnected", {
        accountId: data.accountId,
        shouldReconnect: data.shouldReconnect,
        event: "account-disconnected",
      });
    },
  );

  whatsappService.on(
    "message-received",
    (data: { accountId: string; from: string; type: string }) => {
      logger.debug("Message received", {
        accountId: data.accountId,
        from: data.from,
        type: data.type,
        event: "message-received",
      });
    },
  );

  whatsappService.on(
    "message-sent",
    (data: { accountId: string; to: string; type: string }) => {
      logger.debug("Message sent", {
        accountId: data.accountId,
        to: data.to,
        type: data.type,
        event: "message-sent",
      });
    },
  );

  // Database events would be configured here if available
  // Currently the database manager doesn't emit events

  logger.debug("Service event listeners configured");
}

/**
 * Get current status of all services
 */
export async function getServiceStatus(): Promise<ServiceStatus> {
  const status: ServiceStatus = {
    database: false,
    whatsapp: false,
    webhook: false,
    filesystem: false,
  };

  // Check database
  try {
    await databaseManager.getDatabase().get("SELECT 1");
    status.database = true;
  } catch {
    status.database = false;
  }

  // Check WhatsApp service
  try {
    const stats = whatsappService.getStats();
    status.whatsapp = stats.isInitialized;
  } catch {
    status.whatsapp = false;
  }

  // Check webhook service
  try {
    const testResult = await webhookService.testConnection();
    status.webhook = testResult.success;
  } catch {
    status.webhook = false;
  }

  // Check filesystem
  try {
    await fs.access(appConfig.logging.directory);
    status.filesystem = true;
  } catch {
    status.filesystem = false;
  }

  return status;
}

/**
 * Graceful shutdown of all services
 */
export async function shutdownApplication(signal: string): Promise<void> {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  const shutdownPromises: Promise<void>[] = [];

  // Shutdown WhatsApp service
  shutdownPromises.push(
    whatsappService.shutdown().catch((error) => {
      logger.error("Error shutting down WhatsApp service:", error);
    }),
  );

  // Close database connections
  shutdownPromises.push(
    databaseManager.close().catch((error) => {
      logger.error("Error closing database connections:", error);
    }),
  );

  // Wait for all shutdown operations to complete
  try {
    await Promise.allSettled(shutdownPromises);
    logger.info("All services shut down successfully");
  } catch (error) {
    logger.error("Error during service shutdown:", error);
  }

  logger.info("Graceful shutdown completed");
}

/**
 * Health check for the application
 */
export async function performHealthCheck(): Promise<{
  status: "healthy" | "unhealthy" | "degraded";
  services: ServiceStatus;
  uptime: number;
  memory: NodeJS.MemoryUsage;
  timestamp: string;
}> {
  const services = await getServiceStatus();
  const uptime = process.uptime();
  const memory = process.memoryUsage();

  // Determine overall status
  let status: "healthy" | "unhealthy" | "degraded" = "healthy";

  if (!services.database || !services.whatsapp) {
    status = "unhealthy";
  } else if (!services.webhook || !services.filesystem) {
    status = "degraded";
  }

  return {
    status,
    services,
    uptime,
    memory,
    timestamp: new Date().toISOString(),
  };
}
