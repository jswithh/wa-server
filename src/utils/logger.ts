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
export const dbLogger = logger.child({ component: "database" });
export const serverLogger = logger.child({ component: "server" });

// Add comprehensive trace method to child loggers for Baileys compatibility
(whatsappLogger as any).trace = (message: string, ...args: any[]) => {
  try {
    whatsappLogger.debug(`[TRACE] ${message}`, ...args);
  } catch (error) {
    console.warn("WhatsApp logger trace failed:", error);
  }
};
(webhookLogger as any).trace = (message: string, ...args: any[]) => {
  try {
    webhookLogger.debug(`[TRACE] ${message}`, ...args);
  } catch (error) {
    console.warn("Webhook logger trace failed:", error);
  }
};
(dbLogger as any).trace = (message: string, ...args: any[]) => {
  try {
    dbLogger.debug(`[TRACE] ${message}`, ...args);
  } catch (error) {
    console.warn("DB logger trace failed:", error);
  }
};
(serverLogger as any).trace = (message: string, ...args: any[]) => {
  try {
    serverLogger.debug(`[TRACE] ${message}`, ...args);
  } catch (error) {
    console.warn("Server logger trace failed:", error);
  }
};

// Enhanced Baileys-compatible logger with comprehensive error handling
export const baileysLogger = {
  level: process.env.LOG_LEVEL || "info",
  error: (obj: unknown, msg?: string) => {
    try {
      if (typeof obj === "string") {
        whatsappLogger.error(obj, msg);
      } else {
        whatsappLogger.error(msg || "Error", obj);
      }
    } catch (error) {
      console.error("Baileys logger error:", error);
    }
  },
  warn: (obj: unknown, msg?: string) => {
    try {
      if (typeof obj === "string") {
        whatsappLogger.warn(obj, msg);
      } else {
        whatsappLogger.warn(msg || "Warning", obj);
      }
    } catch (error) {
      console.error("Baileys logger warn error:", error);
    }
  },
  info: (obj: unknown, msg?: string) => {
    try {
      if (typeof obj === "string") {
        whatsappLogger.info(obj, msg);
      } else {
        whatsappLogger.info(msg || "Info", obj);
      }
    } catch (error) {
      console.error("Baileys logger info error:", error);
    }
  },
  debug: (obj: unknown, msg?: string) => {
    try {
      if (typeof obj === "string") {
        whatsappLogger.debug(obj, msg);
      } else {
        whatsappLogger.debug(msg || "Debug", obj);
      }
    } catch (error) {
      console.error("Baileys logger debug error:", error);
    }
  },
  trace: function (obj: unknown, msg?: string) {
    // Explicitly handle trace calls to prevent Baileys errors
    try {
      if (typeof obj === "string") {
        whatsappLogger.debug(`[TRACE] ${obj}`, msg);
      } else {
        whatsappLogger.debug(`[TRACE] ${msg || "Trace"}`, obj);
      }
    } catch (error) {
      console.warn("Trace logging failed:", error);
    }
  },
  child: (obj: Record<string, unknown>) => {
    const childLogger = whatsappLogger.child(obj);
    return {
      level: process.env.LOG_LEVEL || "info",
      error: (obj: unknown, msg?: string) => {
        if (typeof obj === "string") {
          childLogger.error(obj, msg);
        } else {
          childLogger.error(msg || "Error", obj);
        }
      },
      warn: (obj: unknown, msg?: string) => {
        if (typeof obj === "string") {
          childLogger.warn(obj, msg);
        } else {
          childLogger.warn(msg || "Warning", obj);
        }
      },
      info: (obj: unknown, msg?: string) => {
        if (typeof obj === "string") {
          childLogger.info(obj, msg);
        } else {
          childLogger.info(msg || "Info", obj);
        }
      },
      debug: (obj: unknown, msg?: string) => {
        if (typeof obj === "string") {
          childLogger.debug(obj, msg);
        } else {
          childLogger.debug(msg || "Debug", obj);
        }
      },
      trace: function (obj: unknown, msg?: string) {
        // Explicitly handle trace calls for child loggers
        try {
          if (typeof obj === "string") {
            childLogger.debug(`[TRACE] ${obj}`, msg);
          } else {
            childLogger.debug(`[TRACE] ${msg || "Trace"}`, obj);
          }
        } catch (error) {
          console.warn("Child trace logging failed:", error);
        }
      },
      child: (obj: Record<string, unknown>) => baileysLogger.child(obj),
    };
  },
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

// Helper function to log database operations
export const logDatabaseOperation = (
  operation: string,
  success: boolean,
  data?: any,
  error?: any,
) => {
  if (success) {
    dbLogger.debug(`Database operation: ${operation}`, data);
  } else {
    dbLogger.error(`Database operation failed: ${operation}`, { data, error });
  }
};

export default logger;
