/**
 * Type definitions for Bridge Client communication
 * Task 2.6: Bridge Resilience & Logging
 */

/**
 * Message envelope for all bridge communication
 */
export interface BridgeMessage {
  type: MessageType;
  requestId: string | null;
  payload: any;
  version: string;
}

/**
 * All supported message types
 */
export type MessageType =
  | 'auth'
  | 'auth_ack'
  | 'heartbeat'
  | 'heartbeat_ack'
  | 'sync_code'
  | 'sync_status'
  | 'match_data'
  | 'match_data_ack'
  | 'settings_request'
  | 'settings_response'
  | 'settings_update'
  | 'log'
  | 'error';

/**
 * Connection state machine
 */
export type ConnectionState =
  | 'disconnected'
  | 'listening'
  | 'connecting'
  | 'connected'
  | 'authenticated';

/**
 * Queued message for offline resilience
 */
export interface QueuedMessage {
  message: BridgeMessage;
  timestamp: number;
  attempts: number;
  maxAttempts?: number;
}

/**
 * Bridge error information
 */
export interface BridgeError {
  type: BridgeErrorType;
  message: string;
  timestamp: number;
  metadata?: Record<string, any>;
  recoverable?: boolean;
}

/**
 * Types of bridge errors
 */
export type BridgeErrorType =
  | 'server_error'
  | 'client_error'
  | 'timeout'
  | 'auth_failed'
  | 'invalid_message'
  | 'send_failed'
  | 'connection_lost';

/**
 * Log entry structure
 */
export interface LogEntry {
  timestamp: number;
  category: LogCategory;
  level: LogLevel;
  message: string;
  metadata?: Record<string, any>;
}

/**
 * Log categories for filtering
 */
export type LogCategory = 'SYNC' | 'BRIDGE' | 'MATCH' | 'UI' | 'CONFIG';

/**
 * Log severity levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Authentication payload (Chrome → VS Code)
 */
export interface AuthPayload {
  token: string;
  version: string;
  clientInfo?: {
    userAgent?: string;
    extensionVersion?: string;
  };
}

/**
 * Authentication acknowledgment (VS Code → Chrome)
 */
export interface AuthAckPayload {
  status: 'success' | 'failure';
  serverVersion?: string;
  reason?: string;
}

/**
 * Heartbeat payload (bidirectional)
 */
export interface HeartbeatPayload {
  timestamp: number;
  source: 'vscode' | 'chrome';
  sequence?: number;
}

/**
 * Sync code payload (VS Code → Chrome)
 */
export interface SyncCodePayload {
  language: string;
  code: string;
  stripComments: boolean;
  strategy?: string;
  fileName?: string;
  originalSize?: number;
  processedSize?: number;
}

/**
 * Sync status response (Chrome → VS Code)
 */
export interface SyncStatusPayload {
  status: 'success' | 'failure';
  duration?: number;
  timestamp: number;
  reason?: string;
  error?: string;
  details?: {
    retryable?: boolean;
    url?: string;
  };
}

/**
 * Match data payload (Chrome → VS Code)
 */
export interface MatchDataPayload {
  deliveryId: string;
  match_id: string;
  result: 'WIN' | 'LOSE' | 'DRAW';
  order: 0 | 1;
  arena: boolean;
  opponent?: string;
  league?: string;
  timestamp: string;
  durationMs?: number;
  logs?: {
    stdout?: string;
    stderr?: string;
  };
  metadata?: Record<string, any>;
}

/**
 * Match data acknowledgment (VS Code → Chrome)
 */
export interface MatchDataAckPayload {
  deliveryId: string;
  success: boolean;
  matchId?: string;
  reason?: string;
  error?: string;
  timestamp: number;
}

/**
 * Settings request payload (Chrome → VS Code)
 */
export interface SettingsRequestPayload {
  keys?: string[];
}

/**
 * Settings response payload (VS Code → Chrome)
 */
export interface SettingsResponsePayload {
  stripComments?: boolean;
  commentStrategy?: string;
  autoSync?: boolean;
  [key: string]: any;
}

/**
 * Settings update payload (bidirectional)
 */
export interface SettingsUpdatePayload {
  key: string;
  value: any;
  source?: 'vscode' | 'chrome';
}

/**
 * Remote log payload (Chrome → VS Code)
 */
export interface RemoteLogPayload {
  level: LogLevel;
  message: string;
  timestamp: number;
  category?: LogCategory;
}

/**
 * Error message payload (VS Code → Chrome)
 */
export interface ErrorPayload {
  requestId: string | null;
  code: string;
  message: string;
  details?: any;
}

/**
 * Bridge configuration options
 */
export interface BridgeConfig {
  port: number;
  host: string;
  heartbeatInterval: number;
  heartbeatTimeout: number;
  maxQueueSize: number;
  maxReconnectAttempts: number;
  reconnectDelays: number[];
  authTimeout: number;
}

/**
 * Bridge statistics
 */
export interface BridgeStats {
  connectionState: ConnectionState;
  connectedAt: number | null;
  lastHeartbeatTime: number;
  lastHeartbeatLatency: number;
  messagesSent: number;
  messagesReceived: number;
  queueSize: number;
  reconnectAttempts: number;
  uptime: number;
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  operation: string;
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Connection event data
 */
export interface ConnectionEvent {
  state: ConnectionState;
  timestamp: number;
  previousState?: ConnectionState;
  reason?: string;
}

/**
 * Message send options
 */
export interface SendOptions {
  timeout?: number;
  retryOnFailure?: boolean;
  priority?: 'high' | 'normal' | 'low';
}

/**
 * Bridge initialization result
 */
export interface BridgeInitResult {
  success: boolean;
  port: number;
  authToken: string;
  error?: string;
}
