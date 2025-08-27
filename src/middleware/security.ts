import helmet from 'helmet';
import cors from 'cors';
import { Request, Response, NextFunction } from 'express';
import { appConfig } from '../config';
import { logger } from '../utils/logger';

/**
 * Configure Helmet security middleware with appropriate CSP settings
 */
export function createSecurityMiddleware() {
  return helmet({
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
  });
}

/**
 * Configure CORS middleware based on environment and configuration
 */
export function createCorsMiddleware() {
  return cors({
    origin: appConfig.security.corsOrigins,
    credentials: appConfig.security.enableCredentials,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });
}

/**
 * Trust proxy configuration for accurate client IP addresses
 */
export function configureTrustProxy(app: any): void {
  if (appConfig.server.trustProxy) {
    app.set('trust proxy', true);
    logger.info('Trust proxy enabled for accurate client IP detection');
  }
}

/**
 * Security headers middleware for additional protection
 */
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Remove X-Powered-By header
  res.removeHeader('X-Powered-By');

  // Add custom security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Only add HSTS in production
  if (appConfig.server.nodeEnvironment === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  next();
}
