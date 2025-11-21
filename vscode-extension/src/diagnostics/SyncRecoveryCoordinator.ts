/**
 * Sync Recovery Coordinator
 *
 * Handles resending of sync payloads with confirmation tracking.
 * Manages the lifecycle of sync recovery operations.
 *
 * Task 2.7: Diagnostic & Recovery Commands
 */

import * as vscode from 'vscode';
import { SyncPayload, SyncResult } from '../services/SyncController';
import { ResendResult } from './types';

export class SyncRecoveryCoordinator {
  private pendingConfirmations = new Map<string, {
    resolve: (result: SyncResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(
    private bridgeClient: any, // BridgeClient type
    private outputChannel: vscode.OutputChannel
  ) {
    // Listen for sync_status messages if bridge client is available
    if (this.bridgeClient && this.bridgeClient.onMessage) {
      this.bridgeClient.onMessage((message: any) => {
        if (message.type === 'sync_status') {
          this.handleSyncStatus(message.payload);
        }
      });
    }
  }

  /**
   * Resend a sync payload with a new request ID
   *
   * @param payload - Original sync payload to resend
   * @returns Result of resend operation
   */
  async resendPayload(payload: SyncPayload): Promise<ResendResult> {
    // Generate new requestId for tracking
    const newRequestId = `resend_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.log(`[RECOVERY] Resending sync payload: originalRequestId=${payload.requestId}, newRequestId=${newRequestId}`);

    // Clone payload with new requestId and resend flag
    const resendPayload: any = {
      type: 'sync_code',
      requestId: newRequestId,
      payload: {
        ...payload.payload,
        resend: true,
        originalRequestId: payload.requestId,
        originalTimestamp: payload.timestamp
      },
      version: '1.0.0'
    };

    try {
      // Check if bridge is available
      if (!this.bridgeClient) {
        this.log('[RECOVERY] Bridge client not available', true);
        return {
          success: false,
          reason: 'BRIDGE_UNAVAILABLE',
          timestamp: new Date().toISOString()
        };
      }

      // Send through bridge
      await this.bridgeClient.send(resendPayload);

      this.log(`[RECOVERY] Resend payload sent: requestId=${newRequestId}`);

      return {
        success: true,
        requestId: newRequestId,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`[RECOVERY] Resend failed: ${errorMsg}`, true);

      return {
        success: false,
        reason: 'SEND_FAILED',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Wait for confirmation of a sync request
   *
   * @param requestId - Request ID to wait for
   * @param timeoutMs - Timeout in milliseconds
   * @returns Promise that resolves with sync result or rejects on timeout
   */
  waitForConfirmation(requestId: string, timeoutMs: number): Promise<SyncResult> {
    return new Promise<SyncResult>((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingConfirmations.delete(requestId);
        reject(new Error('Confirmation timeout'));
      }, timeoutMs);

      // Store pending confirmation
      this.pendingConfirmations.set(requestId, {
        resolve,
        reject,
        timeout
      });

      this.log(`[RECOVERY] Waiting for confirmation: requestId=${requestId}, timeout=${timeoutMs}ms`);
    });
  }

  /**
   * Handle sync status message from bridge
   *
   * @param result - Sync result from Chrome extension
   */
  private handleSyncStatus(result: SyncResult): void {
    const pending = this.pendingConfirmations.get(result.requestId);

    if (pending) {
      this.log(`[RECOVERY] Received confirmation: requestId=${result.requestId}, status=${result.status}`);

      // Clear timeout
      clearTimeout(pending.timeout);

      // Resolve promise
      pending.resolve(result);

      // Remove from pending
      this.pendingConfirmations.delete(result.requestId);
    }
  }

  /**
   * Cancel all pending confirmations
   */
  cancelAllPending(): void {
    for (const [, pending] of this.pendingConfirmations.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Cancelled'));
    }
    this.pendingConfirmations.clear();
    this.log('[RECOVERY] All pending confirmations cancelled');
  }

  /**
   * Get count of pending confirmations
   */
  getPendingCount(): number {
    return this.pendingConfirmations.size;
  }

  /**
   * Log message to output channel
   */
  private log(message: string, isError: boolean = false): void {
    const timestamp = new Date().toISOString();
    const prefix = isError ? '[ERROR]' : '[INFO]';
    this.outputChannel.appendLine(`${timestamp} ${prefix} ${message}`);
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.cancelAllPending();
  }
}
