import * as vscode from 'vscode';
import { ConfigurationService } from './services/ConfigurationService';
import { CommentProcessor } from './services/CommentProcessor';
import { SyncController } from './services/SyncController';
import { MatchStorageService } from './services/MatchStorageService';
import { StatisticsWebviewProvider } from './webview/StatisticsWebviewProvider';
import { BridgeStatusWebviewProvider } from './webview/BridgeStatusWebviewProvider';
import { BridgeClient } from './services/BridgeClient';
import { BridgeStatusBar } from './services/BridgeStatusBar';
import { DiagnosticController } from './diagnostics/DiagnosticController';

/**
 * CodinGame VS Code Extension
 * Main entry point for extension activation
 *
 * Task 2.1: Configuration Initialization
 * Task 2.2: Comment Stripping Modes
 * Task 2.3: Sync Command Lifecycle
 * Task 2.4: Match Data Storage
 * Task 2.5: Statistics Webview Interactions
 * Task 2.6: Bridge Resilience & Logging
 * Task 2.7: Diagnostic & Recovery Commands
 */

let configService: ConfigurationService | undefined;
let commentProcessor: CommentProcessor | undefined;
let syncController: SyncController | undefined;
let matchStorageService: MatchStorageService | undefined;
let statisticsProvider: StatisticsWebviewProvider | undefined;
let bridgeStatusProvider: BridgeStatusWebviewProvider | undefined;
let bridgeClient: BridgeClient | undefined;
let bridgeStatusBar: BridgeStatusBar | undefined;
let diagnosticController: DiagnosticController | undefined;
let outputChannel: vscode.OutputChannel | undefined;

/**
 * Extension activation
 * Called when extension is first activated
 */
export async function activate(context: vscode.ExtensionContext) {
  console.log('CodinGame extension is activating...');

  // Create output channel for logging
  outputChannel = vscode.window.createOutputChannel('CodinGame');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('='.repeat(80));
  outputChannel.appendLine('CodinGame VS Code Extension');
  outputChannel.appendLine(`Version: ${context.extension.packageJSON.version}`);
  outputChannel.appendLine(`Activation Time: ${new Date().toISOString()}`);
  outputChannel.appendLine('='.repeat(80));

  try {
    // Initialize Configuration Service (Task 2.1)
    configService = new ConfigurationService(context, outputChannel);
    context.subscriptions.push(configService);

    await configService.initialize();

    // Initialize Comment Processor (Task 2.2)
    commentProcessor = new CommentProcessor(configService, outputChannel);
    context.subscriptions.push(commentProcessor);

    // Initialize Bridge Client (Task 2.6) - must be before SyncController
    bridgeClient = new BridgeClient(configService, outputChannel);
    context.subscriptions.push(bridgeClient);

    // Start bridge server
    const bridgeResult = await bridgeClient.start();
    if (bridgeResult.success) {
      outputChannel.appendLine(`[BRIDGE] Server started on port ${bridgeResult.port}`);
      outputChannel.appendLine(`[BRIDGE] Auth token: ${bridgeResult.authToken}`);
    } else {
      outputChannel.appendLine(`[BRIDGE] Failed to start: ${bridgeResult.error}`);
    }

    // Initialize Sync Controller (Task 2.3)
    syncController = new SyncController(configService, commentProcessor, outputChannel);
    context.subscriptions.push(syncController);

    // Connect bridge to sync controller
    syncController.setBridgeClient(bridgeClient);

    // Initialize Match Storage Service (Task 2.4)
    matchStorageService = new MatchStorageService(configService, outputChannel);
    context.subscriptions.push(matchStorageService);
    await matchStorageService.initialize();

    // Initialize Statistics Webview Provider (Task 2.5)
    statisticsProvider = new StatisticsWebviewProvider(
      context,
      matchStorageService,
      outputChannel
    );
    context.subscriptions.push(statisticsProvider);

    // Register webview provider
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        'codingameStatistics',
        statisticsProvider,
        {
          webviewOptions: {
            retainContextWhenHidden: true
          }
        }
      )
    );

    // Initialize Bridge Status Webview Provider
    bridgeStatusProvider = new BridgeStatusWebviewProvider(
      context,
      bridgeClient,
      outputChannel
    );
    context.subscriptions.push(bridgeStatusProvider);

    // Register bridge status webview provider
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        'codingameBridgeStatus',
        bridgeStatusProvider,
        {
          webviewOptions: {
            retainContextWhenHidden: true
          }
        }
      )
    );

    // Initialize Bridge Status Bar
    bridgeStatusBar = new BridgeStatusBar(bridgeClient);
    context.subscriptions.push(bridgeStatusBar);

    // Initialize Diagnostic Controller (Task 2.7)
    diagnosticController = new DiagnosticController(
      syncController,
      matchStorageService,
      bridgeClient,
      configService,
      outputChannel,
      context
    );
    context.subscriptions.push(diagnosticController);
    outputChannel.appendLine('[DIAGNOSTIC] Diagnostic controller initialized');

    // Setup bridge message handlers
    setupBridgeHandlers(bridgeClient, matchStorageService, syncController);

    // Register commands
    registerCommands(context);

    // Show activation success
    outputChannel.appendLine('[ACTIVATION] Extension activated successfully');

    // Optional: Show welcome message on first install
    const hasShownWelcome = context.globalState.get<boolean>('codingame.hasShownWelcome', false);
    if (!hasShownWelcome) {
      await showWelcomeMessage(context);
      await context.globalState.update('codingame.hasShownWelcome', true);
    }

    console.log('CodinGame extension activated successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[ACTIVATION] FAILED: ${message}`);
    vscode.window.showErrorMessage(`CodinGame extension activation failed: ${message}`);
    throw error;
  }
}

/**
 * Register all extension commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
  // Sync Code to Browser (Task 2.3)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.sync', async () => {
      try {
        if (!syncController) {
          throw new Error('Sync controller not initialized');
        }

        await syncController.syncCode();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Sync failed: ${message}`);
        vscode.window.showErrorMessage(`CodinGame: Sync failed - ${message}`);
      }
    })
  );

  // Toggle Strip Comments
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.toggleStripComments', async () => {
      try {
        if (!configService) {
          throw new Error('Configuration service not initialized');
        }

        const current = configService.getStripComments();
        await configService.updateConfig('sync.stripComments', !current);

        const newState = !current ? 'enabled' : 'disabled';
        outputChannel?.appendLine(`[COMMAND] Strip comments ${newState}`);
        vscode.window.showInformationMessage(`CodinGame: Comment stripping ${newState}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Toggle failed: ${message}`);
        vscode.window.showErrorMessage(`Failed to toggle strip comments: ${message}`);
      }
    })
  );

  // Resend Last Code Snapshot (Task 2.3 - related to Task 2.7)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.resendLast', async () => {
      try {
        if (!syncController) {
          throw new Error('Sync controller not initialized');
        }

        await syncController.resendLastSync();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Resend failed: ${message}`);
        vscode.window.showErrorMessage(`CodinGame: Resend failed - ${message}`);
      }
    })
  );

  // Show Statistics (Task 2.5)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.showStatistics', async () => {
      try {
        await vscode.commands.executeCommand('codingameStatistics.focus');
        outputChannel?.appendLine('[COMMAND] Statistics view opened');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Show statistics failed: ${message}`);
        vscode.window.showErrorMessage(`Failed to show statistics: ${message}`);
      }
    })
  );

  // Refresh Statistics
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.refreshStatistics', async () => {
      outputChannel?.appendLine('[COMMAND] Statistics refresh requested');
      vscode.window.showInformationMessage('Statistics will refresh automatically');
    })
  );

  // Export Statistics
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.exportStatistics', async () => {
      try {
        // The webview will handle the actual export
        await vscode.commands.executeCommand('codingameStatistics.focus');
        outputChannel?.appendLine('[COMMAND] Export statistics initiated');
        vscode.window.showInformationMessage('Click "Export CSV" in the Statistics view to export data');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Export statistics failed: ${message}`);
        vscode.window.showErrorMessage(`Failed to export statistics: ${message}`);
      }
    })
  );

  // Retry Failed Matches (Task 2.7)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.retryFailedMatches', async () => {
      try {
        if (!diagnosticController) {
          throw new Error('Diagnostic controller not initialized');
        }

        await diagnosticController.retryFailedMatches();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Retry failed matches error: ${message}`);
        vscode.window.showErrorMessage(`CodinGame: ${message}`);
      }
    })
  );

  // Resend Last Snapshot (Task 2.7 - enhanced version)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.resendLastSnapshot', async () => {
      try {
        if (!diagnosticController) {
          throw new Error('Diagnostic controller not initialized');
        }

        await diagnosticController.resendLastSnapshot();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Resend snapshot error: ${message}`);
        vscode.window.showErrorMessage(`CodinGame: ${message}`);
      }
    })
  );

  // Generate Diagnostic Report (Task 2.7)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.generateDiagnosticReport', async () => {
      try {
        if (!diagnosticController) {
          throw new Error('Diagnostic controller not initialized');
        }

        await diagnosticController.generateDiagnosticReport();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Generate report error: ${message}`);
        vscode.window.showErrorMessage(`CodinGame: Failed to generate report - ${message}`);
      }
    })
  );

  // Clear Cache (Task 2.7)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.clearCache', async () => {
      try {
        if (!diagnosticController) {
          throw new Error('Diagnostic controller not initialized');
        }

        await diagnosticController.clearCache();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Clear cache error: ${message}`);
        vscode.window.showErrorMessage(`CodinGame: ${message}`);
      }
    })
  );

  // Open Logs (Task 2.6)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.openLogs', () => {
      outputChannel?.show();
      outputChannel?.appendLine('[COMMAND] Logs opened by user');
    })
  );

  // Show Bridge Status (Task 2.6)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.showBridgeStatus', async () => {
      if (!bridgeClient) {
        vscode.window.showWarningMessage('CodinGame: Bridge client not initialized');
        return;
      }

      const stats = bridgeClient.getStats();
      const items: vscode.QuickPickItem[] = [
        {
          label: '$(info) Connection Status',
          detail: `State: ${stats.connectionState}`
        },
        {
          label: '$(pulse) Heartbeat',
          detail: `Last: ${new Date(stats.lastHeartbeatTime).toLocaleTimeString()}, Latency: ${stats.lastHeartbeatLatency}ms`
        },
        {
          label: '$(graph) Statistics',
          detail: `Sent: ${stats.messagesSent}, Received: ${stats.messagesReceived}, Queued: ${stats.queueSize}`
        },
        {
          label: '$(clock) Uptime',
          detail: `${Math.floor(stats.uptime / 1000)}s`
        },
        {
          label: '$(notebook) Open Logs',
          description: 'View detailed logs'
        },
        {
          label: '$(export) Export Logs',
          description: 'Save logs to file'
        }
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'CodinGame Bridge Status'
      });

      if (selected?.label.includes('Open Logs')) {
        outputChannel?.show();
      } else if (selected?.label.includes('Export Logs')) {
        await bridgeClient.exportLogs();
      }
    })
  );

  // Export Bridge Logs (Task 2.6)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.exportBridgeLogs', async () => {
      if (!bridgeClient) {
        vscode.window.showWarningMessage('CodinGame: Bridge client not initialized');
        return;
      }

      try {
        await bridgeClient.exportLogs();
        outputChannel?.appendLine('[COMMAND] Bridge logs exported');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Export logs failed: ${message}`);
        vscode.window.showErrorMessage(`Failed to export logs: ${message}`);
      }
    })
  );

  // Force Refresh Bridge Status Webview
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.refreshBridgeStatusView', () => {
      if (!bridgeStatusProvider) {
        vscode.window.showWarningMessage('CodinGame: Bridge Status provider not initialized');
        return;
      }

      bridgeStatusProvider.forceRefresh();
      outputChannel?.appendLine('[COMMAND] Bridge Status webview force refreshed');
    })
  );

  // Configure Storage Directory
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.configureStorageDir', async () => {
      try {
        if (!configService) {
          throw new Error('Configuration service not initialized');
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: workspaceFolder?.uri,
          openLabel: 'Select Matches Directory',
          title: 'CodinGame: Choose Matches Storage Directory'
        });

        if (selected && selected[0]) {
          const relativePath = workspaceFolder
            ? vscode.workspace.asRelativePath(selected[0])
            : selected[0].fsPath;

          await configService.updateConfig('matches.directory', relativePath);

          outputChannel?.appendLine(`[COMMAND] Storage directory configured: ${relativePath}`);
          vscode.window.showInformationMessage(`CodinGame: Matches directory set to ${relativePath}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[COMMAND] Configure directory failed: ${message}`);
        vscode.window.showErrorMessage(`Failed to configure directory: ${message}`);
      }
    })
  );

  // Test Comment Stripping (Demo command for Task 2.2)
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.testCommentStripping', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('CodinGame: No active editor');
          return;
        }

        if (!commentProcessor) {
          throw new Error('Comment processor not initialized');
        }

        const code = editor.document.getText();
        const languageId = editor.document.languageId;

        outputChannel?.appendLine(`[TEST] Processing ${languageId} code...`);
        const result = await commentProcessor.processCode(code, languageId);

        if (result.error) {
          vscode.window.showErrorMessage(`Comment stripping failed: ${result.error}`);
          return;
        }

        const stats = commentProcessor.getStats(code, result.code);

        outputChannel?.appendLine(`[TEST] Strategy: ${result.strategy}`);
        outputChannel?.appendLine(`[TEST] Stripped: ${result.stripped}`);
        outputChannel?.appendLine(`[TEST] Lines: ${stats.originalLines} → ${stats.processedLines}`);
        outputChannel?.appendLine(`[TEST] Size: ${stats.originalSize} → ${stats.processedSize} bytes`);
        outputChannel?.appendLine(`[TEST] Reduction: ${stats.reductionPercent}%`);

        // Show result in new document
        const doc = await vscode.workspace.openTextDocument({
          content: result.code,
          language: languageId
        });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

        vscode.window.showInformationMessage(
          `Comments processed with ${result.strategy} strategy. Reduced by ${stats.reductionPercent}%`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[TEST] Failed: ${message}`);
        vscode.window.showErrorMessage(`Test failed: ${message}`);
      }
    })
  );

  outputChannel?.appendLine('[ACTIVATION] Commands registered');
}

/**
 * Setup bridge message handlers
 * Task 2.6: Route incoming messages to appropriate services
 */
function setupBridgeHandlers(
  bridge: BridgeClient,
  matchStorage: MatchStorageService,
  _sync: SyncController
): void {
  // Handle incoming messages
  bridge.onMessage(async (message) => {
    try {
      switch (message.type) {
        case 'match_data':
          // Forward to match storage service
          await handleMatchData(bridge, matchStorage, message);
          break;

        case 'sync_status':
          // Already logged by bridge, just emit for sync controller if needed
          outputChannel?.appendLine(`[SYNC] Sync status: ${message.payload.status}`);
          break;

        default:
          outputChannel?.appendLine(`[BRIDGE] Unhandled message type: ${message.type}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      outputChannel?.appendLine(`[BRIDGE] Message handling error: ${msg}`);
    }
  });

  // Handle connection state changes
  bridge.onConnectionChange((state) => {
    outputChannel?.appendLine(`[BRIDGE] Connection state changed: ${state}`);

    if (state === 'authenticated') {
      // Broadcast current settings to Chrome
      const stripComments = configService?.getStripComments() || false;
      bridge.broadcastSettingsUpdate('sync.stripComments', stripComments);
    }
  });

  // Handle errors
  bridge.onError((error) => {
    outputChannel?.appendLine(`[BRIDGE] Error: ${error.type} - ${error.message}`);

    if (!error.recoverable) {
      vscode.window.showErrorMessage(`CodinGame Bridge Error: ${error.message}`);
    }
  });

  // Watch for configuration changes and broadcast to Chrome
  configService?.onConfigChange(async (event) => {
    if (event.key.startsWith('codingame.sync.')) {
      await bridge.broadcastSettingsUpdate(event.key, event.newValue);
    }
  });
}

/**
 * Handle incoming match data
 */
async function handleMatchData(
  bridge: BridgeClient,
  matchStorage: MatchStorageService,
  message: any
): Promise<void> {
  const deliveryId = message.payload?.deliveryId;

  try {
    outputChannel?.appendLine(`[MATCH] Processing match data (delivery: ${deliveryId})`);

    // Store match
    const result = await matchStorage.storeMatchData(message.payload);

    // Send acknowledgment
    await bridge.send({
      type: 'match_data_ack',
      requestId: message.requestId,
      payload: {
        deliveryId,
        success: result.success,
        matchId: result.matchId,
        reason: result.reason,
        timestamp: Date.now()
      },
      version: '1.0.0'
    });

    if (result.success) {
      outputChannel?.appendLine(`[MATCH] Match stored and acknowledged: ${result.matchId}`);
    } else {
      outputChannel?.appendLine(`[MATCH] Match storage failed: ${result.reason}`);
    }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    outputChannel?.appendLine(`[MATCH] Error handling match data: ${msg}`);

    // Send failure acknowledgment
    await bridge.send({
      type: 'match_data_ack',
      requestId: message.requestId,
      payload: {
        deliveryId,
        success: false,
        error: msg,
        timestamp: Date.now()
      },
      version: '1.0.0'
    });
  }
}

/**
 * Show welcome message on first activation
 */
async function showWelcomeMessage(_context: vscode.ExtensionContext): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    'Welcome to CodinGame VS Code Extension! This extension helps you sync code to the CodinGame browser and track match results.',
    'Show Documentation',
    'Open Settings'
  );

  if (action === 'Show Documentation') {
    vscode.env.openExternal(vscode.Uri.parse('https://github.com/codingame/vscode-extension#readme'));
  } else if (action === 'Open Settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'codingame');
  }
}

/**
 * Extension deactivation
 * Called when extension is deactivated
 */
export function deactivate() {
  outputChannel?.appendLine('[DEACTIVATION] Extension deactivating...');

  // Cleanup is handled by disposables
  configService = undefined;
  commentProcessor = undefined;
  syncController = undefined;
  matchStorageService = undefined;
  statisticsProvider = undefined;
  bridgeClient = undefined;
  bridgeStatusBar = undefined;
  outputChannel = undefined;

  console.log('CodinGame extension deactivated');
}
