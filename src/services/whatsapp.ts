import { messageInterceptor } from "./message-interceptor";
import { messageContentExtractor } from "./message-content-extractor";
import makeWASocket, {
  DisconnectReason,
  ConnectionState,
  WASocket,
  BaileysEventMap,
  AuthenticationState,
  AuthenticationCreds,
  SignalDataTypeMap,
  WAMessage,
  WAMessageContent,
  proto,
  useMultiFileAuthState,
  MessageUpsertType,
  WAMessageUpdate,
  Chat,
  Contact,
} from "baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import path from "path";
import fs from "fs/promises";
import { EventEmitter } from "events";
import { databaseManager, Account, Message } from "../models/database";
import { webhookService } from "./webhook";
import { messageProcessor } from "./message-processor";
import { cleanPhoneNumber } from "../utils/phone-utils";
import {
  whatsappLogger,
  logWhatsAppEvent,
  baileysLogger,
} from "../utils/logger";
import {
  normalizePhoneNumber,
  sanitizeMessageContent,
  getCurrentTimestamp,
  generateMessageId,
} from "../utils/validation";

// Global message store for cross-reference
const messageStore = new Map<string, any>();

// Enhanced message interceptor for debugging and protocol capture
const originalBaileysDebug = baileysLogger.debug;
const originalBaileysInfo = baileysLogger.info;
const originalBaileysWarn = baileysLogger.warn;

// Intercept all Baileys logging to capture actual message content
baileysLogger.debug = (obj: unknown, msg?: string) => {
  // Gunakan message content extractor untuk menangkap konten asli
  messageContentExtractor.interceptAllData(obj);
  captureMessageFromLog(obj, msg, 'debug');
  originalBaileysDebug(obj, msg);
};

baileysLogger.info = (obj: unknown, msg?: string) => {
  messageContentExtractor.interceptAllData(obj);
  captureMessageFromLog(obj, msg, 'info');
  originalBaileysInfo(obj, msg);
};

baileysLogger.warn = (obj: unknown, msg?: string) => {
  messageContentExtractor.interceptAllData(obj);
  captureMessageFromLog(obj, msg, 'warn');
  originalBaileysWarn(obj, msg);
};

function captureMessageFromLog(obj: unknown, msg?: string, level?: string) {
  if (typeof obj === "object" && obj !== null) {
    const msgObj = obj as any;

    // Look for raw protocol messages with actual content
    if (msg && typeof msg === 'string') {
      // Check for WebSocket messages containing actual text
      if (msg.includes('recv') || msg.includes('message')) {
        try {
          // Try to parse if it's a stringified JSON
          const parsed = typeof obj === 'string' ? JSON.parse(obj) : obj;
          if (parsed && parsed.message && parsed.key) {
            whatsappLogger.info("🎯 Raw message with content found:", {
              messageId: parsed.key.id,
              hasMessage: !!parsed.message,
              content: parsed.message.conversation || parsed.message.extendedTextMessage?.text || 'Other content',
            });

            // Store and process immediately
            messageStore.set(parsed.key.id, parsed);
            setTimeout(async () => {
              try {
                await messageProcessor.processIncomingMessage("account_2", parsed, "6285156808928");
              } catch (error) {
                whatsappLogger.error("Error processing raw message:", error);
              }
            }, 50);
          }
        } catch (e) {
          // Not JSON, continue
        }
      }
    }

    // Enhanced capture for complete message objects
    if (msgObj.key && msgObj.key.id && msgObj.message && !msgObj.key.fromMe) {
      whatsappLogger.info("📨 Complete message object found:", {
        messageId: msgObj.key.id,
        from: msgObj.key.remoteJid,
        hasConversation: !!msgObj.message.conversation,
        hasExtendedText: !!msgObj.message.extendedTextMessage,
        content: msgObj.message.conversation || msgObj.message.extendedTextMessage?.text || 'Other type',
      });

      // Store in message store for immediate processing
      messageStore.set(msgObj.key.id, msgObj);

      // Process immediately
      setTimeout(async () => {
        try {
          await messageProcessor.processIncomingMessage("account_2", msgObj, "6285156808928");
        } catch (error) {
          whatsappLogger.error("Error processing complete message:", error);
        }
      }, 50);
    }

    // Capture protocol receipt/ack messages and try to correlate with content
    if (msgObj.recv && msgObj.recv.tag === "message" && msgObj.recv.attrs) {
      const attrs = msgObj.recv.attrs;
      whatsappLogger.info("🎯 Protocol message receipt:", {
        messageId: attrs.id,
        from: attrs.from,
        to: attrs.recipient || attrs.to,
        type: attrs.type,
        notify: attrs.notify,
        allAttrs: JSON.stringify(attrs) // Show all available fields
      });

      // Look for any message content in the surrounding context
      const messageKey = attrs.id;

      // Check if we already have content for this message
      setTimeout(async () => {
        const existingMessage = messageStore.get(messageKey);
        if (!existingMessage || !existingMessage.message) {
          // Wait for actual content - do NOT create placeholder messages
          whatsappLogger.debug("Protocol message receipt logged, waiting for actual content:", {
            messageId: messageKey,
            from: attrs.from,
            notify: attrs.notify,
            note: "Will only process when actual message content is available"
          });

          // Check if content extractor has the actual content
          const actualContent = messageContentExtractor.getMessageContent(messageKey);
          if (actualContent) {
            whatsappLogger.info("Found actual content for protocol message:", {
              messageId: messageKey,
              content: actualContent.substring(0, 100),
              source: "content_extractor"
            });

            const messageWithContent: any = {
              key: {
                id: attrs.id,
                fromMe: false,
                remoteJid: attrs.from,
              },
              message: {
                conversation: actualContent
              },
              messageTimestamp: parseInt(attrs.t || Math.floor(Date.now() / 1000).toString()),
            };

            try {
              await messageProcessor.processIncomingMessage("account_2", messageWithContent, attrs.recipient?.split("@")[0] || "6281316088377");
            } catch (error) {
              whatsappLogger.error("Error processing protocol message with content:", error);
            }
          }
          // If no actual content found, skip creating placeholder - let messages.upsert handle it
        }
      }, 500);
    }

    // Look for any object containing text content
    const objStr = JSON.stringify(msgObj);
    if (objStr.includes('"conversation"') || objStr.includes('"text"') || objStr.includes('"extendedTextMessage"')) {
      whatsappLogger.debug("Text content detected in object:", {
        hasConversation: objStr.includes('"conversation"'),
        hasText: objStr.includes('"text"'),
        hasExtended: objStr.includes('"extendedTextMessage"'),
        sample: objStr.substring(0, 200),
      });

      // Try to extract and correlate with message IDs
      try {
        if (msgObj.conversation && typeof msgObj.conversation === 'string') {
          whatsappLogger.info("🎯 Found standalone conversation text:", {
            content: msgObj.conversation.substring(0, 100),
          });
        }
      } catch (e) {
        // Continue
      }
    }
  }
}

export interface WhatsAppAccount {
  id: string;
  name: string;
  socket: WASocket | null;
  qrCode: string | null;
  status: "connected" | "disconnected" | "connecting" | "qr_pending";
  phoneNumber?: string | undefined;
  lastSeen?: Date;
  authState?: AuthenticationState;
}

export interface MessageData {
  id: string;
  accountId: string;
  from: string;
  to: string;
  message: string;
  timestamp: string;
  type: "text" | "image" | "video" | "audio" | "document" | "sticker";
  direction: "inbound" | "outbound";
  messageId: string;
  rawData: string;
}

export class WhatsAppService extends EventEmitter {
  protected accounts: Map<string, WhatsAppAccount> = new Map();
  private readonly sessionsPath: string;
  private isInitialized: boolean = false;
  private webhookProcessingInterval: NodeJS.Timeout | null = null;
  private sessionSaveInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.sessionsPath = path.join(process.cwd(), "sessions");
    this.setupEventHandlers();
  }

  /**
   * Initialize WhatsApp service
   */
  async initialize(): Promise<void> {
    try {
      // Ensure sessions directory exists
      await this.ensureSessionsDirectory();

      // Load existing accounts from database
      await this.loadExistingAccounts();

      // Start webhook processing
      this.startWebhookProcessing();

      // Start periodic session saving
      this.startSessionSaving();

      this.isInitialized = true;
      whatsappLogger.info("WhatsApp service initialized successfully");
    } catch (error) {
      whatsappLogger.error("Failed to initialize WhatsApp service:", error);
      throw error;
    }
  }

  /**
   * Create new WhatsApp account
   */
  async createAccount(
    accountId: string,
    name: string,
  ): Promise<{ success: boolean; qrCode?: string; error?: string }> {
    try {
      if (this.accounts.has(accountId)) {
        return { success: false, error: "Account already exists" };
      }

      // Create account in database
      await databaseManager.createAccount({
        id: accountId,
        phone_number: null as any,
        name,
        status: "qr_pending",
      });

      // Create WhatsApp account
      const account: WhatsAppAccount = {
        id: accountId,
        name,
        socket: null,
        qrCode: null,
        status: "qr_pending",
      };

      this.accounts.set(accountId, account);

      logWhatsAppEvent(accountId, "Account created successfully");

      // Automatically start connection to generate QR code
      const connectResult = await this.connectAccount(accountId);

      if (connectResult.qrCode) {
        return {
          success: true,
          qrCode: connectResult.qrCode,
        };
      } else {
        return {
          success: true,
        };
      }
    } catch (error) {
      whatsappLogger.error(`Failed to create account ${accountId}:`, error);
      return { success: false, error: "Internal server error" };
    }
  }

  /**
   * Connect WhatsApp account
   */
  async connectAccount(
    accountId: string,
  ): Promise<{ success: boolean; qrCode?: string; error?: string }> {
    try {
      const account = this.accounts.get(accountId);
      if (!account) {
        return { success: false, error: "Account not found" };
      }

      if (account.socket) {
        account.socket.end(undefined);
      }

      // Setup auth state
      const authDir = path.join(this.sessionsPath, accountId);
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      account.authState = state;

      // Create socket
      const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: baileysLogger,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        emitOwnEvents: true,
        shouldIgnoreJid: () => false,
        shouldSyncHistoryMessage: () => true,
        getMessage: async (key) => {
          whatsappLogger.debug(`getMessage called for ${accountId}`, {
            key,
            messageId: key.id,
            remoteJid: key.remoteJid,
          });

          // Try to get from message store first
          const stored = messageStore.get(key.id || "");
          if (stored?.message) {
            whatsappLogger.info(`Retrieved stored message for ${key.id}`, {
              hasConversation: !!stored.message.conversation,
              hasExtended: !!stored.message.extendedTextMessage,
              content: stored.message.conversation || stored.message.extendedTextMessage?.text || 'Other content',
            });
            return stored.message;
          }

          // If not found, try to get from database
          try {
            const dbMessage = await databaseManager.getDatabase().get(
              "SELECT raw_data FROM messages WHERE message_id = ?",
              [key.id]
            );

            if (dbMessage && dbMessage.raw_data) {
              const parsedMessage = JSON.parse(dbMessage.raw_data);
              if (parsedMessage.message) {
                whatsappLogger.info(`Retrieved message from database for ${key.id}`);
                return parsedMessage.message;
              }
            }
          } catch (dbError) {
            whatsappLogger.debug(`Could not retrieve message from database: ${dbError}`);
          }

          whatsappLogger.debug(`No message found for ${key.id}, returning empty conversation`);
          return { conversation: "" };
        },

        browser: ["Ubuntu", "Chrome", "22.04.4"],
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5,
        qrTimeout: 60000,
        connectTimeoutMs: 60000,
        transactionOpts: {
          maxCommitRetries: 10,
          delayBetweenTriesMs: 3000,
        },
      });

      account.socket = socket;
      account.status = "connecting";

      await databaseManager.updateAccountStatus(accountId, "connecting");

      // Setup event handlers for this socket
      whatsappLogger.debug(
        `[${accountId}] DEBUG: About to call setupSocketEventHandlers`,
      );
      this.setupSocketEventHandlers(accountId, socket, saveCreds);
      whatsappLogger.debug(
        `[${accountId}] DEBUG: setupSocketEventHandlers call completed`,
      );

      // Add aggressive message capturing - hook into all socket events
      const originalEmit = socket.ev.emit.bind(socket.ev);
      socket.ev.emit = function (event: string, ...args: any[]) {
        // Capture all events that might contain message data
        if (event.includes('message') || event.includes('Message') || event === 'messages.upsert') {
          whatsappLogger.info(`[${accountId}] 🎯 Socket event captured: ${event}`, {
            argsCount: args.length,
            hasData: args.length > 0,
            firstArgType: args[0] ? typeof args[0] : 'none',
          });

          // Process message data if available
          args.forEach((arg, index) => {
            if (arg && typeof arg === 'object') {
              // Check for message arrays
              if (arg.messages && Array.isArray(arg.messages)) {
                whatsappLogger.info(`[${accountId}] Processing messages from event ${event}:`, {
                  messageCount: arg.messages.length,
                });

                arg.messages.forEach(async (msg: any, msgIndex: number) => {
                  whatsappLogger.info(`[${accountId}] 🔍 Analyzing message ${msgIndex + 1}:`, {
                    messageId: msg?.key?.id,
                    from: msg?.key?.remoteJid,
                    fromMe: msg?.key?.fromMe,
                    hasMessage: !!msg?.message,
                    messageKeys: msg?.message ? Object.keys(msg.message) : [],
                    fullMessageStructure: JSON.stringify(msg).substring(0, 300),
                  });

                  if (msg && msg.key && msg.key.id && msg.message) {
                    // Skip status broadcasts but allow both incoming and outgoing messages
                    if (msg.key.remoteJid?.includes("status@broadcast")) {
                      whatsappLogger.debug(`[${accountId}] Skipping status broadcast: ${msg.key.id}`);
                      return;
                    }

                    whatsappLogger.info(`[${accountId}] 🎯 Found actual message in event:`, {
                      messageId: msg.key.id,
                      from: msg.key.remoteJid,
                      fromMe: msg.key.fromMe,
                      hasConversation: !!msg.message.conversation,
                      hasExtended: !!msg.message.extendedTextMessage,
                      content: msg.message.conversation || msg.message.extendedTextMessage?.text || 'Other content type',
                    });

                    // Store and process immediately
                    messageStore.set(msg.key.id, msg);

                    setTimeout(async () => {
                      try {
                        const recipientPhone = cleanPhoneNumber(socket.user?.id) || "6285156808928";
                        await messageProcessor.processIncomingMessage(accountId, msg, recipientPhone);
                        whatsappLogger.info(`[${accountId}] ✅ Processed message from event: ${msg.key.id}`);
                      } catch (error) {
                        whatsappLogger.error(`[${accountId}] ❌ Error processing message from event:`, error);
                      }
                    }, 50);
                  }
                });
              }
              // Check for single message
              else if (arg.key && arg.key.id && arg.message && !arg.key.fromMe) {
                whatsappLogger.info(`[${accountId}] 🎯 Found single message in event:`, {
                  messageId: arg.key.id,
                  from: arg.key.remoteJid,
                  content: arg.message.conversation || arg.message.extendedTextMessage?.text || 'Other content type',
                });

                messageStore.set(arg.key.id, arg);

                setTimeout(async () => {
                  try {
                    const recipientPhone = cleanPhoneNumber(socket.user?.id) || "6285156808928";
                    await messageProcessor.processIncomingMessage(accountId, arg, recipientPhone);
                    whatsappLogger.info(`[${accountId}] ✅ Processed single message from event: ${arg.key.id}`);
                  } catch (error) {
                    whatsappLogger.error(`[${accountId}] ❌ Error processing single message from event:`, error);
                  }
                }, 50);
              }
            }
          });
        }

        // Call original emit
        return (originalEmit as any)(event, ...args);
      };

      whatsappLogger.info(
        `Socket created and event handlers attached for ${accountId}`,
      );

      // Wait for QR code or connection
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          account.status = "disconnected";
          resolve({ success: false, error: "Connection timeout" });
        }, 60000); // Increased timeout to 60 seconds

        let qrGenerated = false;
        let resolved = false;

        socket.ev.on("connection.update", (update) => {
          const { connection, lastDisconnect, qr } = update;

          if (qr && !qrGenerated) {
            qrGenerated = true;
            QRCode.toDataURL(qr, (err, url) => {
              if (!err && url) {
                account.qrCode = url;
                account.status = "qr_pending";
                databaseManager.updateAccountStatus(accountId, "qr_pending");

                whatsappLogger.info(
                  `QR code generated for account ${accountId}`,
                );
                this.emit("qr-generated", { accountId, qrCode: url });

                // Don't resolve immediately, keep waiting for connection
                if (resolved) return;
                clearTimeout(timeout);
                resolve({ success: true, qrCode: url });
                resolved = true; // Prevent multiple resolves
              }
            });
          }

          if (connection === "open") {
            account.status = "connected";
            account.qrCode = null; // Clear QR code when connected
            databaseManager.updateAccountStatus(accountId, "connected");

            whatsappLogger.info(`Account ${accountId} connected successfully`);
            this.emit("account-connected", { accountId });

            if (!resolved) {
              clearTimeout(timeout);
              resolve({ success: true });
              resolved = true;
            }
          }

          if (connection === "close") {
            account.status = "disconnected";
            account.qrCode = null;
            databaseManager.updateAccountStatus(accountId, "disconnected");

            const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
            whatsappLogger.warn(
              `Account ${accountId} connection closed: ${reason}`,
            );
            this.emit("account-disconnected", {
              accountId,
              shouldReconnect: false,
            });

            if (!resolved) {
              clearTimeout(timeout);
              resolve({
                success: false,
                error: `Connection closed: ${reason}`,
              });
              resolved = true;
            }
          }
        });
      });
    } catch (error) {
      whatsappLogger.error(`Failed to connect account ${accountId}:`, error);
      return { success: false, error: "Connection failed" };
    }
  }

  /**
   * Disconnect WhatsApp account
   */
  async disconnectAccount(
    accountId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const account = this.accounts.get(accountId);
      if (!account) {
        return { success: false, error: "Account not found" };
      }

      if (account.socket) {
        account.socket.end(undefined);
        account.socket = null;
      }

      account.status = "disconnected";
      account.qrCode = null;

      await databaseManager.updateAccountStatus(accountId, "disconnected");

      logWhatsAppEvent(accountId, "Account disconnected");
      this.emit("account-disconnected", { accountId });

      return { success: true };
    } catch (error) {
      whatsappLogger.error(`Failed to disconnect account ${accountId}:`, error);
      return { success: false, error: "Disconnect failed" };
    }
  }

  /**
   * Delete WhatsApp account
   */
  async deleteAccount(
    accountId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Disconnect first
      await this.disconnectAccount(accountId);

      // Remove from memory
      this.accounts.delete(accountId);

      // Delete from database
      await databaseManager.deleteAccount(accountId);

      // Delete session files
      const authDir = path.join(this.sessionsPath, accountId);
      try {
        await fs.rm(authDir, { recursive: true, force: true });
      } catch (err) {
        whatsappLogger.warn(
          `Failed to delete session files for ${accountId}:`,
          err,
        );
      }

      logWhatsAppEvent(accountId, "Account deleted");
      this.emit("account-deleted", { accountId });

      return { success: true };
    } catch (error) {
      whatsappLogger.error(`Failed to delete account ${accountId}:`, error);
      return { success: false, error: "Delete failed" };
    }
  }

  /**
   * Get account information
   */
  getAccount(accountId: string): WhatsAppAccount | null {
    return this.accounts.get(accountId) || null;
  }

  /**
   * Get all accounts
   */
  getAllAccounts(): WhatsAppAccount[] {
    return Array.from(this.accounts.values());
  }

  /**
   * Get account QR code
   */
  getAccountQRCode(accountId: string): string | null {
    const account = this.accounts.get(accountId);
    return account?.qrCode || null;
  }

  /**
   * Setup socket event handlers
   */
  private setupSocketEventHandlers(
    accountId: string,
    socket: WASocket,
    saveCreds: () => Promise<void>,
  ): void {
    whatsappLogger.debug(
      `[${accountId}] DEBUG: Starting setupSocketEventHandlers`,
    );
    whatsappLogger.info(`Setting up event handlers for ${accountId}`);

    socket.ev.on("connection.update", async (update) => {
      await this.handleConnectionUpdate(accountId, update);
    });

    socket.ev.on("creds.update", saveCreds);

    // Multiple event listeners for comprehensive message capture
    whatsappLogger.debug(
      `[${accountId}] DEBUG: About to attach messages.upsert event listener`,
    );

    // Add debug to confirm event listener is attached
    whatsappLogger.debug(
      `[${accountId}] DEBUG: Socket event emitter exists: ${!!socket.ev}`,
    );
    whatsappLogger.debug(
      `[${accountId}] DEBUG: Socket event emitter type: ${typeof socket.ev}`,
    );

    socket.ev.on("messages.upsert", async (messageUpdate) => {
      whatsappLogger.info(
        `[${accountId}] 🔔 messages.upsert event triggered with ${messageUpdate.messages.length} messages`,
        {
          messageCount: messageUpdate.messages.length,
          type: messageUpdate.type,
          messageIds: messageUpdate.messages.map((m) => m.key.id),
          fromMeFlags: messageUpdate.messages.map((m) => m.key.fromMe),
          remoteJids: messageUpdate.messages.map((m) => m.key.remoteJid),
          hasMessageContent: messageUpdate.messages.map((m) => !!m.message),
          actualContent: messageUpdate.messages.map((m) => {
            if (m.message?.conversation) return m.message.conversation.substring(0, 50);
            if (m.message?.extendedTextMessage?.text) return m.message.extendedTextMessage.text.substring(0, 50);
            return "No text content";
          }),
        },
      );

      try {
        whatsappLogger.info(
          `[${accountId}] 🎯 Processing ${messageUpdate.messages.length} messages via upsert event`,
        );

        // Process each message individually with enhanced error handling
        for (const message of messageUpdate.messages) {
          try {
            // Skip status broadcasts but allow both incoming and outgoing messages
            if (message.key.remoteJid?.includes("status@broadcast")) {
              whatsappLogger.debug(`[${accountId}] Skipping status broadcast: ${message.key.id}`);
              continue;
            }

            whatsappLogger.info(`[${accountId}] Processing individual message`, {
              messageId: message.key.id,
              from: message.key.remoteJid,
              fromMe: message.key.fromMe,
              hasMessage: !!message.message,
              messageContent: message.message ? Object.keys(message.message) : [],
              timestamp: message.messageTimestamp,
              actualText: message.message?.conversation || message.message?.extendedTextMessage?.text || "No text found",
            });

            const account = this.accounts.get(accountId);
            const recipientPhone = cleanPhoneNumber(account?.socket?.user?.id) || "6285156808928";

            // Store message for later retrieval WITH ACTUAL CONTENT
            if (message.key.id && message.message) {
              messageStore.set(message.key.id, {
                ...message,
                actualContent: message.message.conversation || message.message.extendedTextMessage?.text,
                timestamp: Date.now(),
              });

              whatsappLogger.info(`[${accountId}] Stored message with actual content`, {
                messageId: message.key.id,
                actualContent: message.message.conversation || message.message.extendedTextMessage?.text || "Other type",
                storedSuccessfully: true,
              });
            }

            // Process with message processor (primary method) - ini akan menggunakan konten asli
            await messageProcessor.processIncomingMessage(accountId, message, recipientPhone);

            whatsappLogger.info(`[${accountId}] ✅ Successfully processed message: ${message.key.id}`);

          } catch (messageError) {
            whatsappLogger.error(`[${accountId}] ❌ Failed to process individual message`, {
              messageId: message.key.id,
              error: messageError instanceof Error ? messageError.message : String(messageError),
              stack: messageError instanceof Error ? messageError.stack : undefined,
            });
          }
        }

        // Also use original handler as backup
        await this.handleMessagesUpsert(accountId, messageUpdate);

        whatsappLogger.info(`[${accountId}] ✅ All messages processed via upsert event`);
      } catch (error) {
        whatsappLogger.error(
          `[${accountId}] ❌ Message processing failed:`,
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        );
      }
    });

    // Handle session errors and decryption failures
    socket.ev.on("creds.update", async () => {
      whatsappLogger.info(`[${accountId}] Credentials updated`);
      await saveCreds();
    });

    // Add error handling for session issues
    socket.ev.on("message-receipt.update" as any, async (updates: any[]) => {
      for (const update of updates) {
        if (update.receipt && update.receipt.receiptTimestamp) {
          whatsappLogger.debug(`[${accountId}] Message receipt updated`, {
            messageId: update.key?.id,
            receiptType: update.receipt.type,
          });
        }
      }
    });

    // Enhanced ACK handler to capture protocol messages
    socket.ev.on("CB:ack" as any, (data: any) => {
      whatsappLogger.debug(`[${accountId}] CB:ack event`, {
        messageId: data?.attrs?.id,
        from: data?.attrs?.from,
        fullData: JSON.stringify(data).substring(0, 500),
      });

      // Check if this ACK corresponds to an incoming message
      if (data?.recv && data?.recv.tag === "message" && data?.recv.attrs) {
        const attrs = data.recv.attrs;

        whatsappLogger.info(`[${accountId}] 🎯 ACK for incoming message detected`, {
          messageId: attrs.id,
          from: attrs.from,
          recipient: attrs.recipient,
          type: attrs.type,
          notify: attrs.notify,
          timestamp: attrs.t,
        });

        // Process this as a message if we haven't seen it before AND we have actual content
        if (!this.processedMessages.has(attrs.id)) {
          // Check if we have actual content for this message
          const actualContent = messageContentExtractor.getMessageContent(attrs.id);

          if (actualContent) {
            whatsappLogger.info(`[${accountId}] 🎯 ACK with actual content found:`, {
              messageId: attrs.id,
              content: actualContent.substring(0, 100),
              from: attrs.from,
            });

            try {
              const waMessage: any = {
                key: {
                  id: attrs.id,
                  fromMe: false,
                  remoteJid: attrs.from,
                },
                message: {
                  conversation: actualContent
                },
                messageTimestamp: parseInt(attrs.t || Math.floor(Date.now() / 1000).toString()),
              };

              const recipientPhone = attrs.recipient?.split("@")[0] || "6281316088377";

              setTimeout(async () => {
                try {
                  await messageProcessor.processIncomingMessage(accountId, waMessage, recipientPhone);
                  whatsappLogger.info(`[${accountId}] ✅ Processed ACK message with actual content: ${attrs.id}`);
                } catch (error) {
                  whatsappLogger.error(`[${accountId}] ❌ Error processing ACK message:`, error);
                }
              }, 200);

            } catch (error) {
              whatsappLogger.error(`[${accountId}] Error creating message from ACK:`, error);
            }
          } else {
            whatsappLogger.debug(`[${accountId}] ACK received but no actual content available yet for message: ${attrs.id}`, {
              from: attrs.from,
              notify: attrs.notify,
              note: "Waiting for actual content via messages.upsert event"
            });
          }
        }
      }
    });

    // Handle connection errors that might indicate session issues
    socket.ev.on("connection.update", async (update) => {
      if (update.lastDisconnect?.error) {
        const error = update.lastDisconnect.error;
        whatsappLogger.error(`[${accountId}] Connection error detected`, {
          error: error.message,
          output: (error as any)?.output,
        });

        // Check if this is a session-related error
        if (
          error.message?.includes("session") ||
          error.message?.includes("decrypt") ||
          error.message?.includes("MAC")
        ) {
          whatsappLogger.error(
            `[${accountId}] Session error detected - may need to clear sessions and reconnect`,
          );

          // Optionally auto-clear sessions and reconnect
          // Uncomment the following lines if you want automatic session recovery
          /*
          try {
            await this.deleteAccount(accountId);
            whatsappLogger.info(`[${accountId}] Session cleared due to decryption errors`);
          } catch (clearError) {
            whatsappLogger.error(`[${accountId}] Failed to clear corrupted session:`, clearError);
          }
          */
        }
      }
    });

    whatsappLogger.debug(
      `[${accountId}] DEBUG: messages.upsert event listener attached successfully`,
    );

    socket.ev.on("messages.update", async (messageUpdates) => {
      whatsappLogger.info(`[${accountId}] messages.update event triggered`, {
        updateCount: messageUpdates.length,
      });
      await this.handleMessagesUpdate(accountId, messageUpdates);
    });

    // Additional event listeners for message capture
    socket.ev.on("message-receipt.update", async (updates) => {
      whatsappLogger.debug(`[${accountId}] message-receipt.update event`, {
        updateCount: updates.length,
      });
    });

    // Capture messages from history sync
    socket.ev.on("messaging-history.set", async (historySet) => {
      whatsappLogger.info(`[${accountId}] messaging-history.set event`, {
        messageCount: historySet.messages?.length || 0,
        isLatest: historySet.isLatest,
      });

      if (historySet.messages && historySet.messages.length > 0) {
        whatsappLogger.info(`[${accountId}] Processing ${historySet.messages.length} history messages`);

        // Process each history message individually
        for (const historyMessage of historySet.messages) {
          if (historyMessage.message && !historyMessage.key.fromMe && !historyMessage.key.remoteJid?.includes("status@broadcast")) {
            const recipientPhone = cleanPhoneNumber(this.accounts.get(accountId)?.socket?.user?.id) || "6285156808928";

            whatsappLogger.info(`[${accountId}] Processing history message with content:`, {
              messageId: historyMessage.key.id,
              from: historyMessage.key.remoteJid,
              messageTypes: Object.keys(historyMessage.message),
            });

            try {
              await messageProcessor.processIncomingMessage(accountId, historyMessage, recipientPhone);
            } catch (error) {
              whatsappLogger.error(`[${accountId}] Error processing history message:`, error);
            }
          }
        }
      }
    });

    // Monitor creds update for session changes
    socket.ev.on("creds.update", async () => {
      whatsappLogger.debug(`[${accountId}] Credentials updated - session state changed`);
    });

    // Add more comprehensive message monitoring
    socket.ev.on("blocklist.set", async (blocklist) => {
      whatsappLogger.debug(`[${accountId}] Blocklist updated`, { count: blocklist.blocklist?.length || 0 });
    });

    socket.ev.on("groups.update", async (groups) => {
      whatsappLogger.debug(`[${accountId}] Groups updated`, { count: groups.length });
    });

    // Alternative message capture for Baileys
    socket.ev.on("messages.reaction", async (reactions) => {
      whatsappLogger.debug(`[${accountId}] messages.reaction event`, {
        reactionCount: reactions.length,
      });
    });

    socket.ev.on("presence.update", async (presenceUpdate) => {
      whatsappLogger.debug(
        `[${accountId}] presence.update event`,
        presenceUpdate,
      );
      logWhatsAppEvent(accountId, "Presence update", presenceUpdate);
    });

    socket.ev.on("chats.upsert", async (chats) => {
      whatsappLogger.debug(`[${accountId}] chats.upsert event`, {
        count: chats.length,
      });
      logWhatsAppEvent(accountId, "Chats upsert", { count: chats.length });
    });

    socket.ev.on("contacts.upsert", async (contacts) => {
      whatsappLogger.debug(`[${accountId}] contacts.upsert event`, {
        count: contacts.length,
      });
      logWhatsAppEvent(accountId, "Contacts upsert", {
        count: contacts.length,
      });
    });

    // Event listeners setup completed - onAny not available in this version

    // Add comprehensive message monitoring
    whatsappLogger.info(
      `[${accountId}] 🔍 Setting up comprehensive message monitoring`,
    );

    // Monitor all possible message-related events
    socket.ev.on("messages.set" as any, async (data: any) => {
      whatsappLogger.info(`[${accountId}] 📊 messages.set event`, {
        messageCount: data.messages?.length || 0,
        isLatest: data.isLatest,
      });

      // Process history messages if they exist
      if (data.messages && data.messages.length > 0) {
        whatsappLogger.info(
          `[${accountId}] 🔄 Processing messages.set as upsert`,
          {
            messageCount: data.messages.length,
          },
        );

        await this.handleMessagesUpsert(accountId, {
          messages: data.messages,
          type: "notify" as MessageUpsertType,
        });
      }
    });

    // Monitor for any missed message events
    socket.ev.on("message" as any, async (message: any) => {
      whatsappLogger.info(
        `[${accountId}] 📨 Individual message event detected`,
        {
          hasKey: !!message?.key,
          messageId: message?.key?.id,
          fromMe: message?.key?.fromMe,
          remoteJid: message?.key?.remoteJid,
        },
      );

      if (message && message.key && message.key.id) {
        // Convert single message to upsert format
        await this.handleMessagesUpsert(accountId, {
          messages: [message],
          type: "notify" as MessageUpsertType,
        });
      }
    });

    // Monitor for baileys internal events - enhanced for better message capture
    socket.ev.on("CB:notification" as any, (data: any) => {
      whatsappLogger.debug(`[${accountId}] 🔔 CB:notification`, {
        type: data?.attrs?.type,
        from: data?.attrs?.from,
      });
    });

    socket.ev.on("CB:message" as any, async (data: any) => {
      whatsappLogger.info(`[${accountId}] 🚨 CB:message event detected`, {
        hasAttrs: !!data?.attrs,
        messageId: data?.attrs?.id,
        from: data?.attrs?.from,
        type: data?.attrs?.type,
        hasContent: !!data?.content,
        fullData: JSON.stringify(data).substring(0, 500),
      });

      // Enhanced CB:message processing for actual content
      if (data?.attrs?.id && data?.attrs?.from && !data.attrs.from.includes("status@broadcast")) {
        // Try to get the actual message content from the socket's message store
        const messageId = data.attrs.id;
        const storedMessage = messageStore.get(messageId);

        if (storedMessage && storedMessage.message) {
          whatsappLogger.info(`[${accountId}] Found stored message content for CB:message`);
          const recipientPhone = cleanPhoneNumber(this.accounts.get(accountId)?.socket?.user?.id) || "6285156808928";

          try {
            await messageProcessor.processIncomingMessage(accountId, storedMessage, recipientPhone);
          } catch (error) {
            whatsappLogger.error(`[${accountId}] Error processing CB:message with stored content:`, error);
          }
        } else {
          // Create a message from the CB:message data itself
          whatsappLogger.warn(`[${accountId}] CB:message has no stored content, checking for actual content`);

          try {
            // Check if we have actual content from the enhanced interceptor
            const storedInfo = messageStore.get(messageId);
            let messageContent = "Message received";

            if (storedInfo?.actualContent) {
              messageContent = storedInfo.actualContent;
              whatsappLogger.info(`[${accountId}] Found actual content from interceptor: ${messageContent.substring(0, 50)}`);
            } else {
              messageContent = `Message from ${data.attrs.notify || "Unknown"} at ${new Date().toLocaleTimeString()}`;
            }

            const fakeMessage: any = {
              key: {
                id: data.attrs.id,
                fromMe: false,
                remoteJid: data.attrs.from,
              },
              message: {
                conversation: messageContent
              },
              messageTimestamp: parseInt(data.attrs.t || Math.floor(Date.now() / 1000).toString()),
            };

            const recipientPhone = cleanPhoneNumber(this.accounts.get(accountId)?.socket?.user?.id) || "6285156808928";

            whatsappLogger.info(`[${accountId}] Processing CB:message with extracted content`, {
              messageId: fakeMessage.key.id,
              from: fakeMessage.key.remoteJid,
              content: messageContent.substring(0, 100),
              hasActualContent: !!storedInfo?.actualContent,
            });

            await messageProcessor.processIncomingMessage(accountId, fakeMessage, recipientPhone);

          } catch (error) {
            whatsappLogger.error(`[${accountId}] Error processing CB:message as fake message:`, error);
          }
        }
      }
    });

    // Add more internal event listeners for comprehensive capture
    socket.ev.on("CB:ack" as any, (data: any) => {
      whatsappLogger.debug(`[${accountId}] CB:ack event`, {
        messageId: data?.attrs?.id,
        from: data?.attrs?.from,
      });
    });

    socket.ev.on("CB:receipt" as any, (data: any) => {
      whatsappLogger.debug(`[${accountId}] CB:receipt event`, {
        messageId: data?.attrs?.id,
        from: data?.attrs?.from,
        type: data?.attrs?.type,
        recipient: data?.attrs?.recipient,
        to: data?.attrs?.to,
        fullData: JSON.stringify(data).substring(0, 300),
      });

      // Try to process receipt as a message indicator
      if (data?.attrs?.id && data?.attrs?.from && data?.attrs?.type === "sender") {
        whatsappLogger.info(`[${accountId}] 📨 Processing receipt as message indicator`, {
          messageId: data.attrs.id,
          from: data.attrs.from,
          recipient: data.attrs.recipient,
        });

        // Create a placeholder message from receipt data
        try {
          const fakeMessage: any = {
            key: {
              id: data.attrs.id,
              fromMe: false,
              remoteJid: data.attrs.from,
            },
            message: {
              conversation: `Message received via receipt (ID: ${data.attrs.id})`
            },
            messageTimestamp: Math.floor(Date.now() / 1000),
          };

          const recipientPhone = cleanPhoneNumber(this.accounts.get(accountId)?.socket?.user?.id) || "6285156808928";

          // Process with a small delay to allow proper message to arrive first
          setTimeout(async () => {
            try {
              await messageProcessor.processIncomingMessage(accountId, fakeMessage, recipientPhone);
              whatsappLogger.info(`[${accountId}] ✅ Processed receipt as message`);
            } catch (error) {
              whatsappLogger.error(`[${accountId}] ❌ Error processing receipt as message:`, error);
            }
          }, 500);

        } catch (error) {
          whatsappLogger.error(`[${accountId}] Error creating message from receipt:`, error);
        }
      }
    });

    socket.ev.on("chats.set" as any, (data: any) => {
      whatsappLogger.debug(`[${accountId}] DEBUG: chats.set event`, {
        chatCount: data.length,
      });
    });

    socket.ev.on("contacts.set" as any, (data: any) => {
      whatsappLogger.debug(`[${accountId}] DEBUG: contacts.set event`, {
        contactCount: data.length,
      });
    });

    socket.ev.on("chats.update" as any, (data: any) => {
      whatsappLogger.debug(`[${accountId}] DEBUG: chats.update event`, {
        count: data.length,
      });
    });

    socket.ev.on("presence.update" as any, (data: any) => {
      whatsappLogger.debug(`[${accountId}] DEBUG: presence.update event`, {
        data,
      });
    });

    // Add a test to verify event emitter is working
    socket.ev.on("test-event" as any, () => {
      whatsappLogger.info(
        `[${accountId}] 🧪 Test event received - event emitter is working`,
      );
    });

    // Emit test event to verify
    setTimeout(() => {
      try {
        (socket.ev as any).emit("test-event");
        whatsappLogger.info(
          `[${accountId}] 🧪 Test event emitted successfully`,
        );
      } catch (error) {
        whatsappLogger.error(
          `[${accountId}] ❌ Failed to emit test event:`,
          error,
        );
      }
    }, 1000);

    // Monitor all events with onAny if available
    if (typeof (socket.ev as any).onAny === "function") {
      (socket.ev as any).onAny((eventName: string, ...args: any[]) => {
        if (eventName.includes("message") || eventName.includes("upsert")) {
          whatsappLogger.info(
            `[${accountId}] 🎯 Event captured by onAny: ${eventName}`,
            {
              argsCount: args.length,
              firstArgType: args[0] ? typeof args[0] : "undefined",
              hasMessages: args[0]?.messages
                ? args[0].messages.length
                : "no messages property",
            },
          );
        }
      });
      whatsappLogger.info(`[${accountId}] 🎯 onAny event monitor attached`);
    } else {
      whatsappLogger.warn(
        `[${accountId}] ⚠️ onAny method not available on event emitter`,
      );
    }

    // Final debug message
    whatsappLogger.debug(
      `[${accountId}] DEBUG: All event listeners attached - Total events monitored: messages.upsert, messages.update, connection.update, creds.update, message-receipt.update, chats.update, presence.update, chats.set, contacts.set, messages.set, message, CB:notification, CB:message`,
    );
    whatsappLogger.info(`✅ Event handlers setup completed for ${accountId}`);
  }

  /**
   * Handle connection updates
   */
  private async handleConnectionUpdate(
    accountId: string,
    update: Partial<ConnectionState>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;
    const account = this.accounts.get(accountId);

    if (!account) return;

    logWhatsAppEvent(accountId, "Connection update", { connection, qr: !!qr });

    if (qr) {
      try {
        const qrCode = await QRCode.toDataURL(qr);
        account.qrCode = qrCode;
        account.status = "qr_pending";

        await databaseManager.updateAccountStatus(accountId, "qr_pending");
        this.emit("qr-updated", { accountId, qrCode });
      } catch (error) {
        whatsappLogger.error(
          `Failed to generate QR code for ${accountId}:`,
          error,
        );
      }
    }

    if (connection === "open") {
      account.status = "connected";
      account.qrCode = null;
      account.lastSeen = new Date();

      // Get phone number from socket
      const phoneNumber = account.socket?.user?.id?.split(":")[0];
      if (phoneNumber) {
        account.phoneNumber = normalizePhoneNumber(phoneNumber);
        messageInterceptor.registerAccount(accountId, account.phoneNumber);
        await databaseManager.updateAccountStatus(
          accountId,
          "connected",
          account.phoneNumber,
        );
      } else {
        await databaseManager.updateAccountStatus(accountId, "connected");
      }

      logWhatsAppEvent(accountId, "Connected successfully", {
        phoneNumber: account.phoneNumber,
      });
      this.emit("account-connected", {
        accountId,
        phoneNumber: account.phoneNumber,
      });

      // Process any messages that might have been missed during connection
      setTimeout(async () => {
        await this.processOfflineMessages(accountId);
      }, 2000);
    }

    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !==
        DisconnectReason.loggedOut;

      account.status = "disconnected";
      account.socket = null;
      account.qrCode = null;

      await databaseManager.updateAccountStatus(accountId, "disconnected");

      logWhatsAppEvent(accountId, "Connection closed", {
        reason: lastDisconnect?.error,
        shouldReconnect,
      });

      this.emit("account-disconnected", { accountId, shouldReconnect });

      // Auto-reconnect if not logged out
      if (shouldReconnect) {
        setTimeout(() => {
          this.connectAccount(accountId);
        }, 5000);
      }
    }
  }

  /**
   * Handle new messages with comprehensive processing
   */
  private async handleMessagesUpsert(
    accountId: string,
    { messages, type }: { messages: WAMessage[]; type: MessageUpsertType },
  ): Promise<void> {
    whatsappLogger.info(
      `[${accountId}] handleMessagesUpsert called with ${messages.length} messages`,
      {
        type,
        messageKeys: messages.map((m) => ({
          id: m.key.id,
          fromMe: m.key.fromMe,
          remoteJid: m.key.remoteJid,
          messageTimestamp: m.messageTimestamp,
          hasMessage: !!m.message,
          messageContent: m.message ? Object.keys(m.message) : [],
        })),
      },
    );

    for (const message of messages) {
      const messageId = message.key.id;

      // Skip if already processed or currently processing
      if (this.isMessageProcessed(messageId || undefined)) {
        whatsappLogger.debug(
          `[${accountId}] ⏭️ Skipping already processed message`,
          {
            messageId,
            remoteJid: message.key.remoteJid,
          },
        );
        continue;
      }

      // Mark as being processed to prevent duplicates
      if (messageId) {
        const processingPromise = this.processMessageSafely(
          accountId,
          message,
          type,
        );
        this.processingMessages.set(messageId, processingPromise);

        try {
          await processingPromise;
        } catch (error) {
          whatsappLogger.error(`[${accountId}] ❌ FAILED TO PROCESS MESSAGE:`, {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            messageId: message.key.id,
            fromMe: message.key.fromMe,
          });
        } finally {
          this.processingMessages.delete(messageId);
        }
      }
    }
  }

  private async processMessageSafely(
    accountId: string,
    message: WAMessage,
    type: MessageUpsertType,
  ): Promise<void> {
    try {
      whatsappLogger.info(`[${accountId}] 🔍 DETAILED MESSAGE ANALYSIS`, {
        messageId: message.key.id,
        fromMe: message.key.fromMe,
        type,
        remoteJid: message.key.remoteJid,
        hasContent: !!message.message,
        messageTimestamp: message.messageTimestamp,
        messageKeys: message.message ? Object.keys(message.message) : [],
        isStatusBroadcast: message.key.remoteJid?.includes("status@broadcast"),
        fullMessage: JSON.stringify(message, null, 2).substring(0, 800),
      });

      // Skip status broadcasts
      if (message.key.remoteJid?.includes("status@broadcast")) {
        whatsappLogger.info(
          `[${accountId}] ⏭️ Skipping status broadcast message`,
          {
            messageId: message.key.id,
            from: message.key.remoteJid,
          },
        );
        return;
      }

      // Process based on message direction
      if (!message.key.fromMe) {
        // Incoming message
        whatsappLogger.info(`[${accountId}] 📥 PROCESSING INCOMING MESSAGE`, {
          messageId: message.key.id,
          from: message.key.remoteJid,
          type,
          hasMessage: !!message.message,
        });
        await this.processIncomingMessage(accountId, message);
      } else if (message.key.fromMe) {
        // Outgoing message
        whatsappLogger.info(`[${accountId}] 📤 PROCESSING OUTGOING MESSAGE`, {
          messageId: message.key.id,
          to: message.key.remoteJid,
          type,
          hasMessage: !!message.message,
        });
        await this.processOutgoingMessage(accountId, message);
      } else {
        whatsappLogger.warn(`[${accountId}] ❓ UNKNOWN MESSAGE TYPE`, {
          messageId: message.key.id,
          fromMe: message.key.fromMe,
          remoteJid: message.key.remoteJid,
        });
      }
    } catch (error) {
      whatsappLogger.error(`[${accountId}] ❌ Error in processMessageSafely:`, {
        error: error instanceof Error ? error.message : String(error),
        messageId: message.key.id,
      });
      throw error;
    }
  }

  /**
   * Simple check to avoid duplicate processing
   */
  private processedMessages = new Set<string>();
  private processingMessages = new Map<string, Promise<void>>();

  private isMessageProcessed(messageId: string | undefined): boolean {
    if (!messageId) return false;
    return (
      this.processedMessages.has(messageId) ||
      this.processingMessages.has(messageId)
    );
  }

  private markMessageAsProcessed(messageId: string | undefined): void {
    if (messageId) {
      this.processedMessages.add(messageId);
      // Clean up old entries to prevent memory leak
      if (this.processedMessages.size > 1000) {
        const entries = Array.from(this.processedMessages);
        this.processedMessages.clear();
        entries.slice(-500).forEach((id) => this.processedMessages.add(id));
      }
    }
  }

  /**
   * Handle message updates
   */
  private async handleMessagesUpdate(
    accountId: string,
    updates: WAMessageUpdate[],
  ): Promise<void> {
    for (const update of updates) {
      logWhatsAppEvent(accountId, "Message update", update);
    }
  }

  /**
   * Process incoming message with enhanced handling
   */
  private async processIncomingMessage(
    accountId: string,
    message: WAMessage,
  ): Promise<void> {
    whatsappLogger.info(`[${accountId}] 🔄 Original processIncomingMessage called:`, {
      messageId: message.key.id,
      from: message.key.remoteJid,
      hasMessage: !!message.message,
    });

    // Also process with new message processor
    if (!message.key.fromMe && message.message) {
      const account = this.accounts.get(accountId);
      const recipientPhone = cleanPhoneNumber(account?.socket?.user?.id) || "6285156808928";

      try {
        await messageProcessor.processIncomingMessage(accountId, message, recipientPhone);
        whatsappLogger.info(`[${accountId}] ✅ Message processor handled message successfully`);
      } catch (error) {
        whatsappLogger.error(`[${accountId}] ❌ Message processor failed:`, error);
      }
    }
    const messageId = message.key.id;

    whatsappLogger.info(`[${accountId}] 🔄 PROCESSING INCOMING MESSAGE START`, {
      messageId,
      remoteJid: message.key.remoteJid,
      hasMessage: !!message.message,
      messageTimestamp: message.messageTimestamp,
    });

    // Skip if already processed
    if (this.isMessageProcessed(messageId || undefined)) {
      whatsappLogger.info(`[${accountId}] ⏭️ Message already processed`, {
        messageId,
      });
      return;
    }

    // Check for decryption errors or corrupted messages
    if (!message.message && !message.messageStubType) {
      whatsappLogger.warn(
        `[${accountId}] ⚠️ Message has no content - possible decryption failure`,
        {
          messageId,
          remoteJid: message.key.remoteJid,
          participant: message.key.participant,
          messageTimestamp: message.messageTimestamp,
        },
      );
      return;
    }

    whatsappLogger.info(`[${accountId}] 🔍 Extracting message data`, {
      messageId,
      remoteJid: message.key.remoteJid,
      hasMessage: !!message.message,
      messageTimestamp: message.messageTimestamp,
      messageContent: message.message ? Object.keys(message.message) : [],
    });

    const messageData = this.extractMessageData(accountId, message, "inbound");
    if (!messageData) {
      whatsappLogger.error(`[${accountId}] ❌ FAILED TO EXTRACT MESSAGE DATA`, {
        messageId,
        remoteJid: message.key.remoteJid,
        messageContent: message.message,
        messageKeys: message.message ? Object.keys(message.message) : [],
        possibleDecryptionIssue: !message.message && !message.messageStubType,
        fullMessage: JSON.stringify(message, null, 2).substring(0, 1000),
      });
      return;
    }

    whatsappLogger.info(`[${accountId}] ✅ MESSAGE DATA EXTRACTED`, {
      messageId: messageData.messageId,
      from: messageData.from,
      to: messageData.to,
      type: messageData.type,
      direction: messageData.direction,
      timestamp: messageData.timestamp,
      messageLength: messageData.message.length,
    });

    // Mark as processed before saving
    this.markMessageAsProcessed(messageId || undefined);

    whatsappLogger.info(`[${accountId}] 💾 SAVING MESSAGE TO DATABASE`, {
      messageId: messageData.messageId,
      from: messageData.from,
      to: messageData.to,
      type: messageData.type,
      dbId: messageData.id,
      message:
        messageData.message.substring(0, 100) +
        (messageData.message.length > 100 ? "..." : ""),
    });

    try {
      // Save to database
      await databaseManager.saveMessage({
        id: messageData.id,
        account_id: messageData.accountId,
        from: messageData.from,
        to: messageData.to,
        message: messageData.message,
        timestamp: messageData.timestamp,
        type: messageData.type,
        direction: messageData.direction,
        message_id: messageData.messageId,
        raw_data: messageData.rawData,
        webhook_sent: false,
        webhook_attempts: 0,
      });

      whatsappLogger.info(
        `[${accountId}] ✅ MESSAGE SAVED TO DATABASE SUCCESSFULLY`,
        {
          messageId: messageData.messageId,
          dbId: messageData.id,
          from: messageData.from,
          to: messageData.to,
          type: messageData.type,
        },
      );

      logWhatsAppEvent(accountId, "Incoming message received", {
        from: messageData.from,
        type: messageData.type,
        messageId: messageData.messageId,
      });

      this.emit("message-received", messageData);

      whatsappLogger.info(`[${accountId}] 🚀 TRIGGERING WEBHOOK PROCESSING`, {
        messageId: messageData.messageId,
      });

      // Trigger immediate webhook processing for new messages
      setTimeout(async () => {
        try {
          await this.triggerWebhookProcessing();
        } catch (error) {
          whatsappLogger.error("Error in immediate webhook trigger:", error);
        }
      }, 100);
    } catch (error) {
      whatsappLogger.error(
        `[${accountId}] ❌ FAILED TO SAVE MESSAGE TO DATABASE`,
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          messageData: {
            id: messageData.id,
            messageId: messageData.messageId,
            from: messageData.from,
            to: messageData.to,
            type: messageData.type,
          },
        },
      );
      throw error;
    }
  }

  /**
   * Process outgoing message
   */
  private async processOutgoingMessage(
    accountId: string,
    message: WAMessage,
  ): Promise<void> {
    whatsappLogger.info(`[${accountId}] 📤 PROCESSING OUTGOING MESSAGE`, {
      messageId: message.key.id,
      to: message.key.remoteJid,
      hasMessage: !!message.message,
    });

    const messageData = this.extractMessageData(accountId, message, "outbound");
    if (!messageData) {
      whatsappLogger.error(
        `[${accountId}] ❌ Failed to extract outgoing message data`,
        {
          messageId: message.key.id,
          to: message.key.remoteJid,
        },
      );
      return;
    }

    whatsappLogger.info(
      `[${accountId}] 💾 SAVING OUTGOING MESSAGE TO DATABASE`,
      {
        messageId: messageData.messageId,
        from: messageData.from,
        to: messageData.to,
        type: messageData.type,
      },
    );

    try {
      // Save to database
      await databaseManager.saveMessage({
        id: messageData.id,
        account_id: messageData.accountId,
        from: messageData.from,
        to: messageData.to,
        message: messageData.message,
        timestamp: messageData.timestamp,
        type: messageData.type,
        direction: messageData.direction,
        message_id: messageData.messageId,
        raw_data: messageData.rawData,
        webhook_sent: false,
        webhook_attempts: 0,
      });

      whatsappLogger.info(
        `[${accountId}] ✅ OUTGOING MESSAGE SAVED SUCCESSFULLY`,
        {
          messageId: messageData.messageId,
          dbId: messageData.id,
          to: messageData.to,
          type: messageData.type,
        },
      );

      logWhatsAppEvent(accountId, "Outgoing message sent", {
        to: messageData.to,
        type: messageData.type,
        messageId: messageData.messageId,
      });

      this.emit("message-sent", messageData);
    } catch (error) {
      whatsappLogger.error(
        `[${accountId}] ❌ FAILED TO SAVE OUTGOING MESSAGE`,
        {
          error: error instanceof Error ? error.message : String(error),
          messageData: {
            id: messageData.id,
            messageId: messageData.messageId,
            to: messageData.to,
            type: messageData.type,
          },
        },
      );
      throw error;
    }
  }

  /**
   * Extract message data from WAMessage
   */
  private extractMessageData(
    accountId: string,
    message: WAMessage,
    direction: "inbound" | "outbound",
  ): MessageData | null {
    try {
      whatsappLogger.info(`[${accountId}] 🔍 EXTRACTING MESSAGE DATA START`, {
        messageId: message.key.id,
        direction,
        hasMessage: !!message.message,
        messageKeys: message.message ? Object.keys(message.message) : [],
        remoteJid: message.key.remoteJid,
        participant: message.key.participant,
        messageTimestamp: message.messageTimestamp,
      });

      const content = message.message;
      if (!content) {
        whatsappLogger.error(`[${accountId}] ❌ NO MESSAGE CONTENT FOUND`, {
          messageId: message.key.id,
          direction,
          remoteJid: message.key.remoteJid,
          messageStubType: message.messageStubType,
          fullMessage: JSON.stringify(message, null, 2).substring(0, 500),
        });
        return null;
      }

      whatsappLogger.info(`[${accountId}] ✅ Message content found`, {
        messageId: message.key.id,
        contentKeys: Object.keys(content),
        contentTypes: Object.keys(content).map(
          (key) => `${key}: ${typeof content[key as keyof typeof content]}`,
        ),
      });

      let messageText = "";
      let messageType: MessageData["type"] = "text";

      // Extract message content based on type
      if (content.conversation) {
        messageText = content.conversation;
        messageType = "text";
        whatsappLogger.info(`[${accountId}] 💬 Extracted conversation text`, {
          messageText: messageText.substring(0, 100),
          textLength: messageText.length,
        });
      } else if (content.extendedTextMessage?.text) {
        messageText = content.extendedTextMessage.text;
        messageType = "text";
        whatsappLogger.info(`[${accountId}] 💬 Extracted extended text`, {
          messageText: messageText.substring(0, 100),
          textLength: messageText.length,
        });
      } else if (content.imageMessage) {
        messageText = content.imageMessage.caption || "[Image]";
        messageType = "image";
        whatsappLogger.info(`[${accountId}] 🖼️ Extracted image message`, {
          caption: content.imageMessage.caption,
          hasCaption: !!content.imageMessage.caption,
        });
      } else if (content.videoMessage) {
        messageText = content.videoMessage.caption || "[Video]";
        messageType = "video";
        whatsappLogger.info(`[${accountId}] 🎥 Extracted video message`, {
          caption: content.videoMessage.caption,
          hasCaption: !!content.videoMessage.caption,
        });
      } else if (content.audioMessage) {
        messageText = "[Audio]";
        messageType = "audio";
        whatsappLogger.info(`[${accountId}] 🎵 Extracted audio message`);
      } else if (content.documentMessage) {
        messageText = content.documentMessage.title || "[Document]";
        messageType = "document";
        whatsappLogger.info(`[${accountId}] 📄 Extracted document message`, {
          title: content.documentMessage.title,
          hasTitle: !!content.documentMessage.title,
        });
      } else if (content.stickerMessage) {
        messageText = "[Sticker]";
        messageType = "sticker";
        whatsappLogger.info(`[${accountId}] 🎭 Extracted sticker message`);
      } else {
        messageText = "[Unsupported message type]";
        whatsappLogger.error(`[${accountId}] ❌ UNSUPPORTED MESSAGE TYPE`, {
          messageKeys: Object.keys(content),
          messageId: message.key.id,
          contentSample: JSON.stringify(content, null, 2).substring(0, 500),
        });
      }

      // Get phone numbers
      const remoteJid = message.key.remoteJid || "";
      let fromNumber = "";

      whatsappLogger.info(`[${accountId}] 📞 Processing phone numbers`, {
        remoteJid,
        hasParticipant: !!message.key.participant,
        participant: message.key.participant,
        isGroup: remoteJid.includes("@g.us"),
      });

      if (remoteJid.includes("@g.us")) {
        // Group message - extract participant
        const participant = message.key.participant || "";
        fromNumber = participant ? participant.split("@")[0] || "" : "";
        whatsappLogger.info(`[${accountId}] 👥 Group message detected`, {
          groupJid: remoteJid,
          participant: participant,
          fromNumber,
        });
      } else {
        // Direct message
        fromNumber = remoteJid ? remoteJid.split("@")[0] || "" : "";
        whatsappLogger.info(`[${accountId}] 👤 Direct message detected`, {
          remoteJid,
          fromNumber,
        });
      }

      const account = this.accounts.get(accountId);
      const toNumber = account?.phoneNumber || accountId;

      whatsappLogger.info(
        `[${accountId}] 🔄 Processing direction and numbers`,
        {
          direction,
          fromNumber,
          toNumber,
          accountExists: !!account,
          accountPhoneNumber: account?.phoneNumber,
        },
      );

      const from =
        direction === "inbound"
          ? normalizePhoneNumber(fromNumber)
          : normalizePhoneNumber(toNumber);
      const to =
        direction === "inbound"
          ? normalizePhoneNumber(toNumber)
          : normalizePhoneNumber(fromNumber);

      whatsappLogger.info(`[${accountId}] ✅ Phone numbers normalized`, {
        direction,
        originalFrom: fromNumber,
        originalTo: toNumber,
        normalizedFrom: from,
        normalizedTo: to,
      });

      const messageData = {
        id: generateMessageId(),
        accountId,
        from,
        to,
        message: sanitizeMessageContent(messageText),
        type: messageType,
        direction,
        messageId: message.key.id || generateMessageId(),
        timestamp:
          message.messageTimestamp?.toString() || getCurrentTimestamp(),
        rawData: JSON.stringify(message),
      };

      whatsappLogger.info(
        `[${accountId}] 🎉 MESSAGE DATA EXTRACTION COMPLETE`,
        {
          messageId: messageData.messageId,
          from: messageData.from,
          to: messageData.to,
          type: messageData.type,
          direction: messageData.direction,
          timestamp: messageData.timestamp,
          messageLength: messageData.message.length,
          success: true,
        },
      );

      return messageData;
    } catch (error) {
      whatsappLogger.error(`[${accountId}] ❌ ERROR EXTRACTING MESSAGE DATA`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        messageId: message.key.id,
        direction,
        remoteJid: message.key.remoteJid,
        hasMessage: !!message.message,
        messageKeys: message.message ? Object.keys(message.message) : [],
      });
      return null;
    }
  }

  /**
   * Send test message to verify message handling
   */
  async sendTestMessage(
    accountId: string,
    to: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const account = this.accounts.get(accountId);
      if (!account || !account.socket) {
        return { success: false, error: "Account not found or not connected" };
      }

      const testMessage = `Test message from WhatsApp Server - ${new Date().toISOString()}`;

      whatsappLogger.info(`Sending test message from ${accountId} to ${to}`, {
        message: testMessage,
      });

      const result = await account.socket.sendMessage(to, {
        text: testMessage,
      });

      whatsappLogger.info(`Test message sent successfully`, {
        messageId: result?.key?.id,
        to,
      });

      // Force immediate webhook processing for test message
      setTimeout(async () => {
        try {
          await this.triggerWebhookProcessing();
        } catch (error) {
          whatsappLogger.error("Error in immediate webhook processing:", error);
        }
      }, 500);

      return { success: true };
    } catch (error) {
      whatsappLogger.error(`Failed to send test message for ${accountId}`, {
        error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Setup event handlers
   * Setup service event handlers
   */
  private setupEventHandlers(): void {
    // Handle process termination
    process.on("SIGINT", async () => {
      await this.shutdown();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await this.shutdown();
      process.exit(0);
    });
  }

  /**
   * Load existing accounts from database
   */
  private async loadExistingAccounts(): Promise<void> {
    try {
      const accounts = await databaseManager.getAllAccounts();

      for (const dbAccount of accounts) {
        const account: WhatsAppAccount = {
          id: dbAccount.id,
          name: dbAccount.name,
          socket: null,
          qrCode: null,
          status: "disconnected",
          phoneNumber: dbAccount.phone_number || undefined,
        };

        this.accounts.set(dbAccount.id, account);

        // Auto-connect all accounts with session files
        if (true) {
          setTimeout(() => {
            this.connectAccount(dbAccount.id);
          }, 2000);
        }
      }

      whatsappLogger.info(`Loaded ${accounts.length} existing accounts`);
    } catch (error) {
      whatsappLogger.error("Failed to load existing accounts:", error);
    }
  }

  /**
   * Ensure sessions directory exists
   */
  private async ensureSessionsDirectory(): Promise<void> {
    try {
      await fs.access(this.sessionsPath);
    } catch {
      await fs.mkdir(this.sessionsPath, { recursive: true });
      whatsappLogger.info(`Created sessions directory: ${this.sessionsPath}`);
    }
  }

  /**
   * Start webhook processing
   */
  private startWebhookProcessing(): void {
    this.webhookProcessingInterval = setInterval(async () => {
      try {
        const pendingMessages =
          await databaseManager.getPendingWebhookMessages();

        if (pendingMessages.length > 0) {
          whatsappLogger.info(
            `Processing ${pendingMessages.length} pending webhook messages`,
          );

          const results = await webhookService.sendBatch(pendingMessages);

          whatsappLogger.info(`Webhook batch completed`, {
            total: pendingMessages.length,
            successful: results.successful,
            failed: results.failed,
          });

          // Update database with results
          for (const result of results.results) {
            const message = pendingMessages.find(
              (m) => m.id === result.messageId,
            );
            if (message) {
              await databaseManager.updateMessageWebhookStatus(
                result.messageId,
                result.success,
                result.attempts,
              );
            }
          }
        } else {
          whatsappLogger.debug("No pending webhook messages found");
        }
      } catch (error) {
        whatsappLogger.error("Error processing webhook messages:", error);
      }
    }, 2000); // Process every 2 seconds for faster delivery

    whatsappLogger.info(
      "Webhook processing started - checking every 2 seconds for maximum responsiveness",
    );
  }

  /**
   * Start periodic session saving
   */
  private startSessionSaving(): void {
    this.sessionSaveInterval = setInterval(() => {
      // Session saving is handled automatically by Baileys
      // This interval can be used for additional periodic tasks
      logWhatsAppEvent("system", "Periodic session save check");
    }, 60000); // Every minute

    whatsappLogger.info("Session saving started");
  }

  /**
   * Shutdown service
   */
  async shutdown(): Promise<void> {
    whatsappLogger.info("Shutting down WhatsApp service...");

    // Clear intervals
    if (this.webhookProcessingInterval) {
      clearInterval(this.webhookProcessingInterval);
    }

    if (this.sessionSaveInterval) {
      clearInterval(this.sessionSaveInterval);
    }

    // Disconnect all accounts
    for (const [accountId] of this.accounts) {
      await this.disconnectAccount(accountId);
    }

    this.accounts.clear();
    this.isInitialized = false;

    whatsappLogger.info("WhatsApp service shutdown complete");
  }

  /**
   * Process offline messages manually
   */
  private async processOfflineMessages(accountId: string): Promise<void> {
    whatsappLogger.info(`Processing offline messages for ${accountId}`);

    try {
      const account = this.accounts.get(accountId);
      if (!account?.socket) {
        whatsappLogger.warn(`No socket available for ${accountId}`);
        return;
      }

      // Check if there are any unprocessed messages in the last hour
      const oneHourAgo = Date.now() - 60 * 60 * 1000;

      // Force a history sync to capture any missed messages
      whatsappLogger.info(`Requesting message history for ${accountId}`);

      // This will trigger messaging-history.set event if there are messages
      setTimeout(() => {
        whatsappLogger.info(
          `Finished offline message processing for ${accountId}`,
        );
      }, 1000);
    } catch (error) {
      whatsappLogger.error(
        `Error processing offline messages for ${accountId}:`,
        error,
      );
    }
  }

  /**
   * Manual webhook trigger for immediate processing
   */
  async triggerWebhookProcessing(): Promise<void> {
    whatsappLogger.info("Manual webhook processing triggered");

    try {
      const pendingMessages = await databaseManager.getPendingWebhookMessages();

      if (pendingMessages.length > 0) {
        whatsappLogger.info(
          `Processing ${pendingMessages.length} pending webhook messages manually`,
        );

        const results = await webhookService.sendBatch(pendingMessages);

        whatsappLogger.info(`Manual webhook batch completed`, {
          total: pendingMessages.length,
          successful: results.successful,
          failed: results.failed,
        });

        // Update database with results
        for (const result of results.results) {
          const message = pendingMessages.find(
            (m) => m.id === result.messageId,
          );
          if (message) {
            await databaseManager.updateMessageWebhookStatus(
              result.messageId,
              result.success,
              result.attempts,
            );
          }
        }
      } else {
        whatsappLogger.debug(
          "No pending webhook messages found for manual processing",
        );
      }
    } catch (error) {
      whatsappLogger.error("Error in manual webhook processing:", error);
    }
  }

  /**
   * Clear corrupted sessions for an account
   */
  async clearSessions(accountId: string): Promise<void> {
    try {
      const account = this.accounts.get(accountId);
      if (account && account.socket) {
        whatsappLogger.info(`Clearing sessions for ${accountId}`);

        // Close the current connection
        try {
          account.socket.end(undefined);
        } catch (closeError) {
          whatsappLogger.warn(
            `Error closing socket for ${accountId}:`,
            closeError,
          );
        }

        // Clear session files
        const sessionPath = path.join(this.sessionsPath, accountId);
        try {
          await fs.rm(sessionPath, { recursive: true, force: true });
          whatsappLogger.info(`Session files cleared for ${accountId}`);
        } catch (error) {
          whatsappLogger.warn(
            `Failed to clear session files for ${accountId}:`,
            error,
          );
        }

        // Update account status
        account.status = "disconnected";
        account.socket = null;
        account.qrCode = null;

        await databaseManager.updateAccountStatus(accountId, "disconnected");

        whatsappLogger.info(`Sessions cleared successfully for ${accountId}`);
      }
    } catch (error) {
      whatsappLogger.error(`Failed to clear sessions for ${accountId}:`, error);
      throw error;
    }
  }

  /**
   * Force reconnect an account (clears sessions and reconnects)
   */
  async forceReconnect(
    accountId: string,
  ): Promise<{ success: boolean; qrCode?: string }> {
    try {
      whatsappLogger.info(`Force reconnecting ${accountId}`);

      await this.clearSessions(accountId);

      // Wait a moment before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const result = await this.connectAccount(accountId);

      whatsappLogger.info(`Force reconnect completed for ${accountId}`);
      return result;
    } catch (error) {
      whatsappLogger.error(`Force reconnect failed for ${accountId}:`, error);
      throw error;
    }
  }

  /**
   * Get service statistics
   */
  getStats(): {
    totalAccounts: number;
    connectedAccounts: number;
    disconnectedAccounts: number;
    qrPendingAccounts: number;
    isInitialized: boolean;
  } {
    const accounts = Array.from(this.accounts.values());

    return {
      totalAccounts: accounts.length,
      connectedAccounts: accounts.filter((a) => a.status === "connected")
        .length,
      disconnectedAccounts: accounts.filter((a) => a.status === "disconnected")
        .length,
      qrPendingAccounts: accounts.filter((a) => a.status === "qr_pending")
        .length,
      isInitialized: this.isInitialized,
    };
  }
}

// Export singleton instance with message processor integration
export const whatsappService = new WhatsAppService();

// Add test message insertion method
(whatsappService as any).insertTestMessage = async function (from: string, to: string, message: string) {
  return await messageProcessor.insertTestMessage(from, to, message);
};
