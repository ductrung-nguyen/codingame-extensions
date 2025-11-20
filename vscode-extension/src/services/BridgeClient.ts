/**
 * BridgeClient Service
 * Task 2.6: Bridge Resilience & Logging
 *
 * Manages WebSocket server for communication with Chrome extension.
 * Handles connection lifecycle, heartbeats, message routing, and offline resilience.
 */

import * as vscode from 'vscode';
import { WebSocket, WebSocketServer } from 'ws';
import * as http from 'http';
import * as crypto from 'crypto';
import { ConfigurationService } from './ConfigurationService';
import {
  BridgeMessage,
  ConnectionState,
  QueuedMessage,
  BridgeError,
  LogEntry,
  LogLevel,
  LogCategory,
  BridgeConfig,
  BridgeStats,
  AuthPayload,
  HeartbeatPayload,
  BridgeInitResult
} from '../models/BridgeTypes';

/**
 * Main Bridge Client class
 */
export class BridgeClient implements vscode.Disposable {
  private server: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private connectionState: ConnectionState = 'disconnected';

  // Timers
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatTime: number = 0;
  private lastHeartbeatSentTime: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private authTimeoutTimer: NodeJS.Timeout | null = null;

  // Event emitters
  private connectionEmitter = new vscode.EventEmitter<ConnectionState>();
  private messageEmitter = new vscode.EventEmitter<BridgeMessage>();
  private errorEmitter = new vscode.EventEmitter<BridgeError>();

  public readonly onConnectionChange = this.connectionEmitter.event;
  public readonly onMessage = this.messageEmitter.event;
  public readonly onError = this.errorEmitter.event;

  // Logging and diagnostics
  private outputChannel: vscode.OutputChannel;
  private logRingBuffer: LogEntry[] = [];
  private readonly MAX_RING_BUFFER_SIZE = 200;

  // Message queue for offline resilience
  private messageQueue: QueuedMessage[] = [];

  // Configuration
  private config: BridgeConfig;
  private authToken: string = '';

  // Statistics
  private connectedAt: number | null = null;
  private messagesSent: number = 0;
  private messagesReceived: number = 0;
  private heartbeatSequence: number = 0;
  private lastHeartbeatLatency: number = 0;

  constructor(
    private configService: ConfigurationService,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel;
    this.authToken = this.generateAuthToken();
    this.config = this.loadConfiguration();

    // Watch for configuration changes
    this.configService.onConfigChange((event) => {
      if (event.key.startsWith('codingame.bridge.')) {
        this.handleConfigChange();
      }
    });
  }

  /**
   * Generate random authentication token
   */
  private generateAuthToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Load configuration from settings
   */
  private loadConfiguration(): BridgeConfig {
    return {
      port: this.configService.get<number>('bridge.port', 45123),
      host: this.configService.get<string>('bridge.host', '127.0.0.1'),
      heartbeatInterval: 10000, // 10 seconds
      heartbeatTimeout: 30000, // 30 seconds
      maxQueueSize: 100,
      maxReconnectAttempts: 10,
      reconnectDelays: [2000, 5000, 10000, 30000, 60000],
      authTimeout: 5000
    };
  }

  /**
   * Handle configuration changes
   */
  private async handleConfigChange(): Promise<void> {
    const newConfig = this.loadConfiguration();
    const portChanged = newConfig.port !== this.config.port;
    const hostChanged = newConfig.host !== this.config.host;

    this.config = newConfig;

    if (portChanged || hostChanged) {
      this.log('[BRIDGE] Configuration changed, restarting server...', 'info');
      await this.restart();
    }
  }

  /**
   * Start the WebSocket server
   */
  public async start(): Promise<BridgeInitResult> {
    this.log('[BRIDGE] Starting WebSocket server...', 'info');

    try {
      // Close existing server if any
      if (this.server) {
        await this.stopServer();
      }

      // Create WebSocket server
      this.server = new WebSocketServer({
        host: this.config.host,
        port: this.config.port,
        perMessageDeflate: false,
        clientTracking: true
      });

      // Register event handlers
      this.server.on('listening', () => this.handleServerListening());
      this.server.on('connection', (ws, req) => this.handleConnection(ws, req));
      this.server.on('error', (error) => this.handleServerError(error));

      // Wait for server to be listening
      await this.waitForServerListening();

      this.connectionState = 'listening';
      this.connectionEmitter.fire('listening');

      this.log(`[BRIDGE] Server listening on ${this.config.host}:${this.config.port}`, 'info');

      return {
        success: true,
        port: this.config.port,
        authToken: this.authToken
      };

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[BRIDGE] Failed to start server: ${message}`, 'error');

      this.emitError({
        type: 'server_error',
        message: `Failed to start server: ${message}`,
        timestamp: Date.now(),
        recoverable: true
      });

      // Show error with actionable message
      const action = await vscode.window.showErrorMessage(
        `CodinGame: Failed to start bridge server on port ${this.config.port}. Port may be in use.`,
        'Try Different Port',
        'Open Settings'
      );

      if (action === 'Try Different Port') {
        await this.promptForPort();
      } else if (action === 'Open Settings') {
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'codingame.bridge.port'
        );
      }

      return {
        success: false,
        port: this.config.port,
        authToken: this.authToken,
        error: message
      };
    }
  }

  /**
   * Wait for server to start listening
   */
  private waitForServerListening(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server start timeout'));
      }, 5000);

      const checkListening = () => {
        if (this.server && this.server.address()) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkListening, 100);
        }
      };

      checkListening();
    });
  }

  /**
   * Prompt user to select different port
   */
  private async promptForPort(): Promise<void> {
    const portString = await vscode.window.showInputBox({
      prompt: 'Enter a different port number',
      value: String(this.config.port + 1),
      validateInput: (value) => {
        const port = parseInt(value, 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
          return 'Port must be between 1024 and 65535';
        }
        return null;
      }
    });

    if (portString) {
      const port = parseInt(portString, 10);
      await this.configService.updateConfig('bridge.port', port);
    }
  }

  /**
   * Stop the WebSocket server
   */
  public async stop(): Promise<void> {
    this.log('[BRIDGE] Stopping server...', 'info');

    this.stopHeartbeatMonitoring();
    this.stopReconnectTimer();

    if (this.client) {
      this.client.close(1000, 'Server shutting down');
      this.client = null;
    }

    await this.stopServer();

    this.connectionState = 'disconnected';
    this.connectionEmitter.fire('disconnected');

    this.log('[BRIDGE] Server stopped', 'info');
  }

  /**
   * Stop server instance
   */
  private stopServer(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Restart the server
   */
  public async restart(): Promise<BridgeInitResult> {
    await this.stop();
    return await this.start();
  }

  /**
   * Handle server listening event
   */
  private handleServerListening(): void {
    this.log('[BRIDGE] Server ready to accept connections', 'info');
    this.log(`[BRIDGE] Auth token: ${this.authToken}`, 'debug');

    // Show status bar message
    vscode.window.setStatusBarMessage(
      '$(radio-tower) CodinGame bridge ready',
      5000
    );
  }

  /**
   * Handle server error
   */
  private handleServerError(error: Error): void {
    this.log(`[BRIDGE] Server error: ${error.message}`, 'error');

    this.emitError({
      type: 'server_error',
      message: error.message,
      timestamp: Date.now(),
      recoverable: true
    });
  }

  /**
   * Handle new client connection
   */
  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    const clientIp = req.socket.remoteAddress;
    this.log(`[BRIDGE] Client connecting from ${clientIp}`, 'info');

    // Security check: only allow loopback
    if (!this.isLoopbackConnection(req)) {
      this.log('[BRIDGE] Rejected non-loopback connection', 'warn');
      ws.close(1008, 'Only loopback connections allowed');
      return;
    }

    // Only allow one active client
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.log('[BRIDGE] Closing existing client connection', 'warn');
      this.client.close(1000, 'New client connecting');
    }

    // Store reference
    this.client = ws;
    this.connectionState = 'connected';
    this.connectionEmitter.fire('connected');
    this.connectedAt = Date.now();

    // Setup client event handlers
    ws.on('message', (data) => this.handleMessage(data));
    ws.on('close', (code, reason) => this.handleClose(code, reason));
    ws.on('error', (error) => this.handleClientError(error));
    ws.on('pong', () => this.handlePong());

    // Schedule authentication timeout
    this.scheduleAuthTimeout();

    this.log('[BRIDGE] Connection established, awaiting authentication', 'info');
  }

  /**
   * Check if connection is from loopback interface
   */
  private isLoopbackConnection(req: http.IncomingMessage): boolean {
    const address = req.socket.remoteAddress;
    return (
      address === '127.0.0.1' ||
      address === '::1' ||
      address === '::ffff:127.0.0.1' ||
      address === 'localhost'
    );
  }

  /**
   * Schedule authentication timeout
   */
  private scheduleAuthTimeout(): void {
    if (this.authTimeoutTimer) {
      clearTimeout(this.authTimeoutTimer);
    }

    this.authTimeoutTimer = setTimeout(() => {
      if (this.connectionState === 'connected') {
        this.log('[BRIDGE] Authentication timeout', 'warn');
        this.client?.close(1008, 'Authentication timeout');
      }
    }, this.config.authTimeout);
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(data: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    try {
      // Parse message
      const message = this.parseMessage(data);

      this.messagesReceived++;

      // Log reception
      this.log(
        `[BRIDGE] ← Received ${message.type} (id: ${message.requestId || 'none'})`,
        'debug',
        { type: message.type, hasPayload: !!message.payload }
      );

      // Handle authentication first
      if (this.connectionState === 'connected') {
        if (message.type === 'auth') {
          await this.handleAuthentication(message);
          return;
        } else {
          this.log('[BRIDGE] Rejected unauthenticated message', 'warn');
          await this.sendError(message.requestId, 'NOT_AUTHENTICATED', 'Client must authenticate first');
          return;
        }
      }

      // Route authenticated messages
      await this.routeMessage(message);

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[BRIDGE] Message handling error: ${message}`, 'error');
      await this.sendError(null, 'INVALID_MESSAGE', message);
    }
  }

  /**
   * Parse incoming message
   */
  private parseMessage(data: Buffer | ArrayBuffer | Buffer[]): BridgeMessage {
    const text = data.toString();
    const parsed = JSON.parse(text);

    // Validate schema
    if (!parsed.type || !parsed.version) {
      throw new Error('Invalid message schema: missing type or version');
    }

    return parsed as BridgeMessage;
  }

  /**
   * Route authenticated message to appropriate handler
   */
  private async routeMessage(message: BridgeMessage): Promise<void> {
    switch (message.type) {
      case 'heartbeat':
        this.handleHeartbeat(message);
        break;

      case 'heartbeat_ack':
        this.handleHeartbeatAck(message);
        break;

      case 'sync_status':
        this.log('[SYNC] Sync status received', 'info', message.payload);
        this.messageEmitter.fire(message);
        break;

      case 'match_data':
        this.log('[MATCH] Match data received', 'info', { deliveryId: message.payload?.deliveryId });
        this.messageEmitter.fire(message);
        break;

      case 'log':
        this.handleRemoteLog(message);
        break;

      case 'settings_request':
        await this.handleSettingsRequest(message);
        break;

      default:
        this.log(`[BRIDGE] Unknown message type: ${message.type}`, 'warn');
        await this.sendError(message.requestId, 'UNKNOWN_MESSAGE_TYPE', `Unknown type: ${message.type}`);
    }
  }

  /**
   * Handle authentication message
   */
  private async handleAuthentication(message: BridgeMessage): Promise<void> {
    const payload = message.payload as AuthPayload;

    if (this.authTimeoutTimer) {
      clearTimeout(this.authTimeoutTimer);
      this.authTimeoutTimer = null;
    }

    if (payload.token === this.authToken) {
      this.connectionState = 'authenticated';
      this.connectionEmitter.fire('authenticated');
      this.reconnectAttempts = 0; // Reset reconnect counter on successful auth

      this.log('[BRIDGE] Authentication successful', 'info', {
        clientVersion: payload.version
      });

      // Send acknowledgment
      await this.sendRaw({
        type: 'auth_ack',
        requestId: message.requestId,
        payload: {
          status: 'success',
          serverVersion: '1.0.0'
        },
        version: '1.0.0'
      });

      // Start heartbeat monitoring
      this.startHeartbeatMonitoring();

      // Flush queued messages
      await this.flushMessageQueue();

      vscode.window.showInformationMessage('CodinGame: Chrome extension connected');

    } else {
      this.log('[BRIDGE] Authentication failed: invalid token', 'warn');

      await this.sendRaw({
        type: 'auth_ack',
        requestId: message.requestId,
        payload: {
          status: 'failure',
          reason: 'INVALID_TOKEN'
        },
        version: '1.0.0'
      });

      this.client?.close(1008, 'Invalid authentication token');

      this.emitError({
        type: 'auth_failed',
        message: 'Client authentication failed',
        timestamp: Date.now(),
        recoverable: false
      });
    }
  }

  /**
   * Handle heartbeat from client
   */
  private handleHeartbeat(message: BridgeMessage): void {
    this.lastHeartbeatTime = Date.now();

    // Send heartbeat ack
    this.sendRaw({
      type: 'heartbeat_ack',
      requestId: message.requestId,
      payload: {
        timestamp: Date.now(),
        source: 'vscode'
      },
      version: '1.0.0'
    }).catch((error) => {
      this.log(`[BRIDGE] Failed to send heartbeat ack: ${error}`, 'warn');
    });
  }

  /**
   * Handle heartbeat acknowledgment
   */
  private handleHeartbeatAck(message: BridgeMessage): void {
    this.lastHeartbeatTime = Date.now();

    const payload = message.payload as HeartbeatPayload;
    if (payload?.timestamp && this.lastHeartbeatSentTime) {
      this.lastHeartbeatLatency = Date.now() - this.lastHeartbeatSentTime;
      this.log(`[BRIDGE] Heartbeat acknowledged (latency: ${this.lastHeartbeatLatency}ms)`, 'debug');
    }
  }

  /**
   * Handle remote log from Chrome
   */
  private handleRemoteLog(message: BridgeMessage): void {
    const payload = message.payload as { level: LogLevel; message: string; timestamp: number };

    // Prefix with [CHROME] to indicate source
    const prefixedMessage = `[CHROME] ${payload.message}`;

    this.log(prefixedMessage, payload.level, {
      source: 'chrome',
      remoteTimestamp: payload.timestamp
    });
  }

  /**
   * Handle settings request from Chrome
   */
  private async handleSettingsRequest(message: BridgeMessage): Promise<void> {
    const settings = {
      stripComments: this.configService.get<boolean>('sync.stripComments', false),
      commentStrategy: this.configService.get<string>('sync.commentStrategy', 'auto'),
      autoSync: false // Not yet implemented
    };

    await this.sendRaw({
      type: 'settings_response',
      requestId: message.requestId,
      payload: settings,
      version: '1.0.0'
    });

    this.log('[BRIDGE] Settings sent to Chrome extension', 'debug', settings);
  }

  /**
   * Handle client disconnect
   */
  private handleClose(code: number, reason: Buffer): void {
    const reasonString = reason.toString();
    this.log(`[BRIDGE] Client disconnected (code: ${code}, reason: ${reasonString})`, 'info');

    this.client = null;
    this.stopHeartbeatMonitoring();

    if (this.connectionState !== 'disconnected') {
      this.connectionState = 'listening';
      this.connectionEmitter.fire('listening');

      // Only show reconnect notification if we were previously authenticated
      if (code !== 1000 && this.connectedAt) {
        this.showReconnectNotification();
      }
    }
  }

  /**
   * Handle client error
   */
  private handleClientError(error: Error): void {
    this.log(`[BRIDGE] Client error: ${error.message}`, 'error');

    this.emitError({
      type: 'client_error',
      message: error.message,
      timestamp: Date.now(),
      recoverable: true
    });
  }

  /**
   * Handle pong response
   */
  private handlePong(): void {
    this.lastHeartbeatTime = Date.now();
    this.log('[BRIDGE] Pong received', 'debug');
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeatMonitoring(): void {
    this.stopHeartbeatMonitoring();

    this.lastHeartbeatTime = Date.now();

    // Send heartbeat every interval
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
      this.checkHeartbeatTimeout();
    }, this.config.heartbeatInterval);

    this.log('[BRIDGE] Heartbeat monitoring started', 'info');
  }

  /**
   * Stop heartbeat monitoring
   */
  private stopHeartbeatMonitoring(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send heartbeat to client
   */
  private async sendHeartbeat(): Promise<void> {
    try {
      this.lastHeartbeatSentTime = Date.now();
      this.heartbeatSequence++;

      const message: BridgeMessage = {
        type: 'heartbeat',
        requestId: null,
        payload: {
          timestamp: this.lastHeartbeatSentTime,
          source: 'vscode',
          sequence: this.heartbeatSequence
        },
        version: '1.0.0'
      };

      await this.sendRaw(message);
      this.log('[BRIDGE] Heartbeat sent', 'debug');

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[BRIDGE] Failed to send heartbeat: ${message}`, 'warn');
    }
  }

  /**
   * Check for heartbeat timeout
   */
  private checkHeartbeatTimeout(): void {
    const now = Date.now();
    const elapsed = now - this.lastHeartbeatTime;

    if (elapsed > this.config.heartbeatTimeout) {
      this.log(
        `[BRIDGE] Heartbeat timeout detected (${elapsed}ms > ${this.config.heartbeatTimeout}ms)`,
        'error'
      );

      // Trigger reconnection
      this.handleHeartbeatTimeout();
    } else {
      this.log(`[BRIDGE] Heartbeat OK (last ${elapsed}ms ago)`, 'debug');
    }
  }

  /**
   * Handle heartbeat timeout
   */
  private handleHeartbeatTimeout(): void {
    this.log('[BRIDGE] Connection lost - initiating recovery', 'warn');

    // Update state
    const previousState = this.connectionState;
    this.connectionState = 'listening';
    this.connectionEmitter.fire('listening');

    // Close existing connection
    if (this.client) {
      this.client.terminate();
      this.client = null;
    }

    // Stop heartbeat timer
    this.stopHeartbeatMonitoring();

    // Show notification to user
    if (previousState === 'authenticated') {
      this.showReconnectNotification();
    }

    this.emitError({
      type: 'timeout',
      message: 'Heartbeat timeout - connection lost',
      timestamp: Date.now(),
      recoverable: true
    });
  }

  /**
   * Show reconnection notification
   */
  private async showReconnectNotification(): Promise<void> {
    const action = await vscode.window.showWarningMessage(
      'CodinGame: Connection to Chrome extension lost. Waiting for reconnection...',
      'Open Logs',
      'Dismiss'
    );

    if (action === 'Open Logs') {
      this.outputChannel.show();
    }
  }

  /**
   * Stop reconnect timer
   */
  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Send message to client
   */
  public async send(message: BridgeMessage): Promise<void> {
    // Add to queue if not connected
    if (this.connectionState !== 'authenticated') {
      this.log('[BRIDGE] Connection not ready, queueing message', 'warn', { type: message.type });
      this.queueMessage(message);
      return;
    }

    await this.sendRaw(message);
  }

  /**
   * Send message without queueing
   */
  private async sendRaw(message: BridgeMessage): Promise<void> {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }

    const serialized = JSON.stringify(message);

    this.log(
      `[BRIDGE] → Sending ${message.type} (id: ${message.requestId || 'none'})`,
      'debug',
      { type: message.type, size: serialized.length }
    );

    return new Promise((resolve, reject) => {
      this.client!.send(serialized, (error) => {
        if (error) {
          this.log(`[BRIDGE] Send failed: ${error.message}`, 'error');

          this.emitError({
            type: 'send_failed',
            message: `Failed to send ${message.type}: ${error.message}`,
            timestamp: Date.now(),
            recoverable: true
          });

          reject(error);
        } else {
          this.messagesSent++;
          resolve();
        }
      });
    });
  }

  /**
   * Send error message to client
   */
  private async sendError(
    requestId: string | null,
    code: string,
    message: string
  ): Promise<void> {
    try {
      await this.sendRaw({
        type: 'error',
        requestId,
        payload: {
          code,
          message,
          timestamp: Date.now()
        },
        version: '1.0.0'
      });
    } catch (error) {
      this.log(`[BRIDGE] Failed to send error message: ${error}`, 'warn');
    }
  }

  /**
   * Queue message for later delivery
   */
  private queueMessage(message: BridgeMessage): void {
    if (this.messageQueue.length >= this.config.maxQueueSize) {
      this.log('[BRIDGE] Message queue full, dropping oldest', 'warn');
      this.messageQueue.shift();
    }

    this.messageQueue.push({
      message,
      timestamp: Date.now(),
      attempts: 0,
      maxAttempts: 3
    });

    this.log(
      `[BRIDGE] Message queued (queue size: ${this.messageQueue.length})`,
      'info',
      { type: message.type }
    );
  }

  /**
   * Flush queued messages
   */
  private async flushMessageQueue(): Promise<void> {
    if (this.messageQueue.length === 0) {
      return;
    }

    this.log(`[BRIDGE] Flushing ${this.messageQueue.length} queued messages`, 'info');

    const queue = [...this.messageQueue];
    this.messageQueue = [];

    for (const item of queue) {
      try {
        await this.sendRaw(item.message);
        this.log(`[BRIDGE] Queued message sent: ${item.message.type}`, 'debug');

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[BRIDGE] Failed to send queued message: ${message}`, 'error');

        // Re-queue if attempts < max
        if (item.attempts < (item.maxAttempts || 3)) {
          item.attempts++;
          this.messageQueue.push(item);
          this.log(`[BRIDGE] Re-queued message (attempt ${item.attempts})`, 'debug');
        } else {
          this.log(`[BRIDGE] Message dropped after ${item.attempts} attempts`, 'warn');
        }
      }
    }
  }

  /**
   * Broadcast settings update to Chrome
   */
  public async broadcastSettingsUpdate(key: string, value: any): Promise<void> {
    const message: BridgeMessage = {
      type: 'settings_update',
      requestId: null,
      payload: {
        key,
        value,
        source: 'vscode'
      },
      version: '1.0.0'
    };

    try {
      await this.send(message);
      this.log(`[CONFIG] Settings update broadcasted: ${key}`, 'info');
    } catch (error) {
      this.log(`[CONFIG] Failed to broadcast settings: ${error}`, 'warn');
    }
  }

  /**
   * Structured logging
   */
  private log(
    message: string,
    level: LogLevel = 'info',
    metadata?: Record<string, any>
  ): void {
    // Extract category from message
    const categoryMatch = message.match(/^\[(\w+)\]/);
    const category = (categoryMatch?.[1] as LogCategory) || 'BRIDGE';

    // Create log entry
    const entry: LogEntry = {
      timestamp: Date.now(),
      category,
      level,
      message,
      metadata
    };

    // Add to ring buffer
    this.addToRingBuffer(entry);

    // Format and write to output channel
    const formatted = this.formatLogEntry(entry);
    this.outputChannel.appendLine(formatted);

    // If error level, also log to console
    if (level === 'error') {
      console.error(`[CodinGame] ${message}`, metadata);
    }
  }

  /**
   * Add entry to ring buffer
   */
  private addToRingBuffer(entry: LogEntry): void {
    this.logRingBuffer.push(entry);

    // Maintain max size
    if (this.logRingBuffer.length > this.MAX_RING_BUFFER_SIZE) {
      this.logRingBuffer.shift();
    }
  }

  /**
   * Format log entry for output
   */
  private formatLogEntry(entry: LogEntry): string {
    const timestamp = new Date(entry.timestamp).toISOString();
    const level = entry.level.toUpperCase().padEnd(5);
    const category = entry.category.padEnd(7);

    let formatted = `${timestamp} ${level} ${category} ${entry.message}`;

    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      formatted += `\n  metadata: ${JSON.stringify(entry.metadata, null, 2)}`;
    }

    return formatted;
  }

  /**
   * Emit error event
   */
  private emitError(error: BridgeError): void {
    this.errorEmitter.fire(error);
  }

  /**
   * Get connection state
   */
  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Get authentication token
   */
  public getAuthToken(): string {
    return this.authToken;
  }

  /**
   * Get queue size
   */
  public getQueueSize(): number {
    return this.messageQueue.length;
  }

  /**
   * Get log ring buffer
   */
  public getLogRingBuffer(): LogEntry[] {
    return [...this.logRingBuffer];
  }

  /**
   * Get logs by category
   */
  public getLogsByCategory(category: LogCategory): LogEntry[] {
    return this.logRingBuffer.filter(entry => entry.category === category);
  }

  /**
   * Get logs by level
   */
  public getLogsByLevel(level: LogLevel): LogEntry[] {
    return this.logRingBuffer.filter(entry => entry.level === level);
  }

  /**
   * Get logs in time range
   */
  public getLogsInRange(start: number, end: number): LogEntry[] {
    return this.logRingBuffer.filter(
      entry => entry.timestamp >= start && entry.timestamp <= end
    );
  }

  /**
   * Export logs to file
   */
  public async exportLogs(filepath?: string): Promise<void> {
    const uri = filepath
      ? vscode.Uri.file(filepath)
      : await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('codingame-logs.json'),
        filters: { 'JSON': ['json'] }
      });

    if (!uri) {
      return;
    }

    const logs = {
      exportTime: new Date().toISOString(),
      entryCount: this.logRingBuffer.length,
      entries: this.logRingBuffer
    };

    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(JSON.stringify(logs, null, 2))
    );

    vscode.window.showInformationMessage(`Logs exported to ${uri.fsPath}`);
    this.log(`[UI] Logs exported to ${uri.fsPath}`, 'info');
  }

  /**
   * Get bridge statistics
   */
  public getStats(): BridgeStats {
    return {
      connectionState: this.connectionState,
      connectedAt: this.connectedAt,
      lastHeartbeatTime: this.lastHeartbeatTime,
      lastHeartbeatLatency: this.lastHeartbeatLatency,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      queueSize: this.messageQueue.length,
      reconnectAttempts: this.reconnectAttempts,
      uptime: this.connectedAt ? Date.now() - this.connectedAt : 0
    };
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.log('[BRIDGE] Disposing bridge client...', 'info');

    this.stopHeartbeatMonitoring();
    this.stopReconnectTimer();

    if (this.authTimeoutTimer) {
      clearTimeout(this.authTimeoutTimer);
    }

    if (this.client) {
      this.client.close(1000, 'Extension deactivating');
    }

    if (this.server) {
      this.server.close();
    }

    this.connectionEmitter.dispose();
    this.messageEmitter.dispose();
    this.errorEmitter.dispose();
  }
}
