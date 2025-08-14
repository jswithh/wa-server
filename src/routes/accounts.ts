import express, { Request, Response } from "express";
import { whatsappService } from "../services/whatsapp";
import { databaseManager } from "../models/database";
import {
  validateRequest,
  createAccountSchema,
  updateAccountSchema,
  accountIdParamSchema,
  paginationSchema,
  createSuccessResponse,
  createErrorResponse,
} from "../utils/validation";
import { serverLogger } from "../utils/logger";

const router = express.Router();

/**
 * GET /accounts
 * Get all WhatsApp accounts
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const accounts = whatsappService.getAllAccounts();
    const dbAccounts = await databaseManager.getAllAccounts();

    // Merge socket status with database info
    const mergedAccounts = dbAccounts.map((dbAccount) => {
      const socketAccount = accounts.find((a) => a.id === dbAccount.id);
      return {
        ...dbAccount,
        socketStatus: socketAccount?.status || "disconnected",
        hasQrCode: !!socketAccount?.qrCode,
        lastSeen: socketAccount?.lastSeen || dbAccount.last_seen,
      };
    });

    res.json(
      createSuccessResponse(mergedAccounts, "Accounts retrieved successfully"),
    );
  } catch (error) {
    serverLogger.error("Failed to get accounts:", error);
    res.status(500).json(createErrorResponse("Failed to retrieve accounts"));
  }
});

/**
 * POST /accounts
 * Create new WhatsApp account
 */
router.post(
  "/",
  validateRequest(createAccountSchema),
  async (req: Request, res: Response) => {
    try {
      const { id, name } = req.body;

      // Check if account already exists
      const existingAccount = await databaseManager.getAccount(id);
      if (existingAccount) {
        return res
          .status(409)
          .json(createErrorResponse("Account already exists"));
      }

      // Create account
      const result = await whatsappService.createAccount(id, name);

      if (result.success) {
        const response = {
          account: {
            id,
            name,
            status: "qr_pending",
            created_at: new Date().toISOString(),
          },
          qrCode: result.qrCode,
        };

        return res
          .status(201)
          .json(
            createSuccessResponse(response, "Account created successfully"),
          );
      } else {
        return res
          .status(400)
          .json(
            createErrorResponse(result.error || "Failed to create account"),
          );
      }
    } catch (error) {
      serverLogger.error("Failed to create account:", error);
      return res.status(500).json(createErrorResponse("Internal server error"));
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

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      const dbAccount = await databaseManager.getAccount(accountId);
      if (!dbAccount) {
        return res.status(404).json(createErrorResponse("Account not found"));
      }

      const socketAccount = whatsappService.getAccount(accountId);

      const accountDetails = {
        ...dbAccount,
        socketStatus: socketAccount?.status || "disconnected",
        hasQrCode: !!socketAccount?.qrCode,
        lastSeen: socketAccount?.lastSeen || dbAccount.last_seen,
      };

      return res.json(
        createSuccessResponse(
          accountDetails,
          "Account details retrieved successfully",
        ),
      );
    } catch (error) {
      serverLogger.error(
        `Failed to get account ${req.params.accountId}:`,
        error,
      );
      return res
        .status(500)
        .json(createErrorResponse("Failed to retrieve account details"));
    }
  },
);

/**
 * PUT /accounts/:accountId
 * Update account information
 */
router.put(
  "/:accountId",
  validateRequest(accountIdParamSchema, "params"),
  validateRequest(updateAccountSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const updates = req.body;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).json(createErrorResponse("Account not found"));
      }

      // Update in database
      if (updates.name) {
        // For now, we only support updating the name
        // Status updates should be handled by the WhatsApp service
        const socketAccount = whatsappService.getAccount(accountId);
        if (socketAccount) {
          socketAccount.name = updates.name;
        }
      }

      // Get updated account
      const updatedAccount = await databaseManager.getAccount(accountId);
      const socketAccount = whatsappService.getAccount(accountId);

      const accountDetails = {
        ...updatedAccount,
        socketStatus: socketAccount?.status || "disconnected",
        hasQrCode: !!socketAccount?.qrCode,
        lastSeen: socketAccount?.lastSeen || updatedAccount?.last_seen,
      };

      return res.json(
        createSuccessResponse(accountDetails, "Account updated successfully"),
      );
    } catch (error) {
      serverLogger.error(
        `Failed to update account ${req.params.accountId}:`,
        error,
      );
      return res
        .status(500)
        .json(createErrorResponse("Failed to update account"));
    }
  },
);

/**
 * DELETE /accounts/:accountId
 * Delete WhatsApp account
 */
router.delete(
  "/:accountId",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).json(createErrorResponse("Account not found"));
      }

      // Delete account
      const result = await whatsappService.deleteAccount(accountId);

      if (result.success) {
        return res.json(
          createSuccessResponse(null, "Account deleted successfully"),
        );
      } else {
        return res
          .status(400)
          .json(
            createErrorResponse(result.error || "Failed to delete account"),
          );
      }
    } catch (error) {
      serverLogger.error(
        `Failed to delete account ${req.params.accountId}:`,
        error,
      );
      return res.status(500).json(createErrorResponse("Internal server error"));
    }
  },
);

/**
 * POST /accounts/:accountId/connect
 * Connect WhatsApp account
 */
router.post(
  "/:accountId/connect",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).json(createErrorResponse("Account not found"));
      }

      // Connect account
      const result = await whatsappService.connectAccount(accountId);

      if (result.success) {
        const response: any = { status: "connecting" };
        if (result.qrCode) {
          response.qrCode = result.qrCode;
        }

        return res.json(
          createSuccessResponse(response, "Account connection initiated"),
        );
      } else {
        return res
          .status(400)
          .json(
            createErrorResponse(result.error || "Failed to connect account"),
          );
      }
    } catch (error) {
      serverLogger.error(
        `Failed to connect account ${req.params.accountId}:`,
        error,
      );
      return res.status(500).json(createErrorResponse("Internal server error"));
    }
  },
);

/**
 * POST /accounts/:accountId/disconnect
 * Disconnect WhatsApp account
 */
router.post(
  "/:accountId/disconnect",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).json(createErrorResponse("Account not found"));
      }

      // Disconnect account
      const result = await whatsappService.disconnectAccount(accountId);

      if (result.success) {
        return res.json(
          createSuccessResponse(
            { status: "disconnected" },
            "Account disconnected successfully",
          ),
        );
      } else {
        return res
          .status(400)
          .json(
            createErrorResponse(result.error || "Failed to disconnect account"),
          );
      }
    } catch (error) {
      serverLogger.error(
        `Failed to disconnect account ${req.params.accountId}:`,
        error,
      );
      return res.status(500).json(createErrorResponse("Internal server error"));
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

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).json(createErrorResponse("Account not found"));
      }

      const qrCode = whatsappService.getAccountQRCode(accountId);

      if (qrCode) {
        return res.json(
          createSuccessResponse({ qrCode }, "QR code retrieved successfully"),
        );
      } else {
        return res
          .status(404)
          .json(createErrorResponse("QR code not available"));
      }
    } catch (error) {
      serverLogger.error(
        `Failed to get QR code for account ${req.params.accountId}:`,
        error,
      );
      return res.status(500).json(createErrorResponse("Internal server error"));
    }
  },
);

/**
 * POST /accounts/:accountId/test-message
 * Send test message to debug message handling
 */
router.post(
  "/:accountId/test-message",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const { to } = req.body;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      if (!to) {
        return res
          .status(400)
          .json(createErrorResponse("Recipient number is required"));
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).json(createErrorResponse("Account not found"));
      }

      // Send test message
      const result = await whatsappService.sendTestMessage(accountId, to);

      if (result.success) {
        return res.json(
          createSuccessResponse(
            { message: "Test message sent successfully" },
            "Test message sent",
          ),
        );
      } else {
        return res
          .status(400)
          .json(
            createErrorResponse(result.error || "Failed to send test message"),
          );
      }
    } catch (error) {
      serverLogger.error(
        `Failed to send test message for account ${req.params.accountId}:`,
        error,
      );
      return res.status(500).json(createErrorResponse("Internal server error"));
    }
  },
);

/**
 * POST /accounts/:accountId/trigger-webhook
 * Manually trigger webhook processing
 */
router.post(
  "/:accountId/trigger-webhook",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).json(createErrorResponse("Account not found"));
      }

      // Trigger manual webhook processing
      await whatsappService.triggerWebhookProcessing();

      return res.json(
        createSuccessResponse(
          { message: "Webhook processing triggered successfully" },
          "Webhook processing triggered",
        ),
      );
    } catch (error) {
      serverLogger.error(
        `Failed to trigger webhook for account ${req.params.accountId}:`,
        error,
      );
      return res.status(500).json(createErrorResponse("Internal server error"));
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
      const limit = parseInt(req.query.limit as string) || 10;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      // Get messages from database
      const messages = await databaseManager.getMessages(accountId, limit);

      return res.json(
        createSuccessResponse(
          messages,
          `Retrieved ${messages.length} messages`,
        ),
      );
    } catch (error) {
      serverLogger.error(
        `Failed to get messages for account ${req.params.accountId}:`,
        error,
      );
      return res.status(500).json(createErrorResponse("Internal server error"));
    }
  },
);

/**
 * GET /accounts/:accountId/qr/image
 * Display QR code as image in browser
 */
router.get(
  "/:accountId/qr/image",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      if (!accountId) {
        return res.status(400).send(`
          <html><body>
            <h1>Error: Account ID is required</h1>
            <p><a href="/">← Back to Dashboard</a></p>
          </body></html>
        `);
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).send(`
          <html><body>
            <h1>Account Not Found</h1>
            <p>Account ID: ${accountId}</p>
            <p><a href="/">← Back to Dashboard</a></p>
          </body></html>
        `);
      }

      const qrCode = whatsappService.getAccountQRCode(accountId);

      if (qrCode) {
        // Extract base64 data from data URL
        const base64Data = qrCode.replace("data:image/png;base64,", "");
        const imageBuffer = Buffer.from(base64Data, "base64");

        // Set headers for image display
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Length", imageBuffer.length);
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");

        return res.send(imageBuffer);
      } else {
        return res.status(404).send(`
          <html>
          <head>
            <title>QR Code Not Available - ${accountId}</title>
            <meta http-equiv="refresh" content="5">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .container { max-width: 600px; margin: 0 auto; }
              .status { padding: 20px; border-radius: 8px; margin: 20px 0; }
              .qr-pending { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; }
              .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
              .refresh-btn {
                background: #007bff; color: white; padding: 10px 20px;
                text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px;
              }
              .back-btn {
                background: #6c757d; color: white; padding: 10px 20px;
                text-decoration: none; border-radius: 5px; display: inline-block; margin: 10px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>QR Code Not Available</h1>
              <div class="status qr-pending">
                <h3>Account: ${existingAccount.name} (${accountId})</h3>
                <p>Status: ${existingAccount.status}</p>
                <p>QR code is not available for this account.</p>
                <p>This page will auto-refresh every 5 seconds.</p>
              </div>

              <h3>What to do:</h3>
              <ul style="text-align: left; display: inline-block;">
                <li>If status is "disconnected", click Connect button in dashboard</li>
                <li>If status is "connecting", wait for QR code to generate</li>
                <li>If status is "connected", QR code is not needed</li>
                <li>If QR code expired, reconnect the account</li>
              </ul>

              <div>
                <a href="/api/accounts/${accountId}/qr/image" class="refresh-btn">🔄 Refresh QR</a>
                <a href="/" class="back-btn">← Back to Dashboard</a>
              </div>

              <p><small>Account created: ${existingAccount.created_at}</small></p>
            </div>
          </body>
          </html>
        `);
      }
    } catch (error) {
      serverLogger.error(
        `Failed to display QR image for account ${req.params.accountId}:`,
        error,
      );
      return res.status(500).send(`
        <html><body>
          <h1>Internal Server Error</h1>
          <p>Failed to load QR code for account: ${req.params.accountId}</p>
          <p><a href="/">← Back to Dashboard</a></p>
        </body></html>
      `);
    }
  },
);

/**
 * GET /accounts/:accountId/qr/page
 * Display QR code in a nice HTML page
 */
router.get(
  "/:accountId/qr/page",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      if (!accountId) {
        return res.status(400).send(`
          <html><body>
            <h1>Error: Account ID is required</h1>
            <p><a href="/">← Back to Dashboard</a></p>
          </body></html>
        `);
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).send(`
          <html><body>
            <h1>Account Not Found</h1>
            <p>Account ID: ${accountId}</p>
            <p><a href="/">← Back to Dashboard</a></p>
          </body></html>
        `);
      }

      const qrCode = whatsappService.getAccountQRCode(accountId);
      const socketAccount = whatsappService.getAccount(accountId);

      return res.send(`
        <html>
        <head>
          <title>WhatsApp QR Code - ${existingAccount.name}</title>
          <meta http-equiv="refresh" content="10">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              margin: 0; padding: 20px; min-height: 100vh;
            }
            .container {
              max-width: 600px; margin: 0 auto; background: white;
              border-radius: 15px; padding: 30px; text-align: center;
              box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            }
            .header {
              border-bottom: 2px solid #f0f0f0; padding-bottom: 20px; margin-bottom: 30px;
            }
            .header h1 {
              background: linear-gradient(135deg, #667eea, #764ba2);
              -webkit-background-clip: text; -webkit-text-fill-color: transparent;
              margin: 0 0 10px 0; font-size: 2em;
            }
            .qr-container {
              margin: 30px 0; padding: 20px; background: #f8f9fa;
              border-radius: 10px; border: 2px dashed #dee2e6;
            }
            .qr-code {
              max-width: 300px; width: 100%; border: 3px solid #f0f0f0;
              border-radius: 10px; display: block; margin: 0 auto;
            }
            .status {
              padding: 15px; border-radius: 8px; margin: 20px 0; font-weight: 600;
            }
            .status.qr_pending { background: #cce5ff; color: #004085; }
            .status.connected { background: #d4edda; color: #155724; }
            .status.connecting { background: #fff3cd; color: #856404; }
            .status.disconnected { background: #f8d7da; color: #721c24; }
            .instructions {
              text-align: left; background: #e7f3ff; padding: 20px;
              border-radius: 8px; margin: 20px 0; border-left: 4px solid #007bff;
            }
            .instructions ol { margin: 10px 0; }
            .instructions li { margin: 8px 0; line-height: 1.6; }
            .btn {
              display: inline-block; padding: 12px 24px; margin: 10px;
              text-decoration: none; border-radius: 8px; font-weight: 600;
              transition: all 0.3s; border: none; cursor: pointer;
            }
            .btn-primary { background: linear-gradient(135deg, #667eea, #764ba2); color: white; }
            .btn-secondary { background: #6c757d; color: white; }
            .btn:hover { transform: translateY(-2px); }
            .account-info {
              background: #f8f9fa; padding: 15px; border-radius: 8px;
              margin: 20px 0; text-align: left;
            }
            .account-info strong { color: #495057; }
            @media (max-width: 768px) {
              .container { margin: 10px; padding: 20px; }
              .header h1 { font-size: 1.5em; }
              .qr-code { max-width: 250px; }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📱 WhatsApp QR Code</h1>
              <p>Scan to connect your WhatsApp account</p>
            </div>

            <div class="account-info">
              <strong>Account Name:</strong> ${existingAccount.name}<br>
              <strong>Account ID:</strong> ${accountId}<br>
              <strong>Status:</strong> <span class="status ${existingAccount.status}">${existingAccount.status.replace("_", " ").toUpperCase()}</span><br>
              <strong>Created:</strong> ${new Date(existingAccount.created_at).toLocaleString()}
              ${existingAccount.phone_number ? `<br><strong>Phone:</strong> +${existingAccount.phone_number}` : ""}
            </div>

            <div class="qr-container">
              ${
                qrCode
                  ? `
                <img src="/api/accounts/${accountId}/qr/image"
                     alt="WhatsApp QR Code"
                     class="qr-code"
                     onerror="this.style.display='none'; document.getElementById('qr-error').style.display='block';">
                <div id="qr-error" style="display:none;">
                  <h3>❌ QR Code Failed to Load</h3>
                  <p>Please refresh the page or reconnect the account.</p>
                </div>
              `
                  : `
                <h3>⏳ QR Code Not Available</h3>
                <p>Status: ${existingAccount.status}</p>
                <p>Please wait or reconnect the account...</p>
              `
              }
            </div>

            ${
              qrCode
                ? `
              <div class="instructions">
                <h3>📋 How to Connect:</h3>
                <ol>
                  <li><strong>Open WhatsApp</strong> on your phone</li>
                  <li>Tap <strong>Menu (⋯)</strong> → <strong>Linked Devices</strong></li>
                  <li>Tap <strong>"Link a Device"</strong></li>
                  <li><strong>Scan this QR code</strong> with your phone</li>
                  <li>Wait for connection confirmation</li>
                </ol>
                <p><strong>⚠️ Note:</strong> QR code expires in ~30 seconds. Refresh if needed.</p>
              </div>
            `
                : ""
            }

            <div>
              <a href="/api/accounts/${accountId}/qr/page" class="btn btn-primary">🔄 Refresh QR</a>
              <a href="/" class="btn btn-secondary">← Dashboard</a>
              <a href="/api/accounts/${accountId}" class="btn btn-secondary">📊 Account Info</a>
            </div>

            <p><small>This page auto-refreshes every 10 seconds</small></p>
          </div>
        </body>
        </html>
      `);
    } catch (error) {
      serverLogger.error(
        `Failed to display QR page for account ${req.params.accountId}:`,
        error,
      );
      return res.status(500).send(`
        <html><body>
          <h1>Internal Server Error</h1>
          <p>Failed to load QR page for account: ${req.params.accountId}</p>
          <p><a href="/">← Back to Dashboard</a></p>
        </body></html>
      `);
    }
  },
);

/**
 * GET /accounts/:accountId/messages
 * Get messages for specific account
 */
router.get(
  "/:accountId/messages",
  validateRequest(accountIdParamSchema, "params"),
  validateRequest(paginationSchema, "query"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const { limit, offset } = req.query;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).json(createErrorResponse("Account not found"));
      }

      const parsedLimit = parseInt(limit as string) || 50;
      const parsedOffset = parseInt(offset as string) || 0;

      const messages = await databaseManager.getMessages(
        accountId,
        parsedLimit,
        parsedOffset,
      );

      return res.json(
        createSuccessResponse(
          {
            messages,
            pagination: {
              limit: parsedLimit,
              offset: parsedOffset,
              count: messages.length,
            },
          },
          "Messages retrieved successfully",
        ),
      );
    } catch (error) {
      serverLogger.error(
        `Failed to get messages for account ${req.params.accountId}:`,
        error,
      );
      return res
        .status(500)
        .json(createErrorResponse("Failed to retrieve messages"));
    }
  },
);

/**
 * GET /accounts/:accountId/stats
 * Get statistics for specific account
 */
router.get(
  "/:accountId/stats",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      // Check if account exists
      const existingAccount = await databaseManager.getAccount(accountId);
      if (!existingAccount) {
        return res.status(404).json(createErrorResponse("Account not found"));
      }

      // Get message counts
      const messages = await databaseManager.getMessages(accountId, 1000, 0); // Get last 1000 messages for stats

      const stats = {
        totalMessages: messages.length,
        inboundMessages: messages.filter((m) => m.direction === "inbound")
          .length,
        outboundMessages: messages.filter((m) => m.direction === "outbound")
          .length,
        pendingWebhooks: messages.filter((m) => !m.webhook_sent).length,
        messageTypes: {
          text: messages.filter((m) => m.type === "text").length,
          image: messages.filter((m) => m.type === "image").length,
          video: messages.filter((m) => m.type === "video").length,
          audio: messages.filter((m) => m.type === "audio").length,
          document: messages.filter((m) => m.type === "document").length,
          sticker: messages.filter((m) => m.type === "sticker").length,
        },
        lastMessage: messages[0] || null,
      };

      return res.json(
        createSuccessResponse(
          stats,
          "Account statistics retrieved successfully",
        ),
      );
    } catch (error) {
      serverLogger.error(
        `Failed to get stats for account ${req.params.accountId}:`,
        error,
      );
      return res
        .status(500)
        .json(createErrorResponse("Failed to retrieve account statistics"));
    }
  },
);

// Clear sessions endpoint for fixing decryption errors
router.post(
  "/:accountId/clear-sessions",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      await whatsappService.clearSessions(accountId);

      return res.json({
        success: true,
        message: "Sessions cleared successfully. You can now reconnect.",
        data: {
          accountId,
          status: "sessions_cleared",
        },
      });
    } catch (error) {
      serverLogger.error(
        `Failed to clear sessions for account ${req.params.accountId}:`,
        error,
      );
      return res
        .status(500)
        .json(createErrorResponse("Failed to clear sessions"));
    }
  },
);

// Force reconnect endpoint (clears sessions and reconnects)
router.post(
  "/:accountId/force-reconnect",
  validateRequest(accountIdParamSchema, "params"),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      if (!accountId) {
        return res
          .status(400)
          .json(createErrorResponse("Account ID is required"));
      }

      const result = await whatsappService.forceReconnect(accountId);

      return res.json({
        success: result.success,
        message: result.success
          ? "Account force reconnected successfully"
          : "Force reconnect failed",
        data: {
          accountId,
          qrCode: result.qrCode,
          requiresQRScan: !!result.qrCode,
        },
      });
    } catch (error) {
      serverLogger.error(
        `Failed to force reconnect account ${req.params.accountId}:`,
        error,
      );
      return res
        .status(500)
        .json(createErrorResponse("Failed to force reconnect account"));
    }
  },
);

export default router;
