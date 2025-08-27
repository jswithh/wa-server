import Joi from "joi";

// Account validation schemas
export const createAccountSchema = Joi.object({
  id: Joi.string()
    .required()
    .min(1)
    .max(50)
    .pattern(/^[a-zA-Z0-9_-]+$/),
  name: Joi.string().required().min(1).max(100).trim(),
  phone_number: Joi.string()
    .optional()
    .pattern(/^\+?[1-9]\d{1,14}$/),
  status: Joi.string()
    .valid("connected", "disconnected", "connecting", "qr_pending")
    .default("disconnected"),
});

export const updateAccountSchema = Joi.object({
  name: Joi.string().optional().min(1).max(100).trim(),
  phone_number: Joi.string()
    .optional()
    .pattern(/^\+?[1-9]\d{1,14}$/),
  status: Joi.string()
    .optional()
    .valid("connected", "disconnected", "connecting", "qr_pending"),
}).min(1);

// Message validation schemas
export const messageSchema = Joi.object({
  from: Joi.string()
    .required()
    .pattern(/^\d{10,15}$/),
  to: Joi.string()
    .required()
    .pattern(/^\d{10,15}$/),
  message: Joi.string().required().min(1).max(10000),
  timestamp: Joi.string()
    .required()
    .pattern(/^\d{10}$/), // Unix timestamp
  type: Joi.string()
    .valid("text", "image", "video", "audio", "document", "sticker")
    .default("text"),
});

// Webhook payload validation
export const webhookPayloadSchema = Joi.object({
  from: Joi.string()
    .required()
    .pattern(/^\d{10,15}$/),
  to: Joi.string()
    .required()
    .pattern(/^\d{10,15}$/),
  message: Joi.string().required().min(1).max(10000),
  timestamp: Joi.string()
    .required()
    .pattern(/^\d{10}$/),
  type: Joi.string()
    .valid("text", "image", "video", "audio", "document", "sticker")
    .required(),
  messageId: Joi.string().required().min(1),
});

// Query parameter validation
export const paginationSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

export const accountIdParamSchema = Joi.object({
  accountId: Joi.string()
    .required()
    .min(1)
    .max(50)
    .pattern(/^[a-zA-Z0-9_-]+$/),
});

// Session validation
export const sessionDataSchema = Joi.object({
  account_id: Joi.string()
    .required()
    .min(1)
    .max(50)
    .pattern(/^[a-zA-Z0-9_-]+$/),
  session_data: Joi.string().required().min(1),
});

// Validation middleware helper
export const validateRequest = (
  schema: Joi.ObjectSchema,
  property: "body" | "params" | "query" = "body",
) => {
  return (req: any, res: any, next: any) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      const errorMessages = error.details.map((detail) => ({
        field: detail.path.join("."),
        message: detail.message,
        value: detail.context?.value,
      }));

      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors: errorMessages,
      });
    }

    // Replace the request property with validated/sanitized data
    req[property] = value;
    next();
  };
};

// Phone number utilities moved to phone-utils.ts

// Message content validation
export const sanitizeMessageContent = (content: string): string => {
  return content
    .trim()
    .replace(/\s+/g, " ") // Replace multiple spaces with single space
    .substring(0, 10000); // Limit message length
};

// Timestamp utilities

export const getCurrentTimestamp = (): string => {
  return Math.floor(Date.now() / 1000).toString();
};

// ID generation and validation

export const generateMessageId = (accountId?: string): string => {
  const prefix = accountId ? `${accountId}_` : "";
  return (
    prefix +
    "msg_" +
    Date.now() +
    "_" +
    Math.random().toString(36).substring(2, 15)
  );
};

// Note: Response helpers moved to ResponseService in utils/response-service.ts
// These functions are deprecated - use ResponseService instead
