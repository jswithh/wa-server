import Joi from 'joi';

// Account validation schemas
export const createAccountSchema = Joi.object({
  id: Joi.string().required().min(1).max(50).pattern(/^[a-zA-Z0-9_-]+$/),
  name: Joi.string().required().min(1).max(100).trim(),
  phone_number: Joi.string().optional().pattern(/^\+?[1-9]\d{1,14}$/),
  status: Joi.string().valid('connected', 'disconnected', 'connecting', 'qr_pending').default('disconnected')
});

export const updateAccountSchema = Joi.object({
  name: Joi.string().optional().min(1).max(100).trim(),
  phone_number: Joi.string().optional().pattern(/^\+?[1-9]\d{1,14}$/),
  status: Joi.string().optional().valid('connected', 'disconnected', 'connecting', 'qr_pending')
}).min(1);

// Message validation schemas
export const messageSchema = Joi.object({
  from: Joi.string().required().pattern(/^\d{10,15}$/),
  to: Joi.string().required().pattern(/^\d{10,15}$/),
  message: Joi.string().required().min(1).max(10000),
  timestamp: Joi.string().required().pattern(/^\d{10}$/), // Unix timestamp
  type: Joi.string().valid('text', 'image', 'video', 'audio', 'document', 'sticker').default('text')
});

// Webhook payload validation
export const webhookPayloadSchema = Joi.object({
  from: Joi.string().required().pattern(/^\d{10,15}$/),
  to: Joi.string().required().pattern(/^\d{10,15}$/),
  message: Joi.string().required().min(1).max(10000),
  timestamp: Joi.string().required().pattern(/^\d{10}$/),
  type: Joi.string().valid('text', 'image', 'video', 'audio', 'document', 'sticker').required()
});

// Query parameter validation
export const paginationSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0)
});

export const accountIdParamSchema = Joi.object({
  accountId: Joi.string().required().min(1).max(50).pattern(/^[a-zA-Z0-9_-]+$/)
});

// Session validation
export const sessionDataSchema = Joi.object({
  account_id: Joi.string().required().min(1).max(50).pattern(/^[a-zA-Z0-9_-]+$/),
  session_data: Joi.string().required().min(1)
});

// Configuration validation
export const configSchema = Joi.object({
  port: Joi.number().integer().min(1).max(65535).default(3000),
  webhook_url: Joi.string().uri().required(),
  webhook_timeout: Joi.number().integer().min(1000).max(30000).default(10000),
  webhook_retry_attempts: Joi.number().integer().min(1).max(10).default(3),
  webhook_retry_delay: Joi.number().integer().min(100).max(10000).default(1000),
  log_level: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  session_save_interval: Joi.number().integer().min(10000).max(300000).default(60000),
  message_batch_size: Joi.number().integer().min(1).max(1000).default(100)
});

// Validation middleware helper
export const validateRequest = (schema: Joi.ObjectSchema, property: 'body' | 'params' | 'query' = 'body') => {
  return (req: any, res: any, next: any) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
      convert: true
    });

    if (error) {
      const errorMessages = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context?.value
      }));

      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: errorMessages
      });
    }

    // Replace the request property with validated/sanitized data
    req[property] = value;
    next();
  };
};

// Phone number utilities
export const normalizePhoneNumber = (phoneNumber: string): string => {
  // Remove all non-digit characters
  const cleaned = phoneNumber.replace(/\D/g, '');

  // Add country code if missing (assuming Indonesian numbers)
  if (cleaned.startsWith('0')) {
    return '62' + cleaned.substring(1);
  }

  if (!cleaned.startsWith('62')) {
    return '62' + cleaned;
  }

  return cleaned;
};

export const formatPhoneNumberForDisplay = (phoneNumber: string): string => {
  const normalized = normalizePhoneNumber(phoneNumber);
  return '+' + normalized;
};

export const validatePhoneNumber = (phoneNumber: string): boolean => {
  const phoneRegex = /^(\+?62|62|0)[0-9]{8,13}$/;
  return phoneRegex.test(phoneNumber);
};

// Message content validation
export const sanitizeMessageContent = (content: string): string => {
  return content
    .trim()
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .substring(0, 10000); // Limit message length
};

// Timestamp utilities
export const validateTimestamp = (timestamp: string): boolean => {
  const ts = parseInt(timestamp);
  const now = Math.floor(Date.now() / 1000);
  const oneYearAgo = now - (365 * 24 * 60 * 60);
  const oneHourFromNow = now + (60 * 60);

  return ts >= oneYearAgo && ts <= oneHourFromNow;
};

export const getCurrentTimestamp = (): string => {
  return Math.floor(Date.now() / 1000).toString();
};

// ID generation and validation
export const generateAccountId = (): string => {
  return 'acc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
};

export const generateMessageId = (): string => {
  return 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
};

export const generateSessionId = (): string => {
  return 'ses_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
};

// Error response helpers
export const createErrorResponse = (message: string, code?: string, details?: any) => {
  return {
    success: false,
    message,
    code,
    details,
    timestamp: new Date().toISOString()
  };
};

export const createSuccessResponse = (data?: any, message?: string) => {
  return {
    success: true,
    message: message || 'Operation completed successfully',
    data,
    timestamp: new Date().toISOString()
  };
};

// Rate limiting validation
export const rateLimitSchema = Joi.object({
  windowMs: Joi.number().integer().min(1000).max(3600000).default(900000), // 15 minutes
  max: Joi.number().integer().min(1).max(10000).default(100),
  message: Joi.string().default('Too many requests, please try again later.')
});

// Environment validation
export const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  WEBHOOK_URL: Joi.string().uri().default('http://localhost:10022/hra_whatsapp/sub_channel/webhook'),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  DATABASE_PATH: Joi.string().default('./database.sqlite'),
  SESSIONS_PATH: Joi.string().default('./sessions'),
  MAX_ACCOUNTS: Joi.number().integer().min(1).max(100).default(10)
});
