/**
 * Centralized Response Service
 * Eliminates repetitive response patterns and provides consistent API responses
 */

import { Response } from "express";
import { logger } from "./logger";

export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
  error?: string;
  errorType?: string | undefined;
  metadata?: {
    timestamp: string;
    requestId?: string;
    version?: string;
    pagination?: PaginationMetadata;
    performance?: PerformanceMetadata;
  };
}

export interface PaginationMetadata {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PerformanceMetadata {
  processingTime: number;
  cacheHit?: boolean;
  operationsCount?: number;
}

export interface ResponseOptions {
  statusCode?: number;
  requestId?: string;
  includeTimestamp?: boolean;
  includeVersion?: boolean;
  logResponse?: boolean;
  pagination?: PaginationMetadata;
  performance?: PerformanceMetadata;
  headers?: Record<string, string>;
}

/**
 * Centralized response service to eliminate repetitive response code
 */
class ResponseService {
  private static readonly DEFAULT_VERSION = "1.0.0";
  private static readonly DEFAULT_STATUS_CODES = {
    SUCCESS: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    RATE_LIMITED: 429,
    INTERNAL_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
  };

  /**
   * Send success response with consistent format
   */
  static success<T>(
    res: Response,
    data: T,
    message: string = "Operation completed successfully",
    options: ResponseOptions = {},
  ): void {
    const {
      statusCode = this.DEFAULT_STATUS_CODES.SUCCESS,
      requestId,
      includeTimestamp = true,
      includeVersion = false,
      logResponse = false,
      pagination,
      performance,
      headers,
    } = options;

    const response: ApiResponse<T> = {
      success: true,
      message,
      data,
      metadata: this.buildMetadata({
        ...(requestId && { requestId }),
        includeTimestamp,
        includeVersion,
        ...(pagination && { pagination }),
        ...(performance && { performance }),
      }),
    };

    this.sendResponse(res, response, statusCode, headers, logResponse);
  }

  /**
   * Send error response with consistent format
   */
  static error(
    res: Response,
    message: string,
    errorType?: string,
    options: ResponseOptions = {},
  ): void {
    const {
      statusCode = this.DEFAULT_STATUS_CODES.INTERNAL_ERROR,
      requestId,
      includeTimestamp = true,
      includeVersion = false,
      logResponse = true,
      headers,
    } = options;

    const response: ApiResponse = {
      success: false,
      message,
      error: message,
      errorType: errorType || undefined,
      metadata: this.buildMetadata({
        ...(requestId && { requestId }),
        includeTimestamp,
        includeVersion,
      }),
    };

    this.sendResponse(res, response, statusCode, headers, logResponse);
  }

  /**
   * Send validation error response
   */
  static validationError(
    res: Response,
    message: string = "Validation failed",
    errors?: any,
    options: ResponseOptions = {},
  ): void {
    this.error(res, message, "VALIDATION_ERROR", {
      ...options,
      statusCode: this.DEFAULT_STATUS_CODES.BAD_REQUEST,
    });

    if (errors && options.logResponse !== false) {
      logger.debug("Validation errors:", errors);
    }
  }

  /**
   * Send authentication error response
   */
  static authenticationError(
    res: Response,
    message: string = "Authentication required",
    options: ResponseOptions = {},
  ): void {
    this.error(res, message, "AUTHENTICATION_ERROR", {
      ...options,
      statusCode: this.DEFAULT_STATUS_CODES.UNAUTHORIZED,
    });
  }

  /**
   * Send authorization error response
   */
  static authorizationError(
    res: Response,
    message: string = "Insufficient permissions",
    options: ResponseOptions = {},
  ): void {
    this.error(res, message, "AUTHORIZATION_ERROR", {
      ...options,
      statusCode: this.DEFAULT_STATUS_CODES.FORBIDDEN,
    });
  }

  /**
   * Send not found error response
   */
  static notFound(
    res: Response,
    message: string = "Resource not found",
    options: ResponseOptions = {},
  ): void {
    this.error(res, message, "NOT_FOUND", {
      ...options,
      statusCode: this.DEFAULT_STATUS_CODES.NOT_FOUND,
    });
  }

  /**
   * Send conflict error response
   */
  static conflict(
    res: Response,
    message: string = "Resource already exists",
    options: ResponseOptions = {},
  ): void {
    this.error(res, message, "CONFLICT", {
      ...options,
      statusCode: this.DEFAULT_STATUS_CODES.CONFLICT,
    });
  }

  /**
   * Send rate limit error response
   */
  static rateLimit(
    res: Response,
    message: string = "Too many requests",
    retryAfter?: number,
    options: ResponseOptions = {},
  ): void {
    const updatedOptions: ResponseOptions = {
      ...options,
      statusCode: this.DEFAULT_STATUS_CODES.RATE_LIMITED,
    };

    if (retryAfter) {
      updatedOptions.headers = {
        ...options.headers,
        "Retry-After": retryAfter.toString(),
      };
    } else if (options.headers) {
      updatedOptions.headers = options.headers;
    }

    this.error(res, message, "RATE_LIMIT_EXCEEDED", updatedOptions);
  }

  /**
   * Send service unavailable error response
   */
  static serviceUnavailable(
    res: Response,
    message: string = "Service temporarily unavailable",
    options: ResponseOptions = {},
  ): void {
    this.error(res, message, "SERVICE_UNAVAILABLE", {
      ...options,
      statusCode: this.DEFAULT_STATUS_CODES.SERVICE_UNAVAILABLE,
    });
  }

  /**
   * Send paginated success response
   */
  static paginated<T>(
    res: Response,
    data: T[],
    pagination: PaginationMetadata,
    message: string = "Data retrieved successfully",
    options: ResponseOptions = {},
  ): void {
    this.success(res, data, message, {
      ...options,
      pagination,
    });
  }

  /**
   * Send created resource response
   */
  static created<T>(
    res: Response,
    data: T,
    message: string = "Resource created successfully",
    options: ResponseOptions = {},
  ): void {
    this.success(res, data, message, {
      ...options,
      statusCode: this.DEFAULT_STATUS_CODES.CREATED,
    });
  }

  /**
   * Send no content response
   */
  static noContent(
    res: Response,
    message: string = "Operation completed",
    options: ResponseOptions = {},
  ): void {
    const response: ApiResponse = {
      success: true,
      message,
      metadata: this.buildMetadata({
        ...(options.requestId && { requestId: options.requestId }),
        ...(options.includeTimestamp !== undefined && {
          includeTimestamp: options.includeTimestamp,
        }),
        ...(options.includeVersion !== undefined && {
          includeVersion: options.includeVersion,
        }),
      }),
    };

    this.sendResponse(
      res,
      response,
      this.DEFAULT_STATUS_CODES.NO_CONTENT,
      options.headers,
      options.logResponse,
    );
  }

  /**
   * Send health check response
   */
  static health(
    res: Response,
    status: "healthy" | "unhealthy" | "degraded",
    data: any,
    options: ResponseOptions = {},
  ): void {
    const statusCode =
      status === "healthy"
        ? this.DEFAULT_STATUS_CODES.SUCCESS
        : this.DEFAULT_STATUS_CODES.SERVICE_UNAVAILABLE;

    const message = `System is ${status}`;

    if (status === "healthy") {
      this.success(res, data, message, { ...options, statusCode });
    } else {
      this.error(res, message, "UNHEALTHY", { ...options, statusCode });
    }
  }

  /**
   * Build metadata object
   */
  private static buildMetadata(options: {
    requestId?: string;
    includeTimestamp?: boolean;
    includeVersion?: boolean;
    pagination?: PaginationMetadata;
    performance?: PerformanceMetadata;
  }) {
    const metadata: any = {};

    if (options.includeTimestamp) {
      metadata.timestamp = new Date().toISOString();
    }

    if (options.requestId) {
      metadata.requestId = options.requestId;
    }

    if (options.includeVersion) {
      metadata.version = this.DEFAULT_VERSION;
    }

    if (options.pagination) {
      metadata.pagination = options.pagination;
    }

    if (options.performance) {
      metadata.performance = options.performance;
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  /**
   * Send the actual HTTP response
   */
  private static sendResponse(
    res: Response,
    response: ApiResponse,
    statusCode: number,
    headers?: Record<string, string>,
    logResponse?: boolean,
  ): void {
    // Set headers
    if (headers) {
      Object.entries(headers).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
    }

    // Log response if requested
    if (logResponse) {
      logger.debug("API Response", {
        statusCode,
        success: response.success,
        message: response.message,
        errorType: response.errorType,
        hasData: !!response.data,
        requestId: response.metadata?.requestId,
      });
    }

    // Send response
    res.status(statusCode).json(response);
  }

  /**
   * Create pagination metadata
   */
  static createPagination(
    page: number,
    limit: number,
    total: number,
  ): PaginationMetadata {
    const totalPages = Math.ceil(total / limit);

    return {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * Create performance metadata
   */
  static createPerformance(
    startTime: number,
    cacheHit?: boolean,
    operationsCount?: number,
  ): PerformanceMetadata {
    const performance: PerformanceMetadata = {
      processingTime: Date.now() - startTime,
    };

    if (cacheHit !== undefined) {
      performance.cacheHit = cacheHit;
    }

    if (operationsCount !== undefined) {
      performance.operationsCount = operationsCount;
    }

    return performance;
  }
}

// Backward compatibility functions (to be deprecated)
export const createSuccessResponse = <T>(
  data: T,
  message: string = "Operation completed successfully",
): ApiResponse<T> => ({
  success: true,
  message,
  data,
  metadata: {
    timestamp: new Date().toISOString(),
  },
});

export const createErrorResponse = (
  message: string,
  errorType?: string,
  data?: any,
): ApiResponse => ({
  success: false,
  message,
  error: message,
  errorType: errorType || undefined,
  data,
  metadata: {
    timestamp: new Date().toISOString(),
  },
});

// Export the main service
export { ResponseService };
export default ResponseService;
