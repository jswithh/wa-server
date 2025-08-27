/**
 * Simple HTML template helpers for QR code and error pages
 */

export function createQRNotAvailablePage(accountId: string, accountName: string, status: string, createdAt: string): string {
  return `
    <html>
    <head>
      <title>QR Code Not Available - ${accountId}</title>
      <meta http-equiv="refresh" content="5">
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        .container { max-width: 600px; margin: 0 auto; }
        .status { padding: 20px; border-radius: 8px; margin: 20px 0; }
        .qr-pending { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; }
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
          <h3>Account: ${accountName} (${accountId})</h3>
          <p>Status: ${status}</p>
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

        <p><small>Account created: ${createdAt}</small></p>
      </div>
    </body>
    </html>
  `;
}

export function createQRDisplayPage(accountId: string, accountName: string, qrCode: string): string {
  return `
    <html>
    <head>
      <title>WhatsApp QR Code - ${accountName}</title>
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
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        .qr-code { margin: 20px 0; }
        .qr-code img { max-width: 300px; border: 5px solid #f0f0f0; border-radius: 10px; }
        .btn {
          display: inline-block; padding: 12px 24px; margin: 10px;
          text-decoration: none; border-radius: 8px; font-weight: bold;
          transition: background-color 0.3s;
        }
        .btn-primary { background: #007bff; color: white; }
        .btn-secondary { background: #6c757d; color: white; }
        .btn:hover { opacity: 0.8; }
        .status { padding: 15px; background: #d4edda; border: 1px solid #c3e6cb;
                 border-radius: 8px; margin: 20px 0; color: #155724; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📱 WhatsApp QR Code</h1>
        <h2>${accountName}</h2>

        <div class="status">
          <strong>✅ QR Code Ready!</strong><br>
          Scan this QR code with your WhatsApp mobile app
        </div>

        <div class="qr-code">
          <img src="${qrCode}" alt="WhatsApp QR Code" />
        </div>

        <p><strong>Instructions:</strong></p>
        <ol style="text-align: left; display: inline-block;">
          <li>Open WhatsApp on your phone</li>
          <li>Go to Settings → Linked Devices</li>
          <li>Tap "Link a Device"</li>
          <li>Scan this QR code</li>
        </ol>

        <div>
          <a href="/api/accounts/${accountId}/qr/image" class="btn btn-primary">🔄 Refresh QR</a>
          <a href="/" class="btn btn-secondary">← Back to Dashboard</a>
        </div>

        <p><small>Account ID: ${accountId} | Auto-refresh: 10s</small></p>
      </div>
    </body>
    </html>
  `;
}

export function createErrorPage(title: string, message: string, accountId?: string): string {
  return `
    <html>
    <head>
      <title>${title}</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        .container { max-width: 500px; margin: 0 auto; }
        .error { padding: 20px; background: #f8d7da; border: 1px solid #f5c6cb;
                border-radius: 8px; color: #721c24; }
        .btn {
          display: inline-block; padding: 10px 20px; margin: 10px;
          background: #6c757d; color: white; text-decoration: none; border-radius: 5px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>${title}</h1>
        <div class="error">
          <p>${message}</p>
          ${accountId ? `<p>Account ID: ${accountId}</p>` : ''}
        </div>
        <a href="/" class="btn">← Back to Dashboard</a>
      </div>
    </body>
    </html>
  `;
}
