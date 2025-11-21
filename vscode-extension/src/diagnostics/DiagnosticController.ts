/**
 * Diagnostic Controller
 *
 * Main controller for diagnostic and recovery operations.
 * Provides commands for resending sync, retrying failed matches,
 * generating diagnostic reports, and clearing cache.
 *
 * Task 2.7: Diagnostic & Recovery Commands
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SyncController } from '../services/SyncController';
import { MatchStorageService } from '../services/MatchStorageService';
import { ConfigurationService } from '../services/ConfigurationService';
import { SyncRecoveryCoordinator } from './SyncRecoveryCoordinator';
import { MatchRecoveryCoordinator } from './MatchRecoveryCoordinator';
import {
  ResendResult,
  RetryResult,
  DiagnosticReport,
  RecoveryEvent,
  ClearOptions
} from './types';

export class DiagnosticController implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private syncRecovery: SyncRecoveryCoordinator;
  private matchRecovery: MatchRecoveryCoordinator;

  // Recovery tracking
  private recoveryHistory: RecoveryEvent[] = [];
  private readonly MAX_HISTORY_SIZE: number;

  constructor(
    private syncController: SyncController,
    private matchStorageService: MatchStorageService,
    private bridgeClient: any,
    private configService: ConfigurationService,
    private outputChannel: vscode.OutputChannel,
    private context: vscode.ExtensionContext
  ) {
    this.MAX_HISTORY_SIZE = this.configService.get<number>('diagnostics.maxRecoveryHistory', 50);

    // Initialize recovery coordinators
    this.syncRecovery = new SyncRecoveryCoordinator(bridgeClient, outputChannel);
    this.matchRecovery = new MatchRecoveryCoordinator(matchStorageService, bridgeClient, outputChannel);

    this.disposables.push(this.syncRecovery);

    this.log('[DIAGNOSTIC] Controller initialized');
  }

  /**
   * Resend last sync snapshot
   * Command: CodinGame: Resend Last Code Snapshot
   *
   * Scenario 2.7.1: Resend Last Code Snapshot
   */
  async resendLastSnapshot(): Promise<ResendResult> {
    const startTime = Date.now();
    this.log('[DIAGNOSTIC] Resend last snapshot requested');

    // Step 1: Validate preconditions - check if cached payload exists
    const lastPayload = this.syncController.getLastSyncPayload();
    if (!lastPayload) {
      const message = 'No previous sync payload available to resend';
      this.log(`[DIAGNOSTIC] ${message}`);
      vscode.window.showWarningMessage(`CodinGame: ${message}`);

      return {
        success: false,
        reason: 'NO_CACHED_PAYLOAD',
        timestamp: new Date().toISOString()
      };
    }

    const lastSyncTime = this.syncController.getLastSyncTime();
    const age = lastSyncTime ? Date.now() - lastSyncTime.getTime() : 0;

    this.log(
      `[DIAGNOSTIC] Found cached payload from ${lastSyncTime?.toISOString() || 'unknown'} (${Math.floor(age / 1000)}s ago)`
    );

    // Step 2: Check bridge connectivity
    const bridgeState = this.bridgeClient?.getConnectionState?.() || 'unknown';
    if (bridgeState !== 'connected') {
      const message = `Bridge is ${bridgeState}. Please ensure the Chrome extension is connected.`;
      this.log(`[DIAGNOSTIC] ${message}`);
      vscode.window.showWarningMessage(`CodinGame: ${message}`);

      return {
        success: false,
        reason: 'BRIDGE_OFFLINE',
        timestamp: new Date().toISOString()
      };
    }

    // Step 3: Use recovery coordinator to resend with progress
    let resendSuccess = false;
    let resendRequestId: string | undefined;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'CodinGame: Replaying last sync...',
          cancellable: false
        },
        async (progress) => {
          progress.report({ increment: 0 });

          // Resend payload
          const result = await this.syncRecovery.resendPayload(lastPayload);
          resendSuccess = result.success;
          resendRequestId = result.requestId;

          if (!result.success) {
            throw new Error(result.reason || 'Resend failed');
          }

          progress.report({ increment: 50, message: 'Waiting for confirmation...' });

          // Wait for confirmation with timeout
          const confirmationTimeout = 10000; // 10 seconds
          try {
            const syncResult = await this.syncRecovery.waitForConfirmation(
              result.requestId!,
              confirmationTimeout
            );
            resendSuccess = syncResult.status === 'success';
            progress.report({ increment: 100 });
          } catch (error) {
            // Timeout or error - payload was sent but not confirmed
            this.log(`[DIAGNOSTIC] Confirmation timeout or error: ${error}`);
            resendSuccess = false; // Mark as unconfirmed
          }
        }
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`[DIAGNOSTIC] Resend error: ${errorMsg}`, true);
      resendSuccess = false;
    }

    const duration = Date.now() - startTime;

    // Step 4: Record recovery event
    const event: RecoveryEvent = {
      type: 'sync_resend',
      timestamp: new Date().toISOString(),
      success: resendSuccess,
      duration,
      details: {
        requestId: resendRequestId,
        originalTime: lastSyncTime?.toISOString(),
        ageSeconds: Math.floor(age / 1000)
      }
    };
    this.recordRecoveryEvent(event);

    // Step 5: Show result notification
    if (resendSuccess) {
      vscode.window.showInformationMessage(
        `✓ CodinGame: Replayed last sync (${Math.floor(duration / 1000)}s)`
      );
      this.log(`[DIAGNOSTIC] Resend successful (${duration}ms)`);
    } else {
      vscode.window.showWarningMessage(
        'CodinGame: Sync replayed but confirmation not received. Check Chrome extension.'
      );
      this.log(`[DIAGNOSTIC] Resend sent but not confirmed (${duration}ms)`);
    }

    return {
      success: resendSuccess,
      reason: resendSuccess ? undefined : 'NO_CONFIRMATION',
      timestamp: new Date().toISOString(),
      duration,
      requestId: resendRequestId
    };
  }

  /**
   * Retry failed matches
   * Command: CodinGame: Retry Failed Matches
   *
   * Scenario 2.7.2: Retry Failed Matches
   */
  async retryFailedMatches(): Promise<RetryResult> {
    const startTime = Date.now();
    this.log('[DIAGNOSTIC] Retry failed matches requested');

    // Step 1: Get failed payloads
    const failedPayloads = this.matchStorageService.getFailedPayloads();

    if (failedPayloads.length === 0) {
      const message = 'No failed match payloads to retry';
      this.log(`[DIAGNOSTIC] ${message}`);
      vscode.window.showInformationMessage(`CodinGame: ${message}`);

      return {
        success: true,
        processed: 0,
        succeeded: 0,
        failed: 0,
        timestamp: new Date().toISOString()
      };
    }

    this.log(
      `[DIAGNOSTIC] Found ${failedPayloads.length} failed payload(s) to retry`
    );

    // Step 2: Confirm with user
    const confirmed = await vscode.window.showInformationMessage(
      `CodinGame: Retry ${failedPayloads.length} failed match payload(s)?`,
      { modal: true },
      'Retry All',
      'Cancel'
    );

    if (confirmed !== 'Retry All') {
      this.log('[DIAGNOSTIC] User cancelled retry');
      return {
        success: false,
        reason: 'USER_CANCELLED',
        processed: 0,
        succeeded: 0,
        failed: 0,
        timestamp: new Date().toISOString()
      };
    }

    // Step 3: Process each failed payload
    let succeeded = 0;
    let failed = 0;
    const errors: Array<{ matchId: string; error: string }> = [];

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CodinGame: Retrying failed matches...',
        cancellable: false
      },
      async (progress) => {
        const increment = 100 / failedPayloads.length;

        for (const failedPayload of failedPayloads) {
          const payload = failedPayload.payload;

          progress.report({
            increment,
            message: `${succeeded + failed + 1}/${failedPayloads.length}`
          });

          this.log(
            `[DIAGNOSTIC] Retrying match_id=${payload.match_id} (attempt ${failedPayload.attempts + 1})`
          );

          try {
            // Use recovery coordinator
            const result = await this.matchRecovery.retryPayload(failedPayload);

            if (result.success) {
              succeeded++;
              this.log(`[MATCH] retried: ${payload.match_id} - SUCCESS`);

              // Remove from failed list
              this.matchStorageService.clearFailedPayload(payload.deliveryId || '');
            } else {
              failed++;
              errors.push({
                matchId: payload.match_id || 'unknown',
                error: result.reason || 'Unknown error'
              });
              this.log(
                `[MATCH] retried: ${payload.match_id} - FAILED: ${result.reason}`
              );

              // Note: Failed payload remains in the list with updated attempt count
              // The MatchStorageService will update it automatically on next failure
            }
          } catch (error) {
            failed++;
            const errorMsg = error instanceof Error ? error.message : String(error);
            errors.push({ matchId: payload.match_id || 'unknown', error: errorMsg });
            this.log(`[MATCH] retried: ${payload.match_id || 'unknown'} - ERROR: ${errorMsg}`, true);
          }
        }
      }
    );

    const duration = Date.now() - startTime;

    // Step 4: Record recovery event
    const event: RecoveryEvent = {
      type: 'match_retry',
      timestamp: new Date().toISOString(),
      success: failed === 0,
      duration,
      details: {
        processed: failedPayloads.length,
        succeeded,
        failed,
        errors: errors.slice(0, 10) // Limit error details
      }
    };
    this.recordRecoveryEvent(event);

    // Step 5: Show summary notification
    if (failed === 0) {
      vscode.window.showInformationMessage(
        `✓ CodinGame: Successfully retried ${succeeded} match(es)`
      );
    } else {
      const action = await vscode.window.showWarningMessage(
        `CodinGame: Retried ${succeeded}/${failedPayloads.length} match(es). ${failed} still failed.`,
        'View Logs'
      );

      if (action === 'View Logs') {
        this.outputChannel.show();
      }
    }

    this.log(
      `[DIAGNOSTIC] Retry complete: ${succeeded} succeeded, ${failed} failed (${duration}ms)`
    );

    return {
      success: failed === 0,
      processed: failedPayloads.length,
      succeeded,
      failed,
      errors,
      timestamp: new Date().toISOString(),
      duration
    };
  }

  /**
   * Generate comprehensive diagnostic report
   * Command: CodinGame: Generate Diagnostic Report
   */
  async generateDiagnosticReport(): Promise<DiagnosticReport> {
    const startTime = Date.now();
    this.log('[DIAGNOSTIC] Generating diagnostic report...');

    const report: DiagnosticReport = {
      timestamp: new Date().toISOString(),
      version: this.getExtensionVersion(),

      // Bridge status
      bridge: {
        state: this.bridgeClient?.getConnectionState?.() || 'unknown',
        port: this.configService.get('bridge.port', 45123),
        lastHeartbeat: this.bridgeClient?.getLastHeartbeatTime?.(),
        messagesSent: this.bridgeClient?.getMessagesSent?.() || 0,
        messagesReceived: this.bridgeClient?.getMessagesReceived?.() || 0,
        queueSize: this.bridgeClient?.getQueueSize?.() || 0
      },

      // Sync status
      sync: {
        lastSyncTime: this.syncController.getLastSyncTime(),
        lastSyncResult: this.syncController.getLastSyncResult(),
        hasCachedPayload: this.syncController.getLastSyncPayload() !== undefined,
        stripComments: this.configService.get('sync.stripComments', false),
        commentStrategy: this.configService.get('sync.commentStrategy', 'auto')
      },

      // Match storage status
      storage: {
        directory: this.configService.get('matches.directory', '.codingame/matches'),
        totalMatches: this.matchStorageService.getMatchCount?.() || 0,
        failedPayloads: this.matchStorageService.getFailedPayloadsCount(),
        indexSize: 0, // Index size will be implemented if needed
        diskUsage: await this.calculateDiskUsage()
      },

      // Recovery history
      recovery: {
        recentEvents: this.recoveryHistory.slice(-10),
        totalResends: this.countRecoveryEvents('sync_resend'),
        totalRetries: this.countRecoveryEvents('match_retry'),
        successRate: this.calculateRecoverySuccessRate()
      },

      // Configuration
      config: {
        all: this.getAllConfig(),
        custom: this.getCustomSettings()
      },

      // System info
      system: {
        vscodeVersion: vscode.version,
        platform: process.platform,
        nodeVersion: process.version,
        workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      }
    };

    const duration = Date.now() - startTime;

    // Record diagnostic event
    const event: RecoveryEvent = {
      type: 'diagnostic_report',
      timestamp: new Date().toISOString(),
      success: true,
      duration,
      details: {
        reportSize: JSON.stringify(report).length
      }
    };
    this.recordRecoveryEvent(event);

    // Display report in new document
    const doc = await vscode.workspace.openTextDocument({
      content: this.formatReport(report),
      language: 'markdown'
    });

    await vscode.window.showTextDocument(doc, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside
    });

    this.log(`[DIAGNOSTIC] Report generated (${duration}ms)`);

    return report;
  }

  /**
   * Clear cache
   * Command: CodinGame: Clear Cache
   */
  async clearCache(options?: ClearOptions): Promise<void> {
    this.log('[DIAGNOSTIC] Clear cache requested');

    // Determine what to clear
    const confirmDestructive = this.configService.get('diagnostics.confirmDestructive', true);

    if (confirmDestructive) {
      const message = this.buildClearCacheMessage(options);
      const confirmed = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        'Clear Cache',
        'Cancel'
      );

      if (confirmed !== 'Clear Cache') {
        this.log('[DIAGNOSTIC] User cancelled cache clear');
        return;
      }
    }

    const startTime = Date.now();
    let clearedItems = 0;

    // Clear sync cache
    if (options?.clearSync !== false) {
      this.syncController.clearCache();
      clearedItems++;
      this.log('[DIAGNOSTIC] Cleared sync cache');
    }

    // Clear failed payloads
    if (options?.clearFailed !== false) {
      const failedCount = this.matchStorageService.getFailedPayloadsCount();
      this.matchStorageService.clearFailedPayloads();
      clearedItems += failedCount;
      this.log(`[DIAGNOSTIC] Cleared ${failedCount} failed payload(s)`);
    }

    // Clear recovery history
    if (options?.clearHistory !== false) {
      const historyCount = this.recoveryHistory.length;
      this.recoveryHistory = [];
      clearedItems += historyCount;
      this.log(`[DIAGNOSTIC] Cleared ${historyCount} recovery event(s)`);
    }

    // Optionally clear match files
    if (options?.clearMatches) {
      const matchCount = await this.matchStorageService.clearAllMatches();
      clearedItems += matchCount;
      this.log(`[DIAGNOSTIC] Deleted ${matchCount} match file(s)`);
    }

    const duration = Date.now() - startTime;

    // Record event
    const event: RecoveryEvent = {
      type: 'cache_clear',
      timestamp: new Date().toISOString(),
      success: true,
      duration,
      details: {
        itemsCleared: clearedItems,
        options
      }
    };
    this.recordRecoveryEvent(event);

    vscode.window.showInformationMessage(
      `✓ CodinGame: Cache cleared (${clearedItems} item(s))`
    );

    this.log(`[DIAGNOSTIC] Cache clear complete: ${clearedItems} items (${duration}ms)`);
  }

  /**
   * Get failed match count for status bar
   */
  getFailedMatchCount(): number {
    return this.matchStorageService.getFailedPayloadsCount();
  }

  /**
   * Check if last sync is available
   */
  hasLastSync(): boolean {
    return this.syncController.getLastSyncPayload() !== undefined;
  }

  /**
   * Record recovery event
   */
  private recordRecoveryEvent(event: RecoveryEvent): void {
    this.recoveryHistory.push(event);

    // Trim if exceeds max size
    if (this.recoveryHistory.length > this.MAX_HISTORY_SIZE) {
      this.recoveryHistory.shift();
    }
  }

  /**
   * Count recovery events by type
   */
  private countRecoveryEvents(type: string): number {
    return this.recoveryHistory.filter(e => e.type === type).length;
  }

  /**
   * Calculate recovery success rate
   */
  private calculateRecoverySuccessRate(): number {
    if (this.recoveryHistory.length === 0) {
      return 1.0;
    }

    const successCount = this.recoveryHistory.filter(e => e.success).length;
    return successCount / this.recoveryHistory.length;
  }

  /**
   * Calculate disk usage of match files
   */
  private async calculateDiskUsage(): Promise<number> {
    try {
      const matchesDir = this.configService.get('matches.directory', '.codingame/matches');
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      if (!workspaceFolder) {
        return 0;
      }

      const fullPath = path.join(workspaceFolder, matchesDir);
      const files = await fs.readdir(fullPath);

      let totalSize = 0;
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(fullPath, file);
          const stat = await fs.stat(filePath);
          totalSize += stat.size;
        }
      }

      return totalSize;
    } catch (error) {
      this.log(`[DIAGNOSTIC] Failed to calculate disk usage: ${(error as Error).message}`, true);
      return 0;
    }
  }

  /**
   * Format diagnostic report as markdown
   */
  private formatReport(report: DiagnosticReport): string {
    return `# CodinGame Extension Diagnostic Report

**Generated:** ${report.timestamp}
**Extension Version:** ${report.version}

---

## Bridge Status

- **State:** ${report.bridge.state}
- **Port:** ${report.bridge.port}
- **Last Heartbeat:** ${report.bridge.lastHeartbeat || 'N/A'}
- **Messages Sent:** ${report.bridge.messagesSent}
- **Messages Received:** ${report.bridge.messagesReceived}
- **Queue Size:** ${report.bridge.queueSize}

## Sync Status

- **Last Sync:** ${report.sync.lastSyncTime?.toLocaleString() || 'Never'}
- **Last Result:** ${report.sync.lastSyncResult?.status || 'N/A'}
- **Cached Payload:** ${report.sync.hasCachedPayload ? 'Yes' : 'No'}
- **Strip Comments:** ${report.sync.stripComments}
- **Comment Strategy:** ${report.sync.commentStrategy}

## Match Storage

- **Directory:** \`${report.storage.directory}\`
- **Total Matches:** ${report.storage.totalMatches}
- **Failed Payloads:** ${report.storage.failedPayloads}
- **Index Size:** ${report.storage.indexSize} entries
- **Disk Usage:** ${this.formatBytes(report.storage.diskUsage)}

## Recovery History

- **Total Resends:** ${report.recovery.totalResends}
- **Total Retries:** ${report.recovery.totalRetries}
- **Success Rate:** ${(report.recovery.successRate * 100).toFixed(1)}%

### Recent Events

${report.recovery.recentEvents.length > 0
        ? report.recovery.recentEvents.map(e =>
          `- \`${e.timestamp}\` - ${e.type}: ${e.success ? '✓' : '✗'} (${e.duration}ms)`
        ).join('\n')
        : '- No recent events'
      }

## System Info

- **VS Code:** ${report.system.vscodeVersion}
- **Platform:** ${report.system.platform}
- **Node:** ${report.system.nodeVersion}
- **Workspace:** \`${report.system.workspaceFolder || 'None'}\`

---

## Configuration

\`\`\`json
${JSON.stringify(report.config.all, null, 2)}
\`\`\`
`;
  }

  /**
   * Build clear cache confirmation message
   */
  private buildClearCacheMessage(options?: ClearOptions): string {
    const items: string[] = [];

    if (options?.clearSync !== false) {
      items.push('• Clear sync payload cache');
    }
    if (options?.clearFailed !== false) {
      items.push('• Clear failed match payloads');
    }
    if (options?.clearHistory !== false) {
      items.push('• Reset recovery history');
    }
    if (options?.clearMatches) {
      items.push('• DELETE all stored match files');
    }

    return `CodinGame: Clear cache? This will:\n${items.join('\n')}\n\nThis action cannot be undone.`;
  }

  /**
   * Format bytes for display
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Get extension version
   */
  private getExtensionVersion(): string {
    return this.context.extension?.packageJSON?.version || 'unknown';
  }

  /**
   * Get all configuration
   */
  private getAllConfig(): any {
    const config = vscode.workspace.getConfiguration('codingame');
    return config;
  }

  /**
   * Get custom settings (non-default)
   */
  private getCustomSettings(): any {
    // For now, return a subset of important settings
    return {
      'sync.stripComments': this.configService.get('sync.stripComments'),
      'sync.commentStrategy': this.configService.get('sync.commentStrategy'),
      'matches.directory': this.configService.get('matches.directory'),
      'bridge.port': this.configService.get('bridge.port')
    };
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
    this.disposables.forEach(d => d.dispose());
    this.syncRecovery.dispose();
  }
}
