/**
 * Match Commands
 *
 * Command handlers for match data operations including rebuild index,
 * reprocess matches, clear all matches, and show match file.
 *
 * Task 2.4: Match Data Storage
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { MatchStorageService } from '../services/MatchStorageService';

/**
 * Register all match-related commands
 */
export function registerMatchCommands(
  context: vscode.ExtensionContext,
  matchStorageService: MatchStorageService
): void {
  // Rebuild match index
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.rebuildIndex', async () => {
      await rebuildIndexCommand(matchStorageService);
    })
  );

  // Reprocess matches
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.reprocessMatches', async () => {
      await reprocessMatchesCommand(matchStorageService);
    })
  );

  // Clear all matches
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.clearMatches', async () => {
      await clearMatchesCommand(matchStorageService);
    })
  );

  // Show match file
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.showMatchFile', async (matchId?: string) => {
      await showMatchFileCommand(matchStorageService, matchId);
    })
  );

  // Validate integrity
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.validateMatchIntegrity', async () => {
      await validateIntegrityCommand(matchStorageService);
    })
  );

  // Apply rotation manually
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.applyRotation', async () => {
      await applyRotationCommand(matchStorageService);
    })
  );

  // Export index
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.exportMatchIndex', async () => {
      await exportIndexCommand(matchStorageService);
    })
  );

  // Show match statistics
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.showMatchStats', async () => {
      await showMatchStatsCommand(matchStorageService);
    })
  );

  // Delete match
  context.subscriptions.push(
    vscode.commands.registerCommand('codingame.deleteMatch', async (matchId?: string) => {
      await deleteMatchCommand(matchStorageService, matchId);
    })
  );
}

/**
 * Rebuild match index from filesystem
 */
async function rebuildIndexCommand(matchStorageService: MatchStorageService): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Rebuilding match index...',
      cancellable: false
    },
    async () => {
      try {
        await matchStorageService.rebuildIndex();

        const stats = matchStorageService.getStatistics();
        vscode.window.showInformationMessage(
          `Index rebuilt: ${stats.totalMatches} matches (${stats.winCount}W/${stats.loseCount}L/${stats.drawCount}D)`
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to rebuild index: ${(error as Error).message}`
        );
      }
    }
  );
}

/**
 * Reprocess all matches
 */
async function reprocessMatchesCommand(matchStorageService: MatchStorageService): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'Reprocess all matches? This will re-validate and update the index.',
    'Reprocess All',
    'Cancel'
  );

  if (choice !== 'Reprocess All') {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Reprocessing matches...',
      cancellable: false
    },
    async () => {
      try {
        const result = await matchStorageService.reprocessMatches();

        if (result.errors > 0) {
          const viewErrors = await vscode.window.showWarningMessage(
            `Reprocessed ${result.processed} matches with ${result.errors} errors`,
            'View Errors'
          );

          if (viewErrors === 'View Errors') {
            showReprocessErrors(result.errorDetails);
          }
        } else {
          vscode.window.showInformationMessage(
            `Successfully reprocessed ${result.processed} matches`
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to reprocess matches: ${(error as Error).message}`
        );
      }
    }
  );
}

/**
 * Clear all matches
 */
async function clearMatchesCommand(matchStorageService: MatchStorageService): Promise<void> {
  const matchCount = matchStorageService.getMatchCount();

  if (matchCount === 0) {
    vscode.window.showInformationMessage('No matches to clear');
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `Delete all ${matchCount} stored matches? This cannot be undone.`,
    { modal: true },
    'Delete All'
  );

  if (choice !== 'Delete All') {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Clearing matches...',
      cancellable: false
    },
    async () => {
      try {
        const deleted = await matchStorageService.clearAll();
        vscode.window.showInformationMessage(`Deleted ${deleted} matches`);
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to clear matches: ${(error as Error).message}`
        );
      }
    }
  );
}

/**
 * Show match file in editor
 */
async function showMatchFileCommand(
  matchStorageService: MatchStorageService,
  matchId?: string
): Promise<void> {
  let targetMatchId = matchId;

  // If no matchId provided, let user pick
  if (!targetMatchId) {
    const matches = await matchStorageService.getAllMatches();

    if (matches.length === 0) {
      vscode.window.showInformationMessage('No matches stored');
      return;
    }

    const items = matches
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 50) // Limit to most recent 50
      .map(m => ({
        label: `${m.result} - ${m.matchId}`,
        description: `${m.arena ? 'Arena' : 'Solo'} - ${new Date(m.timestamp).toLocaleString()}`,
        detail: m.opponent ? `vs ${m.opponent}` : undefined,
        matchId: m.matchId
      }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a match to open'
    });

    if (!selected) {
      return;
    }

    targetMatchId = selected.matchId;
  }

  // Get match record
  const record = await matchStorageService.getMatch(targetMatchId);
  if (!record) {
    vscode.window.showErrorMessage(`Match not found: ${targetMatchId}`);
    return;
  }

  // Open file
  const uri = vscode.Uri.file(record.filepath);
  await vscode.commands.executeCommand('vscode.open', uri);
}

/**
 * Validate storage integrity
 */
async function validateIntegrityCommand(matchStorageService: MatchStorageService): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Validating storage integrity...',
      cancellable: false
    },
    async () => {
      try {
        const report = await matchStorageService.validateIntegrity();

        const issues =
          report.corruptedFiles.length +
          report.missingFromIndex.length +
          report.orphanedInIndex.length;

        if (issues === 0) {
          vscode.window.showInformationMessage(
            `Storage integrity OK: ${report.validFiles}/${report.totalFiles} files valid`
          );
        } else {
          const viewReport = await vscode.window.showWarningMessage(
            `Found ${issues} integrity issues`,
            'View Report'
          );

          if (viewReport === 'View Report') {
            showIntegrityReport(report);
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Integrity check failed: ${(error as Error).message}`
        );
      }
    }
  );
}

/**
 * Apply rotation policy manually
 */
async function applyRotationCommand(matchStorageService: MatchStorageService): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Apply rotation policy? Old matches may be deleted.',
    'Apply',
    'Cancel'
  );

  if (choice !== 'Apply') {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Applying rotation policy...',
      cancellable: false
    },
    async () => {
      try {
        const deleted = await matchStorageService.applyRotationPolicy();

        if (deleted > 0) {
          vscode.window.showInformationMessage(`Rotation complete: deleted ${deleted} matches`);
        } else {
          vscode.window.showInformationMessage('No matches deleted (under policy limits)');
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Rotation failed: ${(error as Error).message}`
        );
      }
    }
  );
}

/**
 * Export index to file
 */
async function exportIndexCommand(matchStorageService: MatchStorageService): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file('match-index.json'),
    filters: {
      'JSON': ['json']
    }
  });

  if (!uri) {
    return;
  }

  try {
    await matchStorageService.exportIndex(uri.fsPath);
    vscode.window.showInformationMessage(`Index exported to ${path.basename(uri.fsPath)}`);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Export failed: ${(error as Error).message}`
    );
  }
}

/**
 * Show match statistics in quick pick
 */
async function showMatchStatsCommand(matchStorageService: MatchStorageService): Promise<void> {
  const stats = matchStorageService.getStatistics();

  const items = [
    {
      label: '📊 Total Matches',
      description: stats.totalMatches.toString()
    },
    {
      label: '🏆 Wins',
      description: `${stats.winCount} (${stats.winRate.toFixed(1)}%)`
    },
    {
      label: '❌ Losses',
      description: stats.loseCount.toString()
    },
    {
      label: '🤝 Draws',
      description: stats.drawCount.toString()
    },
    {
      label: '1️⃣ First Player',
      description: stats.firstPlayerCount.toString()
    },
    {
      label: '2️⃣ Second Player',
      description: stats.secondPlayerCount.toString()
    },
    {
      label: '⚔️ Arena Matches',
      description: stats.arenaCount.toString()
    },
    {
      label: '🎯 Solo Matches',
      description: stats.soloCount.toString()
    }
  ];

  if (stats.oldestMatch) {
    items.push({
      label: '📅 Oldest Match',
      description: new Date(stats.oldestMatch).toLocaleString()
    });
  }

  if (stats.newestMatch) {
    items.push({
      label: '🆕 Newest Match',
      description: new Date(stats.newestMatch).toLocaleString()
    });
  }

  await vscode.window.showQuickPick(items, {
    placeHolder: 'Match Statistics',
    title: 'CodinGame Match Statistics'
  });
}

/**
 * Delete a specific match
 */
async function deleteMatchCommand(
  matchStorageService: MatchStorageService,
  matchId?: string
): Promise<void> {
  let targetMatchId = matchId;

  if (!targetMatchId) {
    // Let user pick a match
    const matches = await matchStorageService.getAllMatches();

    if (matches.length === 0) {
      vscode.window.showInformationMessage('No matches to delete');
      return;
    }

    const items = matches
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .map(m => ({
        label: `${m.result} - ${m.matchId}`,
        description: new Date(m.timestamp).toLocaleString(),
        matchId: m.matchId
      }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a match to delete'
    });

    if (!selected) {
      return;
    }

    targetMatchId = selected.matchId;
  }

  const choice = await vscode.window.showWarningMessage(
    `Delete match ${targetMatchId}?`,
    'Delete',
    'Cancel'
  );

  if (choice !== 'Delete') {
    return;
  }

  const success = await matchStorageService.deleteMatch(targetMatchId);

  if (success) {
    vscode.window.showInformationMessage(`Deleted match ${targetMatchId}`);
  } else {
    vscode.window.showErrorMessage(`Failed to delete match ${targetMatchId}`);
  }
}

/**
 * Show reprocess errors in output channel
 */
function showReprocessErrors(errors: Array<{ matchId: string; error: string }>): void {
  const channel = vscode.window.createOutputChannel('CodinGame Match Errors');
  channel.clear();
  channel.appendLine('=== Reprocess Errors ===\n');

  for (const { matchId, error } of errors) {
    channel.appendLine(`Match ID: ${matchId}`);
    channel.appendLine(`Error: ${error}`);
    channel.appendLine('');
  }

  channel.show();
}

/**
 * Show integrity report in output channel
 */
function showIntegrityReport(report: any): void {
  const channel = vscode.window.createOutputChannel('CodinGame Integrity Report');
  channel.clear();
  channel.appendLine('=== Storage Integrity Report ===\n');
  channel.appendLine(`Timestamp: ${report.timestamp}`);
  channel.appendLine(`Total Files: ${report.totalFiles}`);
  channel.appendLine(`Valid Files: ${report.validFiles}`);
  channel.appendLine('');

  if (report.corruptedFiles.length > 0) {
    channel.appendLine('Corrupted Files:');
    report.corruptedFiles.forEach((f: string) => channel.appendLine(`  - ${f}`));
    channel.appendLine('');
  }

  if (report.missingFromIndex.length > 0) {
    channel.appendLine('Missing from Index:');
    report.missingFromIndex.forEach((f: string) => channel.appendLine(`  - ${f}`));
    channel.appendLine('');
  }

  if (report.orphanedInIndex.length > 0) {
    channel.appendLine('Orphaned in Index (file not found):');
    report.orphanedInIndex.forEach((id: string) => channel.appendLine(`  - ${id}`));
    channel.appendLine('');
  }

  channel.show();
}
