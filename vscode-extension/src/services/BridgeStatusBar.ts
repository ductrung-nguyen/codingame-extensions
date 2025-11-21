/**
 * BridgeStatusBar
 * Task 2.6: Bridge Resilience & Logging
 *
 * Provides visual status indicator in VS Code status bar showing bridge connection state.
 */

import * as vscode from 'vscode';
import { BridgeClient } from './BridgeClient';
import { ConnectionState } from '../models/BridgeTypes';

/**
 * Status bar item for bridge connection status
 */
export class BridgeStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private bridgeClient: BridgeClient;
  private disposables: vscode.Disposable[] = [];

  constructor(bridgeClient: BridgeClient) {
    this.bridgeClient = bridgeClient;

    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );

    this.statusBarItem.command = 'codingame.showBridgeStatus';
    this.statusBarItem.show();

    // Initialize with current state
    this.update(bridgeClient.getConnectionState());

    // Listen to connection state changes
    this.disposables.push(
      bridgeClient.onConnectionChange((state) => {
        this.update(state);
      })
    );
  }

  /**
   * Update status bar based on connection state
   */
  private update(state: ConnectionState): void {
    switch (state) {
      case 'disconnected':
        this.statusBarItem.text = '$(debug-disconnect) CodinGame';
        this.statusBarItem.tooltip = 'CodinGame: Chrome extension disconnected\nClick for details';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        break;

      case 'listening':
        this.statusBarItem.text = '$(radio-tower) CodinGame';
        this.statusBarItem.tooltip = 'CodinGame: Waiting for Chrome extension...\nClick for details';
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'connecting':
      case 'connected':
        this.statusBarItem.text = '$(sync~spin) CodinGame';
        this.statusBarItem.tooltip = 'CodinGame: Connecting to Chrome extension...\nClick for details';
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'authenticated':
        this.statusBarItem.text = '$(check) CodinGame';
        this.statusBarItem.tooltip = this.buildAuthenticatedTooltip();
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.prominentBackground'
        );
        break;
    }
  }

  /**
   * Build detailed tooltip for authenticated state
   */
  private buildAuthenticatedTooltip(): string {
    const stats = this.bridgeClient.getStats();
    const lines = ['CodinGame: Connected to Chrome extension'];

    // Connection uptime
    if (stats.uptime > 0) {
      const uptimeSeconds = Math.floor(stats.uptime / 1000);
      const minutes = Math.floor(uptimeSeconds / 60);
      const seconds = uptimeSeconds % 60;

      if (minutes > 0) {
        lines.push(`Uptime: ${minutes}m ${seconds}s`);
      } else {
        lines.push(`Uptime: ${seconds}s`);
      }
    }

    // Last heartbeat
    if (stats.lastHeartbeatTime > 0) {
      const elapsed = Math.floor((Date.now() - stats.lastHeartbeatTime) / 1000);
      lines.push(`Last heartbeat: ${elapsed}s ago`);

      if (stats.lastHeartbeatLatency > 0) {
        lines.push(`Latency: ${stats.lastHeartbeatLatency}ms`);
      }
    }

    // Message statistics
    lines.push(`Messages: ${stats.messagesSent} sent, ${stats.messagesReceived} received`);

    // Queue size
    if (stats.queueSize > 0) {
      lines.push(`Queued messages: ${stats.queueSize}`);
    }

    lines.push('', 'Click for details');

    return lines.join('\n');
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
