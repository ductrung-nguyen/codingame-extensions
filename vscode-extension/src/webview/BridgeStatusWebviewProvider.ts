import * as vscode from 'vscode';
import { BridgeClient } from '../services/BridgeClient';

/**
 * Webview provider for Bridge Status panel
 * Shows connection state, auth token (with copy button), heartbeat, and statistics
 */
export class BridgeStatusWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private updateInterval?: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridgeClient: BridgeClient,
    private readonly outputChannel: vscode.OutputChannel
  ) { }

  /**
   * Force refresh the webview HTML (useful for clearing cache)
   */
  public forceRefresh(): void {
    if (this.view) {
      this.view.webview.html = this.getHtmlContent(this.view.webview);
      this.updateStatus();
      vscode.window.showInformationMessage('Bridge Status webview refreshed!');
    }
  }

  /**
   * Resolve the webview view
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        await this.handleWebviewMessage(message);
      },
      null,
      this.disposables
    );

    // Start updating the status
    this.startStatusUpdates();

    // Stop updates when view is disposed
    webviewView.onDidDispose(() => {
      this.stopStatusUpdates();
    }, null, this.disposables);

    // Update when view becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.updateStatus();
      }
    }, null, this.disposables);

    // Initial update
    this.updateStatus();
  }

  /**
   * Handle messages from the webview
   */
  private async handleWebviewMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'copyToken':
        await this.handleCopyToken();
        break;

      case 'reconnect':
        await this.handleReconnect();
        break;

      case 'refresh':
        await this.updateStatus();
        break;

      case 'openOutput':
        this.outputChannel.show();
        break;
    }
  }

  /**
   * Handle copy token action
   */
  private async handleCopyToken(): Promise<void> {
    try {
      const token = this.bridgeClient.getAuthToken();

      if (!token) {
        vscode.window.showWarningMessage('No auth token available. Bridge may not be started.');
        return;
      }

      await vscode.env.clipboard.writeText(token);
      vscode.window.showInformationMessage('✓ Auth token copied to clipboard!');

      this.outputChannel.appendLine('[BRIDGE] Auth token copied to clipboard');

      // Send success message to webview
      this.postMessage({
        type: 'tokenCopied',
        success: true
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to copy token: ${errorMessage}`);

      this.postMessage({
        type: 'tokenCopied',
        success: false,
        error: errorMessage
      });
    }
  }

  /**
   * Handle reconnect action
   */
  private async handleReconnect(): Promise<void> {
    try {
      await this.bridgeClient.restart();
      vscode.window.showInformationMessage('Bridge reconnecting...');

      // Update status after a short delay
      setTimeout(() => {
        this.updateStatus();
      }, 500);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to reconnect: ${errorMessage}`);
    }
  }

  /**
   * Start periodic status updates
   */
  private startStatusUpdates(): void {
    this.stopStatusUpdates();

    // Update every 2 seconds when view is visible
    this.updateInterval = setInterval(() => {
      if (this.view?.visible) {
        this.updateStatus();
      }
    }, 2000);
  }

  /**
   * Stop periodic status updates
   */
  private stopStatusUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
  }

  /**
   * Update the status display
   */
  private updateStatus(): void {
    if (!this.view) {
      return;
    }

    const stats = this.bridgeClient.getStats();
    const token = this.bridgeClient.getAuthToken();
    const isConnected = stats.connectionState === 'authenticated' || stats.connectionState === 'connected';

    this.postMessage({
      type: 'statusUpdate',
      status: {
        connected: isConnected,
        clientCount: 0, // TODO: Track client count in BridgeClient
        lastHeartbeat: stats.lastHeartbeatTime > 0 ? stats.lastHeartbeatTime : null,
        uptime: stats.uptime,
        port: 45123, // TODO: Get from config
        hasToken: !!token,
        tokenPreview: token ? `${token.substring(0, 8)}...${token.substring(56)}` : null
      }
    });
  }

  /**
   * Post message to webview
   */
  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * Generate the HTML content for the webview
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- Version: 2.0.0 - Copy Token Feature - Cache Bust: ${Date.now()} -->
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Bridge Status</title>
  <style>
    body {
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }

    .section {
      margin-bottom: 16px;
      padding: 12px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
    }

    .section-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .status-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      font-size: 12px;
    }

    .status-label {
      color: var(--vscode-descriptionForeground);
    }

    .status-value {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-foreground);
      font-weight: 500;
    }

    .indicator {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 6px;
    }

    .indicator.connected {
      background-color: var(--vscode-testing-iconPassed);
      box-shadow: 0 0 4px var(--vscode-testing-iconPassed);
    }

    .indicator.disconnected {
      background-color: var(--vscode-testing-iconFailed);
    }

    .token-container {
      margin-top: 8px;
    }

    .token-preview {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      padding: 8px;
      background-color: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      margin-bottom: 8px;
      word-break: break-all;
      color: var(--vscode-input-foreground);
    }

    .button-group {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }

    button {
      flex: 1;
      padding: 8px 12px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      transition: background-color 0.1s;
    }

    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    button:active {
      background-color: var(--vscode-button-background);
      opacity: 0.8;
    }

    button.secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    button.secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }

    .icon {
      margin-right: 4px;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 8px;
    }

    .stat-box {
      background-color: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      padding: 8px;
      text-align: center;
    }

    .stat-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--vscode-textLink-foreground);
      margin-bottom: 4px;
    }

    .stat-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .info-box {
      margin-top: 12px;
      padding: 8px;
      background-color: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
      border-radius: 3px;
      font-size: 11px;
      color: var(--vscode-inputValidation-infoForeground);
    }

    .info-box strong {
      display: block;
      margin-bottom: 4px;
    }

    .hidden {
      display: none;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .pulse {
      animation: pulse 2s ease-in-out infinite;
    }
  </style>
</head>
<body>
  <!-- Connection Status Section -->
  <div class="section">
    <div class="section-title">
      <span class="indicator disconnected" id="statusIndicator"></span>
      Bridge Status
    </div>

    <div class="status-row">
      <span class="status-label">Connection</span>
      <span class="status-value" id="connectionStatus">Disconnected</span>
    </div>

    <div class="status-row">
      <span class="status-label">Port</span>
      <span class="status-value" id="portValue">—</span>
    </div>

    <div class="status-row">
      <span class="status-label">Clients</span>
      <span class="status-value" id="clientCount">0</span>
    </div>

    <div class="status-row">
      <span class="status-label">Uptime</span>
      <span class="status-value" id="uptimeValue">—</span>
    </div>

    <div class="status-row">
      <span class="status-label">Last Heartbeat</span>
      <span class="status-value" id="heartbeatValue">—</span>
    </div>
  </div>

  <!-- Auth Token Section -->
  <div class="section">
    <div class="section-title">🔑 Authentication Token</div>

    <div class="token-container">
      <div class="token-preview" id="tokenPreview">
        Token not available
      </div>

      <button id="copyTokenBtn" disabled>
        <span class="icon">📋</span>
        Copy Full Token
      </button>

      <div class="info-box">
        <strong>Setup Instructions:</strong>
        1. Click "Copy Full Token" button above<br>
        2. Open Chrome extension options (right-click extension icon → Options)<br>
        3. Paste the token and click "Save Settings"<br>
        4. Extension will connect automatically
      </div>
    </div>
  </div>

  <!-- Actions Section -->
  <div class="section">
    <div class="section-title">Actions</div>

    <div class="button-group">
      <button id="reconnectBtn" class="secondary">
        <span class="icon">🔄</span>
        Reconnect
      </button>

      <button id="refreshBtn" class="secondary">
        <span class="icon">↻</span>
        Refresh
      </button>
    </div>

    <div class="button-group" style="margin-top: 8px;">
      <button id="openOutputBtn" class="secondary">
        <span class="icon">📄</span>
        Open Output Panel
      </button>
    </div>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();

      // DOM elements
      const statusIndicator = document.getElementById('statusIndicator');
      const connectionStatus = document.getElementById('connectionStatus');
      const portValue = document.getElementById('portValue');
      const clientCount = document.getElementById('clientCount');
      const uptimeValue = document.getElementById('uptimeValue');
      const heartbeatValue = document.getElementById('heartbeatValue');
      const tokenPreview = document.getElementById('tokenPreview');
      const copyTokenBtn = document.getElementById('copyTokenBtn');
      const reconnectBtn = document.getElementById('reconnectBtn');
      const refreshBtn = document.getElementById('refreshBtn');
      const openOutputBtn = document.getElementById('openOutputBtn');

      // Button handlers
      copyTokenBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'copyToken' });
        copyTokenBtn.textContent = '✓ Copied!';
        copyTokenBtn.disabled = true;

        setTimeout(() => {
          copyTokenBtn.innerHTML = '<span class="icon">📋</span>Copy Full Token';
          copyTokenBtn.disabled = false;
        }, 2000);
      });

      reconnectBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'reconnect' });
        reconnectBtn.textContent = 'Reconnecting...';
        reconnectBtn.disabled = true;

        setTimeout(() => {
          reconnectBtn.innerHTML = '<span class="icon">🔄</span>Reconnect';
          reconnectBtn.disabled = false;
        }, 2000);
      });

      refreshBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
      });

      openOutputBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'openOutput' });
      });

      // Handle messages from extension
      window.addEventListener('message', event => {
        const message = event.data;

        switch (message.type) {
          case 'statusUpdate':
            updateStatus(message.status);
            break;

          case 'tokenCopied':
            if (message.success) {
              copyTokenBtn.innerHTML = '<span class="icon">✓</span>Copied!';
            } else {
              copyTokenBtn.innerHTML = '<span class="icon">❌</span>Failed';
            }

            setTimeout(() => {
              copyTokenBtn.innerHTML = '<span class="icon">📋</span>Copy Full Token';
              copyTokenBtn.disabled = false;
            }, 2000);
            break;
        }
      });

      // Update status display
      function updateStatus(status) {
        // Connection indicator
        if (status.connected) {
          statusIndicator.classList.remove('disconnected');
          statusIndicator.classList.add('connected', 'pulse');
          connectionStatus.textContent = 'Connected';
          connectionStatus.style.color = 'var(--vscode-testing-iconPassed)';
        } else {
          statusIndicator.classList.remove('connected', 'pulse');
          statusIndicator.classList.add('disconnected');
          connectionStatus.textContent = 'Disconnected';
          connectionStatus.style.color = 'var(--vscode-testing-iconFailed)';
        }

        // Port
        portValue.textContent = status.port ? status.port.toString() : '—';

        // Clients
        clientCount.textContent = status.clientCount?.toString() || '0';

        // Uptime
        if (status.uptime && status.uptime > 0) {
          uptimeValue.textContent = formatDuration(status.uptime);
        } else {
          uptimeValue.textContent = '—';
        }

        // Last heartbeat
        if (status.lastHeartbeat) {
          const elapsed = Date.now() - status.lastHeartbeat;
          if (elapsed < 60000) {
            heartbeatValue.textContent = Math.floor(elapsed / 1000) + 's ago';
          } else {
            heartbeatValue.textContent = new Date(status.lastHeartbeat).toLocaleTimeString();
          }
        } else {
          heartbeatValue.textContent = '—';
        }

        // Token
        if (status.hasToken && status.tokenPreview) {
          tokenPreview.textContent = status.tokenPreview;
          tokenPreview.style.color = 'var(--vscode-input-foreground)';
          copyTokenBtn.disabled = false;
        } else {
          tokenPreview.textContent = 'Token not available';
          tokenPreview.style.color = 'var(--vscode-descriptionForeground)';
          copyTokenBtn.disabled = true;
        }
      }

      // Format duration in milliseconds to human-readable
      function formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) {
          return days + 'd ' + (hours % 24) + 'h';
        } else if (hours > 0) {
          return hours + 'h ' + (minutes % 60) + 'm';
        } else if (minutes > 0) {
          return minutes + 'm ' + (seconds % 60) + 's';
        } else {
          return seconds + 's';
        }
      }

      // Request initial update
      vscode.postMessage({ type: 'refresh' });
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Generate a nonce for CSP
   */
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.stopStatusUpdates();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }
}
