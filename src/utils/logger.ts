import winston from "winston";
import path from "path";

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), "logs");

// Define custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: "YYYY-MM-DD HH:mm:ss",
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.prettyPrint(),
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: "HH:mm:ss",
  }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let metaStr = "";
    if (Object.keys(meta).length > 0) {
      metaStr = "\n" + JSON.stringify(meta, null, 2);
    }
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  }),
);

// Create the logger
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: logFormat,
  defaultMeta: { service: "wa-server" },
  transports: [
    // Write all logs to combined.log
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 5242880, // 5MB (reduced from 10MB)
      maxFiles: 3, // reduced from 5
      format: logFormat,
    }),

    // Write all logs to combined.log
    new winston.transports.File({
      filename: path.join(logsDir, "combined.log"),
      maxsize: 5242880, // 5MB (reduced from 10MB)
      maxFiles: 3, // reduced from 5
      format: logFormat,
    }),

    // Write warnings and errors to separate file
    new winston.transports.File({
      filename: path.join(logsDir, "warnings.log"),
      level: "warn",
      maxsize: 2621440, // 2.5MB (reduced from 5MB)
      maxFiles: 2, // reduced from 3
      format: logFormat,
    }),
  ],

  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, "exceptions.log"),
      maxsize: 10485760, // 10MB
      maxFiles: 3,
    }),
  ],

  // Handle unhandled promise rejections
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, "rejections.log"),
      maxsize: 10485760, // 10MB
      maxFiles: 3,
    }),
  ],
});

// Add comprehensive trace method for Baileys compatibility
(logger as any).trace = function (message: string, ...args: any[]) {
  try {
    if (typeof message === "string") {
      logger.debug(`[TRACE] ${message}`, ...args);
    } else {
      logger.debug("[TRACE]", message, ...args);
    }
  } catch (error) {
    console.warn("Main logger trace failed:", error);
  }
};

// Ensure trace is properly defined as a method
Object.defineProperty(logger, "trace", {
  value: (logger as any).trace,
  writable: true,
  enumerable: true,
  configurable: true,
});

// Add console transport for development
if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: consoleFormat,
      level: "debug",
    }),
  );
}

// Create specific loggers for different components
export const whatsappLogger = logger.child({ component: "whatsapp" });
export const webhookLogger = logger.child({ component: "webhook" });

// Optimized Baileys-compatible logger (eliminates redundant wrapper functions)
export const baileysLogger = {
  level: process.env.LOG_LEVEL || "info",
  error: whatsappLogger.error.bind(whatsappLogger),
  warn: whatsappLogger.warn.bind(whatsappLogger),
  info: whatsappLogger.info.bind(whatsappLogger),
  debug: whatsappLogger.debug.bind(whatsappLogger),
  trace: (obj: unknown, msg?: string) => {
    if (typeof obj === "string") {
      whatsappLogger.debug(`[TRACE] ${obj}`, msg);
    } else {
      whatsappLogger.debug(`[TRACE] ${msg || "Trace"}`, obj);
    }
  },
  child: () => baileysLogger,
};

// Helper function to log WhatsApp events
export const logWhatsAppEvent = (
  accountId: string,
  event: string,
  data?: any,
) => {
  whatsappLogger.info(`[${accountId}] ${event}`, data);
};

// Helper function to log webhook attempts
export const logWebhookAttempt = (
  messageId: string,
  url: string,
  success: boolean,
  error?: any,
) => {
  if (success) {
    webhookLogger.info(
      `Webhook sent successfully for message ${messageId} to ${url}`,
    );
  } else {
    webhookLogger.error(`Webhook failed for message ${messageId} to ${url}`, {
      error,
    });
  }
};

export default logger;
