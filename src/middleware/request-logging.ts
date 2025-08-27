import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { appConfig } from "../config";

interface RequestLogData {
  method: string;
  path: string;
  query: any;
  body?: any;
  headers: any;
  ip: string;
  userAgent: string | undefined;
  startTime: number;
  requestId: string;
}

interface ResponseLogData {
  statusCode: number;
  duration: number;
  responseSize: number | undefined;
  contentType: string | undefined;
}

/**
 * Generate a unique request ID for tracking
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Sanitize request body for logging (remove sensitive data)
 */
function sanitizeRequestBody(body: any): any {
  if (!body || typeof body !== "object") {
    return body;
  }

  const sensitiveFields = [
    "password",
    "token",
    "authorization",
    "apiKey",
    "secret",
  ];
  const sanitized = { ...body };

  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = "[REDACTED]";
    }
  }

  // Recursively sanitize nested objects
  for (const key in sanitized) {
    if (typeof sanitized[key] === "object" && sanitized[key] !== null) {
      sanitized[key] = sanitizeRequestBody(sanitized[key]);
    }
  }

  return sanitized;
}

/**
 * Sanitize headers for logging (remove sensitive headers)
 */
function sanitizeHeaders(headers: any): any {
  const sensitiveHeaders = [
    "authorization",
    "cookie",
    "x-api-key",
    "x-auth-token",
  ];
  const sanitized = { ...headers };

  for (const header of sensitiveHeaders) {
    if (sanitized[header]) {
      sanitized[header] = "[REDACTED]";
    }
  }

  return sanitized;
}

/**
 * Determine if request should be logged based on path and environment
 */
function shouldLogRequest(req: Request): boolean {
  const path = req.path;

  // Skip logging for static assets in production
  if (appConfig.server.nodeEnvironment === "production") {
    if (path.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
      return false;
    }
  }

  // Always skip health check endpoint to reduce noise
  if (path === "/health" && req.method === "GET") {
    return false;
  }

  // Skip preflight OPTIONS requests
  if (req.method === "OPTIONS") {
    return false;
  }

  return true;
}

/**
 * Get response size from headers or content
 */
function getResponseSize(res: Response): number | undefined {
  const contentLength = res.getHeader("content-length");
  if (contentLength) {
    return parseInt(contentLength as string, 10);
  }
  return undefined;
}

/**
 * Create request logging middleware
 */
export function createRequestLoggingMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!shouldLogRequest(req)) {
      next();
      return;
    }

    const requestId = generateRequestId();
    const startTime = Date.now();

    // Attach request ID to request object for use in other middleware/routes
    (req as any).requestId = requestId;

    const requestData: RequestLogData = {
      method: req.method,
      path: req.path,
      query: req.query,
      headers: sanitizeHeaders(req.headers),
      ip: req.ip || "unknown",
      userAgent: req.get("User-Agent"),
      startTime,
      requestId,
    };

    // Only log body for certain methods and if not too large
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const bodyString = JSON.stringify(req.body || {});
      if (bodyString.length < 10000) {
        // Only log bodies under 10KB
        requestData.body = sanitizeRequestBody(req.body);
      } else {
        requestData.body = "[BODY_TOO_LARGE]";
      }
    }

    // Log incoming request
    logger.info("Incoming request", {
      requestId,
      method: requestData.method,
      path: requestData.path,
      ip: requestData.ip,
      userAgent: requestData.userAgent,
      hasQuery: Object.keys(req.query).length > 0,
      hasBody: requestData.body !== undefined,
    });

    // Log detailed request data in debug mode
    if (appConfig.logging.level === "debug") {
      logger.debug("Request details", requestData);
    }

    // Capture response data
    const originalSend = res.send;
    const originalJson = res.json;
    let responseBody: any;

    // Override res.send to capture response
    res.send = function (data: any) {
      responseBody = data;
      return originalSend.call(this, data);
    };

    // Override res.json to capture response
    res.json = function (data: any) {
      responseBody = data;
      return originalJson.call(this, data);
    };

    // Listen for response finish event
    res.on("finish", () => {
      const duration = Date.now() - startTime;
      const responseSize = getResponseSize(res);

      const responseData: ResponseLogData = {
        statusCode: res.statusCode,
        duration,
        responseSize,
        contentType: res.getHeader("content-type") as string,
      };

      // Determine log level based on status code
      let logLevel: "info" | "warn" | "error" = "info";
      if (res.statusCode >= 400 && res.statusCode < 500) {
        logLevel = "warn";
      } else if (res.statusCode >= 500) {
        logLevel = "error";
      }

      // Log response summary
      logger[logLevel]("Request completed", {
        requestId,
        method: requestData.method,
        path: requestData.path,
        statusCode: responseData.statusCode,
        duration: `${duration}ms`,
        ip: requestData.ip,
        responseSize: responseSize ? `${responseSize} bytes` : undefined,
      });

      // Log detailed response data in debug mode
      if (appConfig.logging.level === "debug") {
        const debugData = {
          request: requestData,
          response: {
            ...responseData,
            body:
              responseBody &&
              typeof responseBody === "string" &&
              responseBody.length < 1000
                ? responseBody
                : "[RESPONSE_BODY_OMITTED]",
          },
        };
        logger.debug("Request/Response details", debugData);
      }

      // Log slow requests as warnings
      const slowRequestThreshold = 5000; // 5 seconds
      if (duration > slowRequestThreshold) {
        logger.warn("Slow request detected", {
          requestId,
          method: requestData.method,
          path: requestData.path,
          duration: `${duration}ms`,
          threshold: `${slowRequestThreshold}ms`,
        });
      }
    });

    // Listen for response error events
    res.on("error", (error) => {
      logger.error("Response error", {
        requestId,
        method: requestData.method,
        path: requestData.path,
        error: error.message,
        duration: `${Date.now() - startTime}ms`,
      });
    });

    next();
  };
}

/**
 * Express middleware that adds request ID to response headers
 */
export function addRequestIdHeader(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = (req as any).requestId;
  if (requestId) {
    res.setHeader("X-Request-ID", requestId);
  }
  next();
}

/**
 * Get request ID from request object (useful in route handlers)
 */
export function getRequestId(req: Request): string | undefined {
  return (req as any).requestId;
}
