import { Request, Response, NextFunction } from "express";
import { appConfig } from "../config";
import { logger } from "../utils/logger";
import { ResponseService } from "../utils/response-service";
import { getRequestId } from "./request-logging";

interface RateLimitData {
  requestCount: number;
  windowResetTime: number;
  firstRequestTime: number;
}

/**
 * In-memory store for rate limiting data
 * Maps client IP to their rate limit information
 */
class RateLimitStore {
  private store = new Map<string, RateLimitData>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(cleanupIntervalMs: number) {
    // Setup periodic cleanup of expired entries
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);

    logger.info("Rate limit store initialized", {
      cleanupInterval: `${cleanupIntervalMs}ms`,
    });
  }

  /**
   * Get rate limit data for a client IP
   */
  get(clientIp: string): RateLimitData | undefined {
    return this.store.get(clientIp);
  }

  /**
   * Set rate limit data for a client IP
   */
  set(clientIp: string, data: RateLimitData): void {
    this.store.set(clientIp, data);
  }

  /**
   * Remove expired entries from the store
   */
  private cleanup(): void {
    const now = Date.now();
    let removedCount = 0;
    let totalEntries = this.store.size;

    for (const [clientIp, data] of this.store.entries()) {
      if (now > data.windowResetTime) {
        this.store.delete(clientIp);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      logger.debug("Rate limit store cleanup completed", {
        removedEntries: removedCount,
        remainingEntries: this.store.size,
        totalEntries,
      });
    }
  }

  /**
   * Get current store statistics
   */
  getStats() {
    return {
      activeClients: this.store.size,
      memoryUsage: this.store.size * 64, // Rough estimate in bytes
    };
  }

  /**
   * Shutdown the rate limit store and cleanup resources
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
    logger.info("Rate limit store shut down");
  }
}

// Create global rate limit store instance
const rateLimitStore = new RateLimitStore(
  appConfig.security.rateLimiting.cleanupIntervalMs,
);

/**
 * Extract client IP address with fallbacks
 */
function getClientIp(req: Request): string {
  // Try to get IP from various headers (when behind proxy)
  const forwardedFor = req.headers["x-forwarded-for"] as string;
  const realIp = req.headers["x-real-ip"] as string;
  const clientIp = req.headers["x-client-ip"] as string;

  if (forwardedFor) {
    // X-Forwarded-For can contain multiple IPs, take the first one
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  if (realIp) {
    return realIp;
  }

  if (clientIp) {
    return clientIp;
  }

  // Fallback to connection IP
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * Create rate limiting middleware
 */
export function createRateLimitMiddleware() {
  const { windowMs, maxRequests } = appConfig.security.rateLimiting;

  return (req: Request, res: Response, next: NextFunction): void => {
    const clientIp = getClientIp(req);
    const now = Date.now();

    // Get existing rate limit data for this client
    let clientRateLimit = rateLimitStore.get(clientIp);

    // If no data exists or window has expired, create new entry
    if (!clientRateLimit || now > clientRateLimit.windowResetTime) {
      clientRateLimit = {
        requestCount: 1,
        windowResetTime: now + windowMs,
        firstRequestTime: now,
      };
      rateLimitStore.set(clientIp, clientRateLimit);

      // Add rate limit headers
      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", maxRequests - 1);
      res.setHeader(
        "X-RateLimit-Reset",
        Math.ceil(clientRateLimit.windowResetTime / 1000),
      );

      next();
      return;
    }

    // Check if client has exceeded the rate limit
    if (clientRateLimit.requestCount >= maxRequests) {
      const retryAfter = Math.ceil(
        (clientRateLimit.windowResetTime - now) / 1000,
      );

      // Log rate limit violation
      logger.warn("Rate limit exceeded", {
        clientIp,
        requestCount: clientRateLimit.requestCount,
        maxRequests,
        retryAfter,
        path: req.path,
        method: req.method,
        userAgent: req.get("User-Agent"),
      });

      // Set rate limit headers for exceeded case
      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader(
        "X-RateLimit-Reset",
        Math.ceil(clientRateLimit.windowResetTime / 1000),
      );
      res.setHeader("Retry-After", retryAfter);

      const requestId = getRequestId(req);
      ResponseService.rateLimit(
        res,
        "Too many requests. Please try again later.",
        retryAfter,
        {
          ...(requestId && { requestId }),
          headers: {
            "X-RateLimit-Limit": maxRequests.toString(),
            "X-RateLimit-Window": windowMs.toString(),
          },
        },
      );
      return;
    }

    // Increment request count
    clientRateLimit.requestCount++;
    rateLimitStore.set(clientIp, clientRateLimit);

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader(
      "X-RateLimit-Remaining",
      maxRequests - clientRateLimit.requestCount,
    );
    res.setHeader(
      "X-RateLimit-Reset",
      Math.ceil(clientRateLimit.windowResetTime / 1000),
    );

    next();
  };
}

/**
 * Get rate limiting statistics
 */
export function getRateLimitStats() {
  return rateLimitStore.getStats();
}

/**
 * Shutdown rate limiting resources
 */
export function shutdownRateLimit(): void {
  rateLimitStore.shutdown();
}

/**
 * Reset rate limit for a specific IP (useful for testing or admin override)
 */
export function resetRateLimitForIp(clientIp: string): boolean {
  const existed = rateLimitStore.get(clientIp) !== undefined;
  rateLimitStore.set(clientIp, {
    requestCount: 0,
    windowResetTime: Date.now() + appConfig.security.rateLimiting.windowMs,
    firstRequestTime: Date.now(),
  });

  logger.info("Rate limit reset for IP", { clientIp, existed });
  return existed;
}
