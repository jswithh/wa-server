/**
 * Centralized configuration module for the WhatsApp Multi-Account Server
 * This module consolidates all environment variables and application settings
 * into a single, typed configuration object.
 */

export interface ServerConfig {
  port: number;
  nodeEnvironment: "development" | "production" | "test";
  trustProxy: boolean;
}

export interface SecurityConfig {
  corsOrigins: boolean | string[];
  enableCredentials: boolean;
  rateLimiting: {
    windowMs: number;
    maxRequests: number;
    cleanupIntervalMs: number;
  };
}

export interface WebhookConfig {
  url: string;
  timeout: number;
  retryAttempts: number;
  retryDelayMs: number;
}

export interface DatabaseConfig {
  path: string;
  backupEnabled: boolean;
  backupIntervalMs: number;
}

export interface LoggingConfig {
  level: string;
  directory: string;
  maxFiles: number;
  maxSize: string;
}

export interface WhatsAppConfig {
  autoConnectExistingAccounts: boolean;
  historyThresholdMinutes: number;
  enableHistoryFilter: boolean;
  skipGroupMessages: boolean;
  skipEmptyMessages: boolean;
  maxMessageAgeHours: number;
  zeroToleranceMode: boolean;
  zeroToleranceMaxAgeSeconds: number;
  maxTransactionRetries: number;
  transactionDelayMs: number;
}

export interface ApplicationConfig {
  server: ServerConfig;
  security: SecurityConfig;
  webhook: WebhookConfig;
  database: DatabaseConfig;
  logging: LoggingConfig;
  whatsapp: WhatsAppConfig;
}

/**
 * Parse and validate port number from environment variable
 */
function parsePort(
  portString: string | undefined,
  defaultPort: number,
): number {
  if (!portString) return defaultPort;

  const port = parseInt(portString, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    console.warn(`Invalid port "${portString}", using default: ${defaultPort}`);
    return defaultPort;
  }

  return port;
}

/**
 * Parse CORS origins from environment variable
 */
function parseCorsOrigins(nodeEnv: string): boolean | string[] {
  const corsOrigins = process.env.CORS_ORIGINS;

  if (nodeEnv === "production") {
    if (!corsOrigins) {
      return false; // No origins allowed in production by default
    }
    return corsOrigins.split(",").map((origin) => origin.trim());
  }

  return true; // Allow all origins in development
}

/**
 * Get the current application configuration
 */
export function getConfig(): ApplicationConfig {
  const nodeEnvironment = (process.env.NODE_ENV || "development") as
    | "development"
    | "production"
    | "test";

  return {
    server: {
      port: parsePort(process.env.PORT, 3000),
      nodeEnvironment,
      trustProxy:
        process.env.TRUST_PROXY === "true" || nodeEnvironment === "production",
    },

    security: {
      corsOrigins: parseCorsOrigins(nodeEnvironment),
      enableCredentials: true,
      rateLimiting: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000", 10), // 15 minutes
        maxRequests: parseInt(
          process.env.RATE_LIMIT_MAX_REQUESTS || "1000",
          10,
        ),
        cleanupIntervalMs: parseInt(
          process.env.RATE_LIMIT_CLEANUP_MS || "300000",
          10,
        ), // 5 minutes
      },
    },

    webhook: {
      url:
        process.env.WEBHOOK_URL ||
        "http://localhost:10022/hra_whatsapp/sub_channel/webhook",
      timeout: parseInt(process.env.WEBHOOK_TIMEOUT_MS || "30000", 10),
      retryAttempts: parseInt(process.env.WEBHOOK_RETRY_ATTEMPTS || "3", 10),
      retryDelayMs: parseInt(process.env.WEBHOOK_RETRY_DELAY_MS || "1000", 10),
    },

    database: {
      path: process.env.DATABASE_PATH || "./database.sqlite",
      backupEnabled: process.env.DATABASE_BACKUP_ENABLED === "true",
      backupIntervalMs: parseInt(
        process.env.DATABASE_BACKUP_INTERVAL_MS || "3600000",
        10,
      ), // 1 hour
    },

    logging: {
      level:
        process.env.LOG_LEVEL ||
        (nodeEnvironment === "production" ? "info" : "debug"),
      directory: process.env.LOG_DIRECTORY || "./logs",
      maxFiles: parseInt(process.env.LOG_MAX_FILES || "14", 10),
      maxSize: process.env.LOG_MAX_SIZE || "20m",
    },

    whatsapp: {
      autoConnectExistingAccounts:
        process.env.WA_AUTO_CONNECT_EXISTING === "true",
      historyThresholdMinutes: parseInt(
        process.env.WA_HISTORY_THRESHOLD_MINUTES || "10",
        10,
      ),
      enableHistoryFilter: process.env.WA_ENABLE_HISTORY_FILTER !== "false", // Default true
      skipGroupMessages: process.env.WA_SKIP_GROUP_MESSAGES !== "false", // Default true
      skipEmptyMessages: process.env.WA_SKIP_EMPTY_MESSAGES !== "false", // Default true
      maxMessageAgeHours: parseInt(
        process.env.WA_MAX_MESSAGE_AGE_HOURS || "1",
        10,
      ),
      zeroToleranceMode: process.env.WA_ZERO_TOLERANCE_MODE !== "false", // Default true
      zeroToleranceMaxAgeSeconds: parseInt(
        process.env.WA_ZERO_TOLERANCE_MAX_AGE_SECONDS || "30",
        10,
      ),
      maxTransactionRetries: parseInt(
        process.env.WA_MAX_TRANSACTION_RETRIES || "3",
        10,
      ),
      transactionDelayMs: parseInt(
        process.env.WA_TRANSACTION_DELAY_MS || "1000",
        10,
      ),
    },
  };
}

/**
 * Validate the configuration and log warnings for missing or invalid values
 */
export function validateConfig(config: ApplicationConfig): void {
  const warnings: string[] = [];

  // Validate webhook URL
  if (!config.webhook.url.startsWith("http")) {
    warnings.push(`Invalid webhook URL: ${config.webhook.url}`);
  }

  // Validate rate limiting
  if (config.security.rateLimiting.maxRequests <= 0) {
    warnings.push("Rate limiting max requests must be positive");
  }

  // Validate timeout values
  if (config.webhook.timeout <= 0) {
    warnings.push("Webhook timeout must be positive");
  }

  // Log warnings
  if (warnings.length > 0) {
    console.warn("Configuration warnings:");
    warnings.forEach((warning) => console.warn(`  - ${warning}`));
  }
}

// Export the default configuration instance
export const appConfig = getConfig();

// Validate configuration on module load
validateConfig(appConfig);
