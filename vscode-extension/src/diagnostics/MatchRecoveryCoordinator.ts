/**
 * Match Recovery Coordinator
 *
 * Handles retry logic for failed match payloads.
 * Validates, re-stores, and sends acknowledgments for recovered matches.
 *
 * Task 2.7: Diagnostic & Recovery Commands
 */

import * as vscode from 'vscode';
import { MatchStorageService } from '../services/MatchStorageService';
import { FailedPayload } from './types';
import { StoreResult } from '../models/MatchRecord';

export class MatchRecoveryCoordinator {
  constructor(
    private matchStorageService: MatchStorageService,
    private bridgeClient: any, // BridgeClient type
    private outputChannel: vscode.OutputChannel
  ) { }

  /**
   * Retry storing a failed payload
   *
   * @param failedPayload - The failed payload to retry
   * @returns Result of retry operation
   */
  async retryPayload(failedPayload: FailedPayload): Promise<StoreResult> {
    const payload = failedPayload.payload;

    this.log(`[RECOVERY] Retrying payload: deliveryId=${payload.deliveryId}, match_id=${payload.match_id}, attempt=${failedPayload.attempts + 1}`);

    try {
      // Step 1: Attempt to store again
      const result = await this.matchStorageService.storeMatchData(payload);

      // Step 2: If successful, send acknowledgment to Chrome (if bridge connected)
      if (result.success && this.bridgeClient) {
        try {
          await this.sendRetryAcknowledgment(payload.deliveryId || '', payload.match_id || '', true);
        } catch (ackError) {
          // Don't fail the retry if ack fails - the match was stored successfully
          this.log(`[RECOVERY] Failed to send retry ack: ${(ackError as Error).message}`, true);
        }
      }

      return result;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`[RECOVERY] Retry failed: ${errorMsg}`, true);

      return {
        success: false,
        reason: 'INTERNAL_ERROR',
        error: errorMsg
      };
    }
  }

  /**
   * Send acknowledgment to Chrome extension for retried match
   *
   * @param deliveryId - Original delivery ID
   * @param matchId - Match ID
   * @param success - Whether retry was successful
   */
  private async sendRetryAcknowledgment(
    deliveryId: string,
    matchId: string,
    success: boolean
  ): Promise<void> {
    if (!this.bridgeClient) {
      return;
    }

    const ackMessage = {
      type: 'match_data_ack',
      requestId: `retry_${Date.now()}`,
      payload: {
        deliveryId,
        success,
        matchId,
        timestamp: new Date().toISOString(),
        retried: true
      },
      version: '1.0.0'
    };

    try {
      await this.bridgeClient.send(ackMessage);
      this.log(`[RECOVERY] Sent retry acknowledgment: deliveryId=${deliveryId}, success=${success}`);
    } catch (error) {
      // Log but don't throw - this is a non-critical operation
      this.log(`[RECOVERY] Failed to send ack: ${(error as Error).message}`, true);
    }
  }

  /**
   * Validate if a payload can be retried
   *
   * @param failedPayload - Failed payload to check
   * @returns Validation result
   */
  canRetry(failedPayload: FailedPayload): { canRetry: boolean; reason?: string } {
    const payload = failedPayload.payload;

    // Check required fields
    if (!payload.match_id) {
      return { canRetry: false, reason: 'Missing match_id' };
    }

    if (!payload.deliveryId) {
      return { canRetry: false, reason: 'Missing deliveryId' };
    }

    // Check attempt count (configurable limit)
    const maxAttempts = 10;
    if (failedPayload.attempts >= maxAttempts) {
      return { canRetry: false, reason: `Max retry attempts (${maxAttempts}) reached` };
    }

    return { canRetry: true };
  }

  /**
   * Log message to output channel
   */
  private log(message: string, isError: boolean = false): void {
    const timestamp = new Date().toISOString();
    const prefix = isError ? '[ERROR]' : '[INFO]';
    this.outputChannel.appendLine(`${timestamp} ${prefix} ${message}`);
  }
}
