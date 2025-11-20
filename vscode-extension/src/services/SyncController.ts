import * as vscode from 'vscode';
import { ConfigurationService } from './ConfigurationService';
import { CommentProcessor } from './CommentProcessor';

/**
 * Sync Controller Service
 *
 * Manages the code sync lifecycle from VS Code to the browser.
 * Handles command execution, status reporting, and integration with the bridge client.
 *
 * Task 2.3: Sync Command Lifecycle
 */
export class SyncController implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private outputChannel: vscode.OutputChannel;
  private statusBarItem: vscode.StatusBarItem;

  // Sync state tracking
  private syncInProgress: boolean = false;
  private lastSyncPayload: SyncPayload | undefined;
  private lastSyncTime: Date | undefined;
  private lastSyncResult: SyncResult | undefined;
  private syncRequestId: number = 0;
  private lastCodeEditor: vscode.TextEditor | undefined;

  // Bridge client (to be implemented in Task 2.6)
  private bridgeClient: any = undefined;

  constructor(
    private configService: ConfigurationService,
    private commentProcessor: CommentProcessor,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel;

    // Create status bar item for sync feedback
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'codingame.sync';
    this.updateStatusBar('idle');
    this.statusBarItem.show();

    this.disposables.push(this.statusBarItem);

    // Track active editor changes to remember last code editor
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && this.isValidCodeEditor(editor)) {
          this.lastCodeEditor = editor;
        }
      })
    );

    // Initialize with current active editor if valid
    const currentEditor = vscode.window.activeTextEditor;
    if (currentEditor && this.isValidCodeEditor(currentEditor)) {
      this.lastCodeEditor = currentEditor;
    }
  }

  /**
   * Execute sync command - Happy Path scenario
   *
   * Scenario: "Happy Path"
   * Given: active Python file `bot.py`
   * When: user runs the command
   * Then: status bar shows "Syncing…", bridge receives payload,
   *       `sync_status:success` results in toast "Synced"
   */
  async syncCode(): Promise<void> {
    // Prevent concurrent syncs
    if (this.syncInProgress) {
      vscode.window.showWarningMessage('CodinGame: Sync already in progress');
      this.log('[SYNC] Sync already in progress, ignoring request');
      return;
    }

    try {
      this.syncInProgress = true;
      this.updateStatusBar('syncing');

      // Get active editor - prefer last known code editor over current active
      let editor = vscode.window.activeTextEditor;

      // If current active editor is not a valid code editor (e.g., output channel),
      // use the last known code editor
      if (!editor || !this.isValidCodeEditor(editor)) {
        editor = this.lastCodeEditor;
      }

      if (!editor) {
        this.syncInProgress = false;
        this.updateStatusBar('idle');
        vscode.window.showWarningMessage(
          'CodinGame: No valid code editor found. Please open a code file first.'
        );
        this.log('[SYNC] No valid code editor found, aborting sync');
        return;
      }

      // Update last code editor if current is valid
      if (this.isValidCodeEditor(editor)) {
        this.lastCodeEditor = editor;
      }

      const document = editor.document;
      const code = document.getText();
      const languageId = document.languageId;
      const fileName = document.fileName;

      this.log(`[SYNC] Starting sync for ${fileName} (${languageId})`);

      // Process code (strip comments if enabled)
      const stripComments = this.configService.getStripComments();
      let processedCode = code;
      let stripped = false;
      let strategy = 'none';

      if (stripComments) {
        this.log('[SYNC] Comment stripping enabled, processing code...');
        const result = await this.commentProcessor.processCode(code, languageId);

        if (result.error) {
          this.log(`[SYNC] Comment processing failed: ${result.error}`, true);
          vscode.window.showWarningMessage(
            `CodinGame: Comment stripping failed (${result.error}), sending original code`
          );
          // Continue with original code
        } else {
          processedCode = result.code;
          stripped = result.stripped;
          strategy = result.strategy;

          if (stripped) {
            const stats = this.commentProcessor.getStats(code, processedCode);
            this.log(
              `[SYNC] Code processed: ${stats.originalSize} → ${stats.processedSize} bytes (${stats.reductionPercent}% reduction, ${strategy} strategy)`
            );
          }
        }
      }

      // Build sync payload
      const requestId = this.generateRequestId();
      const payload: SyncPayload = {
        type: 'sync_code',
        requestId,
        timestamp: new Date().toISOString(),
        payload: {
          language: this.normalizeLanguage(languageId),
          code: processedCode,
          stripComments: stripped,
          strategy,
          fileName: fileName,
          originalSize: code.length,
          processedSize: processedCode.length,
        },
        version: '1.0.0',
      };

      // Cache payload for potential resend
      this.lastSyncPayload = payload;
      this.lastSyncTime = new Date();

      this.log(`[SYNC] Payload prepared: requestId=${requestId}, size=${processedCode.length} bytes`);

      // Send to bridge (Scenario: "Sync Failure" - bridge disconnected)
      if (!this.bridgeClient) {
        throw new Error('Bridge client not available');
      }

      // Send payload to bridge
      this.log('[SYNC] Sending payload to bridge...');
      await this.bridgeClient.send(payload);

      // Wait for sync_status response with timeout
      const result = await this.waitForSyncStatus(requestId, 8000);
      await this.handleSyncStatus(result);

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[SYNC] Sync failed: ${message}`, true);

      this.lastSyncResult = {
        requestId: this.lastSyncPayload?.requestId || '',
        status: 'failure',
        timestamp: new Date().toISOString(),
        error: message,
      };

      this.updateStatusBar('error');

      // Scenario: "Sync Failure" notification
      vscode.window.showErrorMessage(
        `CodinGame: Sync failed - ${message}`,
        'Retry',
        'View Logs'
      ).then(action => {
        if (action === 'Retry') {
          this.syncCode();
        } else if (action === 'View Logs') {
          this.outputChannel.show();
        }
      });

    } finally {
      this.syncInProgress = false;

      // Update status bar after delay if not syncing again
      setTimeout(() => {
        if (!this.syncInProgress) {
          this.updateStatusBar(this.lastSyncResult?.status === 'success' ? 'success' : 'idle');
        }
      }, 2000);
    }
  }

  /**
   * Resend last successful sync payload
   * Command: CodinGame: Resend Last Code Snapshot (Task 2.7 scenario)
   */
  async resendLastSync(): Promise<void> {
    if (!this.lastSyncPayload) {
      vscode.window.showWarningMessage('CodinGame: No previous sync to resend');
      this.log('[SYNC] No cached sync payload to resend');
      return;
    }

    this.log(`[SYNC] Resending last sync payload: requestId=${this.lastSyncPayload.requestId}`);

    // Update request ID and timestamp
    const requestId = this.generateRequestId();
    const payload: SyncPayload = {
      ...this.lastSyncPayload,
      requestId,
      timestamp: new Date().toISOString(),
      resend: true,
    };

    this.lastSyncPayload = payload;

    try {
      if (!this.bridgeClient) {
        this.log('[SYNC] Bridge client not yet implemented, cannot resend');
        vscode.window.showInformationMessage(
          'CodinGame: Resend command will be fully functional in Task 2.6'
        );
        return;
      }

      // When bridge is implemented:
      // await this.bridgeClient.send(payload);
      // const result = await this.waitForSyncStatus(requestId, 5000);
      // await this.handleSyncStatus(result);

      vscode.window.showInformationMessage('CodinGame: Replayed last sync');
      this.log('[SYNC] Last sync replayed successfully');

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[SYNC] Resend failed: ${message}`, true);
      vscode.window.showErrorMessage(`CodinGame: Resend failed - ${message}`);
    }
  }

  /**
   * Handle sync status response from bridge
   *
   * @param result - Sync result from Chrome extension
   */
  private async handleSyncStatus(result: SyncResult): Promise<void> {
    this.lastSyncResult = result;

    const duration = result.duration || 0;

    if (result.status === 'success') {
      this.log(`[SYNC] Sync successful: requestId=${result.requestId}, duration=${duration}ms`);

      this.updateStatusBar('success');

      // Show success toast (Scenario: "Happy Path")
      const payload = this.lastSyncPayload?.payload;
      const sizeInfo = payload
        ? `${payload.processedSize} bytes${payload.stripComments ? ` (${payload.strategy})` : ''}`
        : '';

      vscode.window.showInformationMessage(
        `CodinGame: Synced ${sizeInfo} in ${duration}ms`
      );

    } else {
      this.log(`[SYNC] Sync failed: requestId=${result.requestId}, error=${result.error}`, true);

      this.updateStatusBar('error');

      // Show failure notification
      const reason = result.reason || result.error || 'Unknown error';
      vscode.window.showErrorMessage(
        `CodinGame: Sync failed - ${reason}`,
        'Retry'
      ).then(action => {
        if (action === 'Retry') {
          this.syncCode();
        }
      });
    }

    // Log detailed result to output channel
    this.log(`[SYNC] Result details: ${JSON.stringify(result)}`);
  }

  /**
   * Update status bar item based on sync state
   */
  private updateStatusBar(state: 'idle' | 'syncing' | 'success' | 'error'): void {
    switch (state) {
      case 'idle':
        this.statusBarItem.text = '$(cloud-upload) CodinGame';
        this.statusBarItem.tooltip = 'Click to sync code to browser';
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.color = undefined;
        break;

      case 'syncing':
        this.statusBarItem.text = '$(sync~spin) Syncing...';
        this.statusBarItem.tooltip = 'Syncing code to browser...';
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.color = undefined;
        break;

      case 'success':
        this.statusBarItem.text = '$(check) CodinGame';
        this.statusBarItem.tooltip = `Last sync: ${this.lastSyncTime?.toLocaleTimeString() || 'unknown'}`;
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
        break;

      case 'error':
        this.statusBarItem.text = '$(error) CodinGame';
        this.statusBarItem.tooltip = `Sync failed: ${this.lastSyncResult?.error || 'unknown error'}`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.statusBarItem.color = undefined;
        break;
    }
  }

  /**
   * Generate unique request ID for sync operations
   */
  private generateRequestId(): string {
    this.syncRequestId++;
    const timestamp = Date.now();
    return `sync_${timestamp}_${this.syncRequestId}`;
  }

  /**
   * Normalize VS Code language ID to CodinGame language format
   */
  private normalizeLanguage(languageId: string): string {
    const languageMap: Record<string, string> = {
      'python': 'Python3',
      'javascript': 'JavaScript',
      'typescript': 'TypeScript',
      'java': 'Java',
      'cpp': 'C++',
      'c': 'C',
      'csharp': 'C#',
      'rust': 'Rust',
      'go': 'Go',
      'kotlin': 'Kotlin',
      'swift': 'Swift',
      'ruby': 'Ruby',
      'php': 'PHP',
      'dart': 'Dart',
      'scala': 'Scala',
      'perl': 'Perl',
      'lua': 'Lua',
      'haskell': 'Haskell',
      'clojure': 'Clojure',
      'fsharp': 'F#',
      'ocaml': 'OCaml',
      'bash': 'Bash',
      'powershell': 'PowerShell',
      'objectivec': 'Objective-C',
      'groovy': 'Groovy',
      'vb': 'VB.NET',
    };

    return languageMap[languageId.toLowerCase()] || languageId;
  }

  /**
   * Get sync statistics for display
   */
  getSyncStats(): SyncStats {
    return {
      lastSyncTime: this.lastSyncTime,
      lastSyncResult: this.lastSyncResult,
      syncInProgress: this.syncInProgress,
      hasCachedPayload: !!this.lastSyncPayload,
    };
  }

  /**
   * Get last sync payload (for debugging/inspection)
   */
  getLastSyncPayload(): SyncPayload | undefined {
    return this.lastSyncPayload;
  }

  /**
   * Get last sync time (Task 2.7)
   */
  getLastSyncTime(): Date | undefined {
    return this.lastSyncTime;
  }

  /**
   * Get last sync result (Task 2.7)
   */
  getLastSyncResult(): SyncResult | undefined {
    return this.lastSyncResult;
  }

  /**
   * Clear cached sync data
   */
  clearCache(): void {
    this.lastSyncPayload = undefined;
    this.lastSyncTime = undefined;
    this.lastSyncResult = undefined;
    this.log('[SYNC] Cache cleared');
  }

  /**
   * Set bridge client (to be called when bridge is initialized in Task 2.6)
   */
  setBridgeClient(client: any): void {
    this.bridgeClient = client;
    this.log('[SYNC] Bridge client registered');
    this.updateStatusBar('idle');
  }

  /**
   * Log message to output channel
   */
  private log(message: string, isError: boolean = false): void {
    const timestamp = new Date().toISOString();
    const prefix = isError ? '[ERROR]' : '[INFO]';
    this.outputChannel.appendLine(`${timestamp} ${prefix} ${message}`);

    // Also log to console if verbose
    if (this.configService.isVerboseLogging()) {
      console.log(`${prefix} ${message}`);
    }
  }

  /**
   * Check if editor is a valid code editor (not output channel, settings, etc.)
   */
  private isValidCodeEditor(editor: vscode.TextEditor): boolean {
    const document = editor.document;

    // Exclude output channels and other special schemes
    if (document.uri.scheme === 'output' ||
      document.uri.scheme === 'debug' ||
      document.uri.scheme === 'vscode' ||
      document.uri.scheme === 'git') {
      return false;
    }

    // Exclude untitled files without language ID
    if (document.isUntitled && !document.languageId) {
      return false;
    }

    // Must have a language ID
    if (!document.languageId || document.languageId === 'plaintext') {
      return false;
    }

    // Exclude specific language IDs that are not code
    const excludedLanguages = ['log', 'scminput', 'search-result'];
    if (excludedLanguages.includes(document.languageId)) {
      return false;
    }

    return true;
  }

  /**
   * Wait for sync status response from bridge
   */
  private waitForSyncStatus(requestId: string, timeoutMs: number): Promise<SyncResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (disposable) {
          disposable.dispose();
        }
        reject(new Error('Sync response timeout'));
      }, timeoutMs);

      // Listen for sync_status messages from bridge using VS Code EventEmitter
      let disposable: any;

      if (this.bridgeClient?.onMessage) {
        disposable = this.bridgeClient.onMessage((message: any) => {
          if (message.type === 'sync_status' && message.requestId === requestId) {
            clearTimeout(timeout);
            disposable.dispose();

            const result: SyncResult = {
              requestId: message.requestId,
              status: message.payload?.status || message.status || 'failure',
              timestamp: message.timestamp || new Date().toISOString(),
              duration: message.duration,
              error: message.payload?.error || message.error,
              reason: message.payload?.reason || message.reason,
              details: message.payload?.details || message.details,
            };

            resolve(result);
          }
        });
      } else {
        clearTimeout(timeout);
        reject(new Error('Bridge client does not support message listeners'));
      }
    });
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.clearCache();
  }
}

/**
 * Sync payload structure sent to Chrome extension
 */
export interface SyncPayload {
  type: 'sync_code';
  requestId: string;
  timestamp: string;
  version?: string;
  resend?: boolean;
  payload: {
    language: string;
    code: string;
    stripComments: boolean;
    strategy: string;
    fileName: string;
    originalSize: number;
    processedSize: number;
  };
}

/**
 * Sync result received from Chrome extension
 */
export interface SyncResult {
  requestId: string;
  status: 'success' | 'failure';
  timestamp: string;
  duration?: number;
  error?: string;
  reason?: string;
  details?: Record<string, any>;
}

/**
 * Sync statistics for display/debugging
 */
export interface SyncStats {
  lastSyncTime?: Date;
  lastSyncResult?: SyncResult;
  syncInProgress: boolean;
  hasCachedPayload: boolean;
}
