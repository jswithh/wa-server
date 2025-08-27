import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";
import path from "path";
import { logger } from "../utils/logger";

export interface Account {
  id: string;
  phone_number: string | null;
  name: string;
  status: "connected" | "disconnected" | "connecting" | "qr_pending";
  created_at: string;
  updated_at: string;
  last_seen?: string;
}

export interface Message {
  id: string;
  account_id: string;
  from: string;
  to: string;
  message: string;
  timestamp: string;
  type: "text" | "image" | "video" | "audio" | "document" | "sticker";
  direction: "inbound" | "outbound";
  message_id: string;
  raw_data: string;
  webhook_sent: boolean;
  webhook_attempts: number;
  created_at: string;
}

export interface Session {
  id: string;
  account_id: string;
  session_data: string;
  created_at: string;
  updated_at: string;
}

export class DatabaseManager {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor() {
    this.dbPath = path.join(process.cwd(), "database.sqlite");
  }

  async initialize(): Promise<void> {
    try {
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database,
      });

      // Enable foreign keys
      await this.db.exec("PRAGMA foreign_keys = ON");

      // Create tables
      await this.createTables();

      logger.info("Database initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize database:", error);
      throw error;
    }
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    // Accounts table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        phone_number TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME,
        UNIQUE(phone_number) ON CONFLICT IGNORE
      )
    `);

    // Messages table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        [from] TEXT NOT NULL,
        [to] TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        direction TEXT NOT NULL,
        message_id TEXT NOT NULL,
        raw_data TEXT,
        webhook_sent BOOLEAN DEFAULT FALSE,
        webhook_attempts INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
      )
    `);

    // Sessions table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL UNIQUE,
        session_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
      )
    `);

    // Create indexes for better performance
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_account_id ON messages(account_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
      CREATE INDEX IF NOT EXISTS idx_messages_webhook_sent ON messages(webhook_sent);
      CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
      CREATE INDEX IF NOT EXISTS idx_accounts_phone_number ON accounts(phone_number);
    `);

    // Create trigger to update updated_at timestamp
    await this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_accounts_timestamp
      AFTER UPDATE ON accounts
      BEGIN
        UPDATE accounts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
    `);

    await this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_sessions_timestamp
      AFTER UPDATE ON sessions
      BEGIN
        UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
    `);
  }

  // Account operations
  async createAccount(
    account: Omit<Account, "created_at" | "updated_at">,
  ): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    await this.db.run(
      `INSERT INTO accounts (id, phone_number, name, status, last_seen)
       VALUES (?, ?, ?, ?, ?)`,
      [
        account.id,
        account.phone_number,
        account.name,
        account.status,
        account.last_seen,
      ],
    );
  }



  async getAccount(id: string): Promise<Account | null> {
    if (!this.db) throw new Error("Database not initialized");

    const account = await this.db.get("SELECT * FROM accounts WHERE id = ?", [
      id,
    ]);

    return account || null;
  }

  async getAllAccounts(): Promise<Account[]> {
    if (!this.db) throw new Error("Database not initialized");

    return await this.db.all("SELECT * FROM accounts ORDER BY created_at DESC");
  }

  async updateAccountStatus(
    id: string,
    status: Account["status"],
    phoneNumber?: string | null,
  ): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    if (phoneNumber !== undefined) {
      await this.db.run(
        "UPDATE accounts SET status = ?, phone_number = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?",
        [status, phoneNumber, id],
      );
    } else {
      await this.db.run(
        "UPDATE accounts SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?",
        [status, id],
      );
    }
  }

  async deleteAccount(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    await this.db.run("DELETE FROM accounts WHERE id = ?", [id]);
  }

  // Message operations
  async saveMessage(message: Omit<Message, "created_at">): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    await this.db.run(
      `INSERT INTO messages (
        id, account_id, [from], [to], message, timestamp,
        type, direction, message_id, raw_data, webhook_sent, webhook_attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.account_id,
        message.from,
        message.to,
        message.message,
        message.timestamp,
        message.type,
        message.direction,
        message.message_id,
        message.raw_data,
        message.webhook_sent,
        message.webhook_attempts,
      ],
    );
  }

  async getMessages(
    accountId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<Message[]> {
    if (!this.db) throw new Error("Database not initialized");

    return await this.db.all(
      `SELECT * FROM messages
       WHERE account_id = ?
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
      [accountId, limit, offset],
    );
  }

  async getPendingWebhookMessages(): Promise<Message[]> {
    if (!this.db) throw new Error("Database not initialized");

    return await this.db.all(
      `SELECT * FROM messages
       WHERE webhook_sent = FALSE AND webhook_attempts < 5
       ORDER BY created_at ASC
       LIMIT 100`,
    );
  }

  async updateMessageWebhookStatus(
    id: string,
    sent: boolean,
    attempts: number,
  ): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    await this.db.run(
      "UPDATE messages SET webhook_sent = ?, webhook_attempts = ? WHERE id = ?",
      [sent, attempts, id],
    );
  }

  // Session operations
  async saveSession(
    session: Omit<Session, "created_at" | "updated_at">,
  ): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    await this.db.run(
      `INSERT OR REPLACE INTO sessions (id, account_id, session_data)
       VALUES (?, ?, ?)`,
      [session.id, session.account_id, session.session_data],
    );
  }

  async getSession(accountId: string): Promise<Session | null> {
    if (!this.db) throw new Error("Database not initialized");

    const session = await this.db.get(
      "SELECT * FROM sessions WHERE account_id = ?",
      [accountId],
    );

    return session || null;
  }

  async deleteSession(accountId: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    await this.db.run("DELETE FROM sessions WHERE account_id = ?", [accountId]);
  }

  // Utility methods
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      logger.info("Database connection closed");
    }
  }

  async getStats(): Promise<{
    totalAccounts: number;
    connectedAccounts: number;
    totalMessages: number;
    pendingWebhooks: number;
  }> {
    if (!this.db) throw new Error("Database not initialized");

    const [
      { totalAccounts },
      { connectedAccounts },
      { totalMessages },
      { pendingWebhooks },
    ] = await Promise.all([
      this.db.get("SELECT COUNT(*) as totalAccounts FROM accounts"),
      this.db.get(
        'SELECT COUNT(*) as connectedAccounts FROM accounts WHERE status = "connected"',
      ),
      this.db.get("SELECT COUNT(*) as totalMessages FROM messages"),
      this.db.get(
        "SELECT COUNT(*) as pendingWebhooks FROM messages WHERE webhook_sent = FALSE",
      ),
    ]);

    return {
      totalAccounts: totalAccounts || 0,
      connectedAccounts: connectedAccounts || 0,
      totalMessages: totalMessages || 0,
      pendingWebhooks: pendingWebhooks || 0,
    };
  }

  // Get database instance for direct queries
  getDatabase() {
    if (!this.db) throw new Error("Database not initialized");
    return this.db;
  }
}

// Export singleton instance
export const databaseManager = new DatabaseManager();
