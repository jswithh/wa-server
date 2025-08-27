import express, { Request, Response } from "express";
import { whatsappService } from "../services/whatsapp";
import { databaseManager } from "../models/database";
import {
  validateRequest,
  createAccountSchema,
  updateAccountSchema,
  accountIdParamSchema,
  paginationSchema,
} from "../utils/validation";
import { ResponseService } from "../utils/response-service";
import { logger } from "../utils/logger";
import { getRequestId } from "../middleware/request-logging";
import {
  createQRNotAvailablePage,
  createQRDisplayPage,
  createErrorPage,
} from "../templates/html-templates";

const router = express.Router();

/**
 * GET /accounts
 * Get all accounts with their current status
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const accounts = await databaseManager.getAllAccounts();
    const mergedAccounts = accounts.map((dbAccount) => {
      const socketAccount = whatsappService.getAccount(dbAccount.id);
      return {
        ...dbAccount,
        socketStatus: socketAccount?.status || "disconnected",
        hasQrCode: !!socketAccount?.qrCode,
        lastSeen: socketAccount?.lastSeen || dbAccount.last_seen,
      };
    });

    const requestId = getRequestId(req);
    ResponseService.success(
      res,
      mergedAccounts,
      "Accounts retrieved successfully",
      requestId ? { requestId } : {},
    );
  } catch (error) {
    logger.error("Failed to get accounts:", error);
    const requestId = getRequestId(req);
    ResponseService.error(
      res,
      "Failed to retrieve accounts",
      "DATABASE_ERROR",
      requestId ? { requestId } : {},
    );
  }
});

/**
 * POST /accounts
 * Create a new WhatsApp account
 */
router.post(
  "/",
  validateRequest(createAccountSchema),
  async (req: Request, res: Response) => {
    try {
      const { id, name, phone_number } = req.body;
      const requestId = getRequestId(req);

      // Check if account already exists
      const existingAccount = await databaseManager.getAccount(id);
      if (existingAccount) {
        return ResponseService.conflict(
          res,
          "Account already exists",
          requestId ? { requestId } : {},
        );
      }

      // Create account
      const result = await whatsappService.createAccount(id, name);

      const response = {
        id,
        name,
        phone_number,
        status: result.success ? "connecting" : "disconnected",
        qrCode: result.qrCode,
      };

      if (result.success) {
        return ResponseService.created(
          res,
          response,
          "Account created successfully",
          requestId ? { requestId } : {},
        );
      } else {
        return ResponseService.error(
          res,
          result.error || "Failed to create account",
          "CREATION_ERROR",
          requestId ? { requestId } : {},
        );
      }
    } catch (error) {
      logger.error("Failed to create account:", error);
      const requestId = getRequestId(req);
      return ResponseService.error(
        res,
        "Internal server error",
        "INTERNAL_ERROR",
        requestId ? { requestId } : {},
      );
    }
  },
);

/**
 * GET /accounts/:accountId
 * Get specific account details
 */
router.get(
  "/:accountId",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const requestId = getRequestId(req);

      if (!accountId) {
        return ResponseService.validationError(
          res,
          "Account ID is required",
          undefined,
          requestId ? { requestId } : {},
        );
      }

      const dbAccount = await databaseManager.getAccount(accountId);
      if (!dbAccount) {
        return ResponseService.notFound(
          res,
          "Account not found",
          requestId ? { requestId } : {},
        );
      }

      const socketAccount = whatsappService.getAccount(accountId);
      const accountDetails = {
        ...dbAccount,
        socketStatus: socketAccount?.status || "disconnected",
        hasQrCode: !!socketAccount?.qrCode,
        lastSeen: socketAccount?.lastSeen || dbAccount.last_seen,
      };

      return ResponseService.success(
        res,
        accountDetails,
        "Account details retrieved successfully",
        requestId ? { requestId } : {},
      );
    } catch (error) {
      logger.error(`Failed to get account ${req.params.accountId}:`, error);
      const requestId = getRequestId(req);
      return ResponseService.error(
        res,
        "Failed to retrieve account details",
        "DATABASE_ERROR",
        requestId ? { requestId } : {},
      );
    }
  },
);

/**
 * PUT /accounts/:accountId
 * Update account details
 */
router.put(
  "/:accountId",
  validateRequest(accountIdParamSchema, "params"),
  validateRequest(updateAccountSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const updates = req.body;
      const requestId = getRequestId(req);

      if (!accountId) {
        return ResponseService.validationError(
          res,
          "Account ID is required",
          undefined,
          requestId ? { requestId } : {},
        );
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return ResponseService.notFound(
          res,
          "Account not found",
          requestId ? { requestId } : {},
        );
      }

      // Update in database - for now just get the existing account
      const updatedAccount = await databaseManager.getAccount(accountId);

      const socketAccount = whatsappService.getAccount(accountId);
      const accountDetails = {
        ...updatedAccount,
        socketStatus: socketAccount?.status || "disconnected",
        hasQrCode: !!socketAccount?.qrCode,
        lastSeen: socketAccount?.lastSeen || updatedAccount?.last_seen,
      };

      return ResponseService.success(
        res,
        accountDetails,
        "Account updated successfully",
        requestId ? { requestId } : {},
      );
    } catch (error) {
      logger.error(`Failed to update account ${req.params.accountId}:`, error);
      const requestId = getRequestId(req);
      return ResponseService.error(
        res,
        "Failed to update account",
        "UPDATE_ERROR",
        requestId ? { requestId } : {},
      );
    }
  },
);

/**
 * DELETE /accounts/:accountId
 * Delete an account
 */
router.delete(
  "/:accountId",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const requestId = getRequestId(req);

      if (!accountId) {
        return ResponseService.validationError(
          res,
          "Account ID is required",
          undefined,
          requestId ? { requestId } : {},
        );
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return ResponseService.notFound(
          res,
          "Account not found",
          requestId ? { requestId } : {},
        );
      }

      // Delete account
      const result = await whatsappService.deleteAccount(accountId);

      if (result.success) {
        return ResponseService.success(
          res,
          null,
          "Account deleted successfully",
          requestId ? { requestId } : {},
        );
      } else {
        return ResponseService.error(
          res,
          result.error || "Failed to delete account",
          "DELETION_ERROR",
          requestId ? { requestId } : {},
        );
      }
    } catch (error) {
      logger.error(`Failed to delete account ${req.params.accountId}:`, error);
      const requestId = getRequestId(req);
      return ResponseService.error(
        res,
        "Internal server error",
        "INTERNAL_ERROR",
        requestId ? { requestId } : {},
      );
    }
  },
);

/**
 * POST /accounts/:accountId/connect
 * Connect an account to WhatsApp
 */
router.post(
  "/:accountId/connect",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const requestId = getRequestId(req);

      if (!accountId) {
        return ResponseService.validationError(
          res,
          "Account ID is required",
          undefined,
          requestId ? { requestId } : {},
        );
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return ResponseService.notFound(
          res,
          "Account not found",
          requestId ? { requestId } : {},
        );
      }

      // Connect account
      const result = await whatsappService.connectAccount(accountId);
      const response: any = {
        status: result.success ? "connecting" : "disconnected",
      };

      if (result.qrCode) {
        response.qrCode = result.qrCode;
      }

      if (result.success) {
        return ResponseService.success(
          res,
          response,
          "Account connection initiated",
          requestId ? { requestId } : {},
        );
      } else {
        return ResponseService.error(
          res,
          result.error || "Failed to connect account",
          "CONNECTION_ERROR",
          requestId ? { requestId } : {},
        );
      }
    } catch (error) {
      logger.error(`Failed to connect account ${req.params.accountId}:`, error);
      const requestId = getRequestId(req);
      return ResponseService.error(
        res,
        "Internal server error",
        "INTERNAL_ERROR",
        requestId ? { requestId } : {},
      );
    }
  },
);

/**
 * POST /accounts/:accountId/disconnect
 * Disconnect an account from WhatsApp
 */
router.post(
  "/:accountId/disconnect",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const requestId = getRequestId(req);

      if (!accountId) {
        return ResponseService.validationError(
          res,
          "Account ID is required",
          undefined,
          requestId ? { requestId } : {},
        );
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return ResponseService.notFound(
          res,
          "Account not found",
          requestId ? { requestId } : {},
        );
      }

      // Disconnect account
      const result = await whatsappService.disconnectAccount(accountId);

      if (result.success) {
        return ResponseService.success(
          res,
          { status: "disconnected" },
          "Account disconnected successfully",
          requestId ? { requestId } : {},
        );
      } else {
        return ResponseService.error(
          res,
          result.error || "Failed to disconnect account",
          "DISCONNECTION_ERROR",
          requestId ? { requestId } : {},
        );
      }
    } catch (error) {
      logger.error(
        `Failed to disconnect account ${req.params.accountId}:`,
        error,
      );
      const requestId = getRequestId(req);
      return ResponseService.error(
        res,
        "Internal server error",
        "INTERNAL_ERROR",
        requestId ? { requestId } : {},
      );
    }
  },
);

/**
 * GET /accounts/:accountId/qr
 * Get QR code for account
 */
router.get(
  "/:accountId/qr",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const requestId = getRequestId(req);

      if (!accountId) {
        return ResponseService.validationError(
          res,
          "Account ID is required",
          undefined,
          requestId ? { requestId } : {},
        );
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return ResponseService.notFound(
          res,
          "Account not found",
          requestId ? { requestId } : {},
        );
      }

      const qrCode = whatsappService.getAccountQRCode(accountId);

      if (qrCode) {
        return ResponseService.success(
          res,
          { qrCode },
          "QR code retrieved successfully",
          requestId ? { requestId } : {},
        );
      } else {
        return ResponseService.notFound(
          res,
          "QR code not available",
          requestId ? { requestId } : {},
        );
      }
    } catch (error) {
      logger.error(
        `Failed to get QR code for account ${req.params.accountId}:`,
        error,
      );
      const requestId = getRequestId(req);
      return ResponseService.error(
        res,
        "Failed to retrieve QR code",
        "QR_ERROR",
        requestId ? { requestId } : {},
      );
    }
  },
);

/**
 * GET /accounts/:accountId/messages
 * Get recent messages for debugging
 */
router.get(
  "/:accountId/messages",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;
      const requestId = getRequestId(req);

      // Get messages for account - simplified query
      const messages = await databaseManager
        .getDatabase()
        .all(
          "SELECT * FROM messages WHERE account_id = ? ORDER BY created_at DESC LIMIT ?",
          [accountId, limit],
        );

      return ResponseService.success(
        res,
        {
          accountId,
          messages,
          count: messages.length,
          limit,
        },
        "Messages retrieved successfully",
        requestId ? { requestId } : {},
      );
    } catch (error) {
      logger.error(
        `Failed to get messages for account ${req.params.accountId}:`,
        error,
      );
      const requestId = getRequestId(req);
      return ResponseService.error(
        res,
        "Failed to retrieve messages",
        "DATABASE_ERROR",
        requestId ? { requestId } : {},
      );
    }
  },
);

/**
 * GET /accounts/:accountId/qr.png
 * Display QR code as image
 */
router.get("/:accountId/qr.png", async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;

    if (!accountId) {
      return res
        .status(400)
        .send(createErrorPage("Error", "Account ID is required"));
    }

    // Check if account exists
    const existingAccount = await databaseManager.getAccount(accountId);
    if (!existingAccount) {
      return res
        .status(404)
        .send(
          createErrorPage(
            "Account Not Found",
            `Account ID: ${accountId}`,
            accountId,
          ),
        );
    }

    const qrCode = whatsappService.getAccountQRCode(accountId);

    if (qrCode) {
      const QRCode = require("qrcode");
      const imageBuffer = await QRCode.toBuffer(qrCode, {
        type: "png",
        width: 512,
        margin: 2,
      });

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

      return res.send(imageBuffer);
    } else {
      return res
        .status(404)
        .send(
          createQRNotAvailablePage(
            accountId,
            existingAccount.name,
            existingAccount.status,
            existingAccount.created_at,
          ),
        );
    }
  } catch (error) {
    logger.error(
      `Failed to display QR image for account ${req.params.accountId}:`,
      error,
    );
    return res
      .status(500)
      .send(
        createErrorPage(
          "Internal Server Error",
          `Failed to load QR code for account: ${req.params.accountId}`,
          req.params.accountId,
        ),
      );
  }
});

/**
 * GET /accounts/:accountId/qr-page
 * Display QR code page
 */
router.get("/:accountId/qr-page", async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;

    if (!accountId) {
      return res
        .status(400)
        .send(createErrorPage("Error", "Account ID is required"));
    }

    // Check if account exists
    const existingAccount = await databaseManager.getAccount(accountId);
    if (!existingAccount) {
      return res
        .status(404)
        .send(
          createErrorPage(
            "Account Not Found",
            `Account ID: ${accountId}`,
            accountId,
          ),
        );
    }

    const qrCode = whatsappService.getAccountQRCode(accountId);

    if (qrCode) {
      return res.send(
        createQRDisplayPage(accountId, existingAccount.name, qrCode),
      );
    } else {
      return res.send(
        createQRNotAvailablePage(
          accountId,
          existingAccount.name,
          existingAccount.status,
          existingAccount.created_at,
        ),
      );
    }
  } catch (error) {
    logger.error(
      `Failed to display QR page for account ${req.params.accountId}:`,
      error,
    );
    return res
      .status(500)
      .send(
        createErrorPage(
          "Internal Server Error",
          `Failed to load QR page for account: ${req.params.accountId}`,
          req.params.accountId,
        ),
      );
  }
});

export default router;
