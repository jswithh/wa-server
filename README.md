# WhatsApp Multi-Account Server

A robust Express.js application that enables management of multiple WhatsApp accounts using Baileys library. This server provides QR code generation, message capturing, and webhook integration for seamless WhatsApp automation.

## 🚀 Features

- **Multi-Account Management**: Handle multiple WhatsApp accounts simultaneously
- **QR Code Generation**: Web-based QR code display for easy account authentication
- **Message Logging**: Capture all inbound and outbound messages
- **Webhook Integration**: Automatically forward messages to external endpoints
- **SQLite Database**: Persistent storage for accounts, messages, and sessions
- **REST API**: Complete RESTful API for account and message management
- **Web Dashboard**: Beautiful web interface for account monitoring
- **Auto-Reconnection**: Automatic reconnection handling for disconnected accounts
- **Retry Mechanism**: Robust webhook delivery with exponential backoff
- **Session Persistence**: Maintain WhatsApp sessions across server restarts

## 📋 Prerequisites

- Node.js 18+ and npm
- SQLite3
- Internet connection for WhatsApp Web access

## 🛠️ Installation

1. **Clone or navigate to the project directory:**
   ```bash
   cd wa-server
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create environment configuration:**
   ```bash
   cp .env.example .env
   ```

4. **Edit `.env` file with your configuration:**
   ```env
   NODE_ENV=development
   PORT=3000
   WEBHOOK_URL=http://localhost:10022/hra_whatsapp/sub_channel/webhook
   LOG_LEVEL=info
   ```

5. **Build the TypeScript code:**
   ```bash
   npm run build
   ```

6. **Start the server:**
   ```bash
   # Development mode with auto-reload
   npm run dev

   # Production mode
   npm start
   ```

## 🌐 Web Interface

Access the web dashboard at: `http://localhost:3000`

The dashboard provides:
- Account creation and management
- QR code display for authentication
- System statistics and monitoring
- Webhook configuration and testing
- Real-time account status updates

## 📡 API Documentation

### Base URL
```
http://localhost:3000/api
```

### Accounts Management

#### Create Account
```http
POST /api/accounts
Content-Type: application/json

{
  "id": "account1",
  "name": "My WhatsApp Account"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Account created successfully",
  "data": {
    "account": {
      "id": "account1",
      "name": "My WhatsApp Account",
      "status": "qr_pending",
      "created_at": "2024-01-15T10:30:00.000Z"
    },
    "qrCode": "data:image/png;base64,..."
  }
}
```

#### Get All Accounts
```http
GET /api/accounts
```

**Response:**
```json
{
  "success": true,
  "message": "Accounts retrieved successfully",
  "data": [
    {
      "id": "account1",
      "name": "My WhatsApp Account",
      "phone_number": "6281234567890",
      "status": "connected",
      "socketStatus": "connected",
      "hasQrCode": false,
      "created_at": "2024-01-15T10:30:00.000Z",
      "updated_at": "2024-01-15T10:35:00.000Z"
    }
  ]
}
```

#### Get Account Details
```http
GET /api/accounts/{accountId}
```

#### Connect Account
```http
POST /api/accounts/{accountId}/connect
```

#### Disconnect Account
```http
POST /api/accounts/{accountId}/disconnect
```

#### Delete Account
```http
DELETE /api/accounts/{accountId}
```

#### Get QR Code
```http
GET /api/accounts/{accountId}/qr
```

**Response:**
```json
{
  "success": true,
  "message": "QR code retrieved successfully",
  "data": {
    "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
  }
}
```

#### Get Account Messages
```http
GET /api/accounts/{accountId}/messages?limit=50&offset=0
```

**Response:**
```json
{
  "success": true,
  "message": "Messages retrieved successfully",
  "data": {
    "messages": [
      {
        "id": "msg_1705311000_abc123",
        "account_id": "account1",
        "from_number": "6281234567890",
        "to_number": "6289876543210",
        "message": "Hello, how can I help you?",
        "timestamp": "1705311000",
        "type": "text",
        "direction": "inbound",
        "message_id": "3EB0123456789ABCDEF",
        "webhook_sent": true,
        "created_at": "2024-01-15T10:30:00.000Z"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "count": 1
    }
  }
}
```

### Dashboard & Monitoring

#### System Statistics
```http
GET /api/dashboard/stats
```

**Response:**
```json
{
  "success": true,
  "message": "System statistics retrieved successfully",
  "data": {
    "whatsapp": {
      "totalAccounts": 3,
      "connectedAccounts": 2,
      "disconnectedAccounts": 1,
      "qrPendingAccounts": 0,
      "isInitialized": true
    },
    "database": {
      "totalAccounts": 3,
      "connectedAccounts": 2,
      "totalMessages": 1250,
      "pendingWebhooks": 5
    },
    "webhook": {
      "url": "http://localhost:10022/hra_whatsapp/sub_channel/webhook",
      "timeout": 10000,
      "maxRetries": 3,
      "retryDelay": 1000
    },
    "uptime": 3600,
    "memory": {
      "rss": 67108864,
      "heapTotal": 29360128,
      "heapUsed": 18825216,
      "external": 1089536,
      "arrayBuffers": 163840
    }
  }
}
```

#### Health Check
```http
GET /health
```

#### Test Webhook
```http
POST /api/dashboard/webhook/test
```

#### Get Webhook Configuration
```http
GET /api/dashboard/webhook/config
```

#### Update Webhook Configuration
```http
PUT /api/dashboard/webhook/config
Content-Type: application/json

{
  "url": "http://localhost:10022/hra_whatsapp/sub_channel/webhook",
  "timeout": 15000,
  "maxRetries": 5,
  "retryDelay": 2000
}
```

## 🔄 Webhook Integration

When messages are received or sent, the server automatically forwards them to your configured webhook URL with the following payload:

### Webhook Payload Format
```json
{
  "from": "6281316088377",
  "to": "6285156808928",
  "message": "Hello, how can I help you?",
  "timestamp": "1754889300",
  "type": "text"
}
```

### Message Types
- `text` - Text messages
- `image` - Image messages (caption in message field)
- `video` - Video messages (caption in message field)
- `audio` - Audio messages
- `document` - Document messages (filename in message field)
- `sticker` - Sticker messages

### Webhook Retry Logic
- Maximum 3 retry attempts with exponential backoff
- Retries on network errors and 5xx HTTP status codes
- No retry on 4xx errors (except 429 rate limiting)
- Failed webhooks are logged and can be manually retried

## 📁 Project Structure

```
wa-server/
├── src/
│   ├── config/           # Configuration files
│   ├── models/           # Database models and schemas
│   │   └── database.ts   # SQLite database manager
│   ├── routes/           # Express.js routes
│   │   ├── accounts.ts   # Account management endpoints
│   │   └── dashboard.ts  # Dashboard and monitoring endpoints
│   ├── services/         # Business logic services
│   │   ├── whatsapp.ts   # WhatsApp/Baileys integration
│   │   └── webhook.ts    # Webhook delivery service
│   ├── utils/            # Utility functions
│   │   ├── logger.ts     # Winston logging configuration
│   │   └── validation.ts # Request validation schemas
│   └── index.ts          # Main application entry point
├── public/               # Static web files
│   └── index.html        # Web dashboard
├── sessions/             # WhatsApp session data (auto-created)
├── logs/                 # Application logs (auto-created)
├── database.sqlite       # SQLite database (auto-created)
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## 🗄️ Database Schema

### Accounts Table
```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  phone_number TEXT UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME
);
```

### Messages Table
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
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
);
```

### Sessions Table
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  session_data TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Environment mode |
| `PORT` | `3000` | Server port |
| `WEBHOOK_URL` | `http://localhost:10022/hra_whatsapp/sub_channel/webhook` | Webhook endpoint |
| `WEBHOOK_TIMEOUT` | `10000` | Webhook timeout (ms) |
| `WEBHOOK_MAX_RETRIES` | `3` | Maximum retry attempts |
| `LOG_LEVEL` | `info` | Logging level |
| `DATABASE_PATH` | `./database.sqlite` | SQLite database path |
| `SESSIONS_PATH` | `./sessions` | WhatsApp sessions directory |

### Account Status Values
- `disconnected` - Account is not connected to WhatsApp
- `connecting` - Account is in the process of connecting
- `qr_pending` - Account is waiting for QR code scan
- `connected` - Account is successfully connected

## 📝 Logging

The application uses Winston for comprehensive logging:

- **Error logs**: `logs/error.log`
- **Combined logs**: `logs/combined.log`
- **Warnings**: `logs/warnings.log`
- **Console output**: Colorized logs in development mode

Log levels: `error`, `warn`, `info`, `debug`

## 🔐 Security Features

- **Helmet.js**: Security headers
- **CORS**: Configurable cross-origin resource sharing
- **Rate Limiting**: Prevent API abuse
- **Input Validation**: Joi schema validation
- **Error Handling**: Secure error responses
- **Session Management**: Secure WhatsApp session storage

## 🚨 Error Handling

### Common Error Responses

```json
{
  "success": false,
  "message": "Error description",
  "code": "ERROR_CODE",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `404` - Not Found
- `409` - Conflict (duplicate account)
- `429` - Too Many Requests
- `500` - Internal Server Error
- `503` - Service Unavailable

## 🔄 Development

### Scripts
```bash
# Development with auto-reload
npm run dev

# Build TypeScript
npm run build

# Production start
npm start

# Type checking
npx tsc --noEmit
```

### Code Style
- TypeScript with strict type checking
- ESLint for code quality
- Prettier for code formatting
- JSDoc comments for documentation

## 📊 Monitoring

### Health Check Endpoint
```http
GET /health
```

Returns system health including:
- Service status (WhatsApp, Database, Webhook)
- Memory usage
- Uptime
- Service connectivity

### Metrics Available
- Account statistics
- Message counts by type and direction
- Webhook delivery success rates
- System performance metrics

## 🛠️ Troubleshooting

### Common Issues

1. **Port already in use**
   ```bash
   Error: Port 3000 is already in use
   ```
   Solution: Change the `PORT` environment variable or kill the process using the port.

2. **WhatsApp session expired**
   ```bash
   Connection closed: 401
   ```
   Solution: Delete the session folder and reconnect the account.

3. **Webhook delivery failures**
   ```bash
   Webhook failed after 3 attempts
   ```
   Solution: Check webhook URL accessibility and response format.

4. **Database locked**
   ```bash
   SQLITE_BUSY: database is locked
   ```
   Solution: Ensure only one instance is running or restart the server.

### Debug Mode
Set `LOG_LEVEL=debug` in your `.env` file for detailed logging.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the ISC License.

## ⚠️ Disclaimer

This project is for educational and development purposes. Ensure compliance with WhatsApp's Terms of Service when using this software. The authors are not responsible for any misuse of this software.

## 🔗 Related Links

- [Baileys Documentation](https://github.com/WhiskeySockets/Baileys)
- [Express.js Documentation](https://expressjs.com/)
- [WhatsApp Business API](https://developers.facebook.com/docs/whatsapp)

## 📞 Support

For issues and questions:
1. Check the troubleshooting section
2. Review existing GitHub issues
3. Create a new issue with detailed information

---

Made with ❤️ for WhatsApp automation
