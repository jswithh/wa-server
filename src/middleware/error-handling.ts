import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { ResponseService } from "../utils/response-service";
import { appConfig } from "../config";
import { getRequestId } from "./request-logging";

/**
 * Standard error types for the application
 */
export enum ErrorType {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  AUTHENTICATION_ERROR = "AUTHENTICATION_ERROR",
  AUTHORIZATION_ERROR = "AUTHORIZATION_ERROR",
  NOT_FOUND_ERROR = "NOT_FOUND_ERROR",
  RATE_LIMIT_ERROR = "RATE_LIMIT_ERROR",
  DATABASE_ERROR = "DATABASE_ERROR",
  WEBHOOK_ERROR = "WEBHOOK_ERROR",
  WHATSAPP_ERROR = "WHATSAPP_ERROR",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR",
}

/**
 * Custom application error class with additional context
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorType: ErrorType;
  public readonly isOperational: boolean;
  public readonly context?: any;

  constructor(
    message: string,
    statusCode: number = 500,
    errorType: ErrorType = ErrorType.INTERNAL_ERROR,
    isOperational: boolean = true,
    context?: any,
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.errorType = errorType;
    this.isOperational = isOperational;
    this.context = context;

    // Ensure the stack trace points to where the error was thrown
    Error.captureStackTrace(this, AppError);
  }
}

/**
 * Factory functions for common error types
 */
export const ErrorFactory = {
  validation: (message: string, context?: any) =>
    new AppError(message, 400, ErrorType.VALIDATION_ERROR, true, context),

  authentication: (
    message: string = "Authentication required",
    context?: any,
  ) =>
    new AppError(message, 401, ErrorType.AUTHENTICATION_ERROR, true, context),

  authorization: (
    message: string = "Insufficient permissions",
    context?: any,
  ) => new AppError(message, 403, ErrorType.AUTHORIZATION_ERROR, true, context),

  notFound: (message: string = "Resource not found", context?: any) =>
    new AppError(message, 404, ErrorType.NOT_FOUND_ERROR, true, context),

  rateLimit: (message: string = "Too many requests", context?: any) =>
    new AppError(message, 429, ErrorType.RATE_LIMIT_ERROR, true, context),

  database: (message: string, context?: any) =>
    new AppError(message, 500, ErrorType.DATABASE_ERROR, true, context),

  webhook: (message: string, context?: any) =>
    new AppError(message, 502, ErrorType.WEBHOOK_ERROR, true, context),

  whatsapp: (message: string, context?: any) =>
    new AppError(message, 500, ErrorType.WHATSAPP_ERROR, true, context),

  externalService: (message: string, context?: any) =>
    new AppError(message, 502, ErrorType.EXTERNAL_SERVICE_ERROR, true, context),

  internal: (message: string = "Internal server error", context?: any) =>
    new AppError(message, 500, ErrorType.INTERNAL_ERROR, false, context),
};

/**
 * Determine if an error is operational (expected) or programming error
 */
function isOperationalError(error: any): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}

/**
 * Log error with appropriate level and context
 */
function logError(error: any, req: Request): void {
  const requestId = getRequestId(req);
  const context = {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get("User-Agent"),
    timestamp: new Date().toISOString(),
  };

  if (error instanceof AppError) {
    const logData = {
      ...context,
      errorType: error.errorType,
      statusCode: error.statusCode,
      isOperational: error.isOperational,
      errorContext: error.context,
      message: error.message,
      stack:
        appConfig.server.nodeEnvironment === "development"
          ? error.stack
          : undefined,
    };

    if (error.statusCode >= 500 || !error.isOperational) {
      logger.error("Application error occurred", logData);
    } else if (error.statusCode >= 400) {
      logger.warn("Client error occurred", logData);
    } else {
      logger.info("Handled error occurred", logData);
    }
  } else {
    // Unknown error type - always log as error
    logger.error("Unhandled error occurred", {
      ...context,
      message: error.message || "Unknown error",
      name: error.name,
      stack: error.stack,
      error: error.toString(),
    });
  }
}

/**
 * Convert various error types to standardized response format
 */
function formatErrorResponse(error: any): any {
  if (error instanceof AppError) {
    return {
      success: false,
      message: error.message,
      error: error.message,
      errorType: error.errorType,
      ...(appConfig.server.nodeEnvironment === "development" && {
        data: {
          statusCode: error.statusCode,
          stack: error.stack,
          context: error.context,
        },
      }),
      metadata: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Handle Joi validation errors
  if (error.name === "ValidationError") {
    return {
      success: false,
      message: error.message,
      error: error.message,
      errorType: ErrorType.VALIDATION_ERROR,
      metadata: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  if (error.name === "CastError") {
    return {
      success: false,
      message: "Invalid data format provided",
      error: "Invalid data format provided",
      errorType: ErrorType.VALIDATION_ERROR,
      metadata: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  if (error.code === "ECONNREFUSED") {
    return {
      success: false,
      message: "External service unavailable",
      error: "External service unavailable",
      errorType: ErrorType.EXTERNAL_SERVICE_ERROR,
      metadata: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  if (error.code === "ENOTFOUND") {
    return {
      success: false,
      message: "External service not found",
      error: "External service not found",
      errorType: ErrorType.EXTERNAL_SERVICE_ERROR,
      metadata: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Default error response
  const message =
    appConfig.server.nodeEnvironment === "development"
      ? error.message || "Unknown error"
      : error.message || "Unknown error";

  return {
    success: false,
    message: message,
    error: message,
    errorType: ErrorType.INTERNAL_ERROR,
    ...(appConfig.server.nodeEnvironment === "development" && {
      data: {
        stack: error.stack,
      },
    }),
    metadata: {
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Main error handling middleware
 */
export function createErrorHandler() {
  return (
    error: any,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    // Log the error with context
    logError(error, req);

    // Don't send response if headers were already sent
    if (res.headersSent) {
      logger.warn(
        "Headers already sent, delegating to default Express error handler",
        {
          requestId: getRequestId(req),
          error: error.message,
        },
      );
      return next(error);
    }

    // Determine status code
    let statusCode = 500;
    if (error instanceof AppError) {
      statusCode = error.statusCode;
    } else if (error.status || error.statusCode) {
      statusCode = error.status || error.statusCode;
    }

    // Format error response
    const errorResponse = formatErrorResponse(error);

    // Add request ID to response if available
    const requestId = getRequestId(req);
    if (requestId) {
      res.setHeader("X-Request-ID", requestId);
    }

    // Send error response
    res.status(statusCode).json(errorResponse);

    // For non-operational errors in production, we might want to restart the process
    if (
      !isOperationalError(error) &&
      appConfig.server.nodeEnvironment === "production"
    ) {
      logger.error("Non-operational error detected in production", {
        error: error.message,
        stack: error.stack,
        shouldRestart: true,
      });

      // Uncomment the following lines if you want to restart on programming errors
      // setTimeout(() => {
      //   process.exit(1);
      // }, 1000);
    }
  };
}

/**
 * 404 Not Found handler middleware
 */
export function createNotFoundHandler() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = getRequestId(req);

    // Log 404 for debugging
    logger.warn("Route not found", {
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get("User-Agent"),
    });

    // Check if it's an API request
    if (req.path.startsWith("/api/")) {
      const error = ErrorFactory.notFound("API endpoint not found");
      return next(error);
    }

    // For non-API requests, might be SPA routing - handled elsewhere
    const error = ErrorFactory.notFound("Page not found");
    next(error);
  };
}

/**
 * Async error handler wrapper for route handlers
 */
export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Helper function to handle unhandled promise rejections
 */
export function setupGlobalErrorHandlers(): void {
  process.on("unhandledRejection", (reason: any, promise: Promise<any>) => {
    logger.error("Unhandled Promise Rejection", {
      reason: reason?.message || reason,
      stack: reason?.stack,
      promise: promise.toString(),
    });

    // Don't exit the process immediately - let the error handler deal with it
    if (reason instanceof Error) {
      console.error("Unhandled rejection details:", reason);
    }
  });

  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught Exception", {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });

    // For uncaught exceptions, we should exit as the application state is unknown
    console.error("Uncaught exception - shutting down:", error);
    process.exit(1);
  });

  logger.info("Global error handlers configured");
}
