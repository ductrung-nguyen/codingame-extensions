/**
 * Diagnostic Types
 *
 * Type definitions for diagnostic and recovery operations.
 * Task 2.7: Diagnostic & Recovery Commands
 */

import { SyncResult } from '../services/SyncController';
import { MatchPayload } from '../models/MatchRecord';

/**
 * Result of resending last sync snapshot
 */
export interface ResendResult {
  success: boolean;
  reason?: string;
  timestamp: string;
  duration?: number;
  requestId?: string;
}

/**
 * Result of retrying failed matches
 */
export interface RetryResult {
  success: boolean;
  reason?: string;
  processed: number;
  succeeded: number;
  failed: number;
  errors?: Array<{
    matchId: string;
    error: string;
  }>;
  timestamp: string;
  duration?: number;
}

/**
 * Comprehensive diagnostic report
 */
export interface DiagnosticReport {
  timestamp: string;
  version: string;

  bridge: {
    state: string;
    port: number;
    lastHeartbeat?: string;
    messagesSent: number;
    messagesReceived: number;
    queueSize: number;
  };

  sync: {
    lastSyncTime?: Date;
    lastSyncResult?: SyncResult;
    hasCachedPayload: boolean;
    stripComments: boolean;
    commentStrategy: string;
  };

  storage: {
    directory: string;
    totalMatches: number;
    failedPayloads: number;
    indexSize: number;
    diskUsage: number;
  };

  recovery: {
    recentEvents: RecoveryEvent[];
    totalResends: number;
    totalRetries: number;
    successRate: number;
  };

  config: {
    all: any;
    custom: any;
  };

  system: {
    vscodeVersion: string;
    platform: string;
    nodeVersion: string;
    workspaceFolder?: string;
  };
}

/**
 * Recovery event tracking
 */
export interface RecoveryEvent {
  type: 'sync_resend' | 'match_retry' | 'cache_clear' | 'diagnostic_report';
  timestamp: string;
  success: boolean;
  duration: number;
  details?: any;
}

/**
 * Failed payload tracking
 */
export interface FailedPayload {
  payload: MatchPayload;
  timestamp: string;
  attempts: number;
  lastError?: string;
}

/**
 * Options for cache clearing
 */
export interface ClearOptions {
  clearMatches?: boolean;
  clearSync?: boolean;
  clearFailed?: boolean;
  clearHistory?: boolean;
}

/**
 * Store result for match retry operations
 */
export interface RetryStoreResult {
  success: boolean;
  reason?: string;
  matchId?: string;
  errors?: string[];
}
