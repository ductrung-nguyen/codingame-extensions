/**
 * E2ETestHelpers.ts
 *
 * Helper utilities for end-to-end testing of the sync-to-match cycle.
 * Provides mocking, verification, and utility functions for E2E tests.
 *
 * Part of Task 3.1: Full Sync-to-Match Cycle
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * Mock Bridge Client for testing
 */
export class MockBridgeClient {
  private connected: boolean = false;
  private messageHandlers: Array<(message: any) => void> = [];
  private sentMessages: any[] = [];
  private receivedMessages: any[] = [];
  private latency: number = 100;

  constructor(private simulateLatency: boolean = true) { }

  public async start(): Promise<void> {
    this.connected = true;
    await this.delay(this.latency);
  }

  public async stop(): Promise<void> {
    this.connected = false;
    await this.delay(this.latency);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async send(message: any): Promise<void> {
    if (!this.connected) {
      throw new Error('Bridge not connected');
    }

    this.sentMessages.push({
      ...message,
      timestamp: Date.now()
    });

    if (this.simulateLatency) {
      await this.delay(this.latency);
    }

    // Auto-respond to certain message types
    if (message.type === 'sync_code') {
      await this.simulateSyncResponse(message);
    }
  }

  public onMessage(handler: (message: any) => void): void {
    this.messageHandlers.push(handler);
  }

  public simulateReceive(message: any): void {
    this.receivedMessages.push({
      ...message,
      timestamp: Date.now()
    });

    this.messageHandlers.forEach(handler => handler(message));
  }

  public getSentMessages(): any[] {
    return this.sentMessages;
  }

  public getReceivedMessages(): any[] {
    return this.receivedMessages;
  }

  public clearMessages(): void {
    this.sentMessages = [];
    this.receivedMessages = [];
  }

  public setLatency(ms: number): void {
    this.latency = ms;
  }

  public simulateDisconnect(): void {
    this.connected = false;
    this.messageHandlers.forEach(handler => {
      handler({
        type: 'bridge_disconnected',
        timestamp: new Date().toISOString()
      });
    });
  }

  public async simulateReconnect(): Promise<void> {
    await this.delay(1000);
    this.connected = true;
    this.messageHandlers.forEach(handler => {
      handler({
        type: 'bridge_connected',
        timestamp: new Date().toISOString()
      });
    });
  }

  private async simulateSyncResponse(syncMessage: any): Promise<void> {
    await this.delay(this.latency * 2);

    const response = {
      type: 'sync_status',
      requestId: syncMessage.requestId,
      payload: {
        status: 'success',
        timestamp: new Date().toISOString(),
        duration: this.latency * 2,
        changed: true
      },
      version: '1.0.0'
    };

    this.simulateReceive(response);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Data integrity verification utilities
 */
export class DataIntegrityVerifier {
  /**
   * Verify code integrity using hash comparison
   */
  public static verifyCodeIntegrity(original: string, received: string): CodeIntegrityResult {
    const originalHash = this.computeHash(original);
    const receivedHash = this.computeHash(received);

    return {
      originalCode: original,
      receivedCode: received,
      originalHash,
      receivedHash,
      hashMatch: originalHash === receivedHash,
      sizeMatch: original.length === received.length,
      lineCountMatch: this.countLines(original) === this.countLines(received),
      byteSize: Buffer.byteLength(original, 'utf8'),
      integrityScore: this.calculateCodeIntegrityScore(original, received)
    };
  }

  /**
   * Verify match payload integrity
   */
  public static verifyMatchIntegrity(
    captured: any,
    stored: any
  ): MatchIntegrityResult {
    const criticalFieldsMatch =
      captured.match_id === stored.match_id &&
      captured.result === stored.result &&
      captured.order === stored.order;

    const timestampValid = this.isValidTimestamp(stored.timestamp);
    const logsPresent =
      stored.logs &&
      typeof stored.logs.stdout === 'string';

    const schemaValid = this.validateMatchSchema(stored);

    return {
      capturedPayload: captured,
      storedPayload: stored,
      criticalFieldsMatch,
      timestampValid,
      logsPresent,
      schemaValid,
      allFieldsPresent: this.checkAllFields(stored),
      integrityScore: this.calculateMatchIntegrityScore({
        criticalFieldsMatch,
        timestampValid,
        logsPresent,
        schemaValid
      })
    };
  }

  /**
   * Compute SHA-256 hash of string
   */
  private static computeHash(data: string): string {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
  }

  /**
   * Count lines in string
   */
  private static countLines(text: string): number {
    return text.split('\n').length;
  }

  /**
   * Calculate code integrity score (0-100)
   */
  private static calculateCodeIntegrityScore(original: string, received: string): number {
    let score = 0;

    // Hash match: 40 points
    if (this.computeHash(original) === this.computeHash(received)) {
      score += 40;
    }

    // Size match: 30 points
    if (original.length === received.length) {
      score += 30;
    } else {
      // Partial credit for close sizes
      const sizeDiff = Math.abs(original.length - received.length);
      const sizeRatio = 1 - (sizeDiff / Math.max(original.length, received.length));
      score += Math.round(sizeRatio * 30);
    }

    // Line count match: 20 points
    if (this.countLines(original) === this.countLines(received)) {
      score += 20;
    }

    // No control characters: 10 points
    if (!/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/.test(received)) {
      score += 10;
    }

    return score;
  }

  /**
   * Calculate match integrity score (0-100)
   */
  private static calculateMatchIntegrityScore(checks: {
    criticalFieldsMatch: boolean;
    timestampValid: boolean;
    logsPresent: boolean;
    schemaValid: boolean;
  }): number {
    let score = 0;

    if (checks.criticalFieldsMatch) score += 40;
    if (checks.timestampValid) score += 20;
    if (checks.logsPresent) score += 20;
    if (checks.schemaValid) score += 20;

    return score;
  }

  /**
   * Validate timestamp
   */
  private static isValidTimestamp(timestamp: string): boolean {
    try {
      const date = new Date(timestamp);
      return !isNaN(date.getTime()) && date.getTime() > 0;
    } catch {
      return false;
    }
  }

  /**
   * Validate match schema
   */
  private static validateMatchSchema(match: any): boolean {
    const requiredFields = [
      'match_id',
      'result',
      'order',
      'timestamp',
      'logs'
    ];

    return requiredFields.every(field => field in match);
  }

  /**
   * Check all expected fields are present
   */
  private static checkAllFields(match: any): string[] {
    const expectedFields = [
      'match_id',
      'result',
      'order',
      'arena',
      'timestamp',
      'opponent',
      'league',
      'durationMs',
      'logs'
    ];

    return expectedFields.filter(field => field in match);
  }
}

/**
 * Performance measurement utilities
 */
export class PerformanceMonitor {
  private measurements: Map<string, number[]> = new Map();

  /**
   * Start measuring an operation
   */
  public start(operationName: string): () => void {
    const startTime = performance.now();

    return () => {
      const duration = performance.now() - startTime;
      this.record(operationName, duration);
    };
  }

  /**
   * Record a measurement
   */
  public record(operationName: string, duration: number): void {
    if (!this.measurements.has(operationName)) {
      this.measurements.set(operationName, []);
    }
    this.measurements.get(operationName)!.push(duration);
  }

  /**
   * Get statistics for an operation
   */
  public getStats(operationName: string): PerformanceStats | null {
    const measurements = this.measurements.get(operationName);
    if (!measurements || measurements.length === 0) {
      return null;
    }

    const sorted = [...measurements].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const mean = sum / sorted.length;

    const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / sorted.length;
    const stdDev = Math.sqrt(variance);

    return {
      operationName,
      count: sorted.length,
      mean,
      median: sorted[Math.floor(sorted.length / 2)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      stdDev,
      total: sum
    };
  }

  /**
   * Get all statistics
   */
  public getAllStats(): PerformanceStats[] {
    const stats: PerformanceStats[] = [];
    for (const operationName of this.measurements.keys()) {
      const stat = this.getStats(operationName);
      if (stat) {
        stats.push(stat);
      }
    }
    return stats;
  }

  /**
   * Clear all measurements
   */
  public clear(): void {
    this.measurements.clear();
  }

  /**
   * Generate performance report
   */
  public generateReport(): string {
    const stats = this.getAllStats();
    if (stats.length === 0) {
      return 'No performance data collected';
    }

    let report = '=== Performance Report ===\n\n';

    for (const stat of stats) {
      report += `Operation: ${stat.operationName}\n`;
      report += `  Count: ${stat.count}\n`;
      report += `  Mean: ${stat.mean.toFixed(2)}ms\n`;
      report += `  Median: ${stat.median.toFixed(2)}ms\n`;
      report += `  Min: ${stat.min.toFixed(2)}ms\n`;
      report += `  Max: ${stat.max.toFixed(2)}ms\n`;
      report += `  P95: ${stat.p95.toFixed(2)}ms\n`;
      report += `  P99: ${stat.p99.toFixed(2)}ms\n`;
      report += `  Std Dev: ${stat.stdDev.toFixed(2)}ms\n`;
      report += `  Total: ${stat.total.toFixed(2)}ms\n\n`;
    }

    return report;
  }
}

/**
 * Test fixture factory
 */
export class TestFixtureFactory {
  /**
   * Create test match payload
   */
  public static createMatchPayload(overrides?: Partial<any>): any {
    const timestamp = Date.now();
    return {
      deliveryId: `test-delivery-${timestamp}`,
      match_id: `test-match-${timestamp}`,
      result: 'WIN',
      order: 0,
      arena: false,
      timestamp: new Date().toISOString(),
      opponent: 'TestBot',
      league: 'Wood 1',
      durationMs: 5000,
      logs: {
        stdout: 'Test output',
        stderr: ''
      },
      metadata: {
        gameType: 'solo',
        puzzle: 'test-puzzle'
      },
      ...overrides
    };
  }

  /**
   * Create test sync payload
   */
  public static createSyncPayload(code: string, overrides?: Partial<any>): any {
    return {
      type: 'sync_code',
      requestId: `sync-${Date.now()}`,
      timestamp: new Date().toISOString(),
      payload: {
        language: 'Python3',
        code,
        stripComments: false,
        strategy: 'auto',
        fileName: 'test-bot.py',
        originalSize: code.length,
        processedSize: code.length,
        ...overrides
      },
      version: '1.0.0'
    };
  }

  /**
   * Create test code samples
   */
  public static createTestCode(language: string = 'python'): string {
    const templates: Record<string, string> = {
      python: `# Test bot
import sys

def main():
    while True:
        x, y = [int(i) for i in input().split()]
        print("MOVE", x, y)

if __name__ == "__main__":
    main()
`,
      javascript: `// Test bot
function main() {
  while (true) {
    const inputs = readline().split(' ');
    const x = parseInt(inputs[0]);
    const y = parseInt(inputs[1]);
    console.log('MOVE', x, y);
  }
}
main();
`,
      java: `// Test bot
import java.util.*;

class Player {
    public static void main(String args[]) {
        Scanner in = new Scanner(System.in);
        while (true) {
            int x = in.nextInt();
            int y = in.nextInt();
            System.out.println("MOVE " + x + " " + y);
        }
    }
}
`
    };

    return templates[language] || templates.python;
  }
}

/**
 * Async utilities for testing
 */
export class AsyncTestUtils {
  /**
   * Wait for condition to be true
   */
  public static async waitFor(
    condition: () => boolean | Promise<boolean>,
    options: {
      timeout?: number;
      interval?: number;
      timeoutMessage?: string;
    } = {}
  ): Promise<void> {
    const timeout = options.timeout || 5000;
    const interval = options.interval || 100;
    const timeoutMessage = options.timeoutMessage || 'Condition timeout';

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const result = await Promise.resolve(condition());
      if (result) {
        return;
      }
      await this.delay(interval);
    }

    throw new Error(timeoutMessage);
  }

  /**
   * Wait for event to be emitted
   */
  public static async waitForEvent<T>(
    emitter: vscode.EventEmitter<T>,
    timeout: number = 5000
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        disposable.dispose();
        reject(new Error('Event timeout'));
      }, timeout);

      const disposable = emitter.event((data: T) => {
        clearTimeout(timer);
        disposable.dispose();
        resolve(data);
      });
    });
  }

  /**
   * Delay for specified milliseconds
   */
  public static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Retry operation with exponential backoff
   */
  public static async retry<T>(
    operation: () => Promise<T>,
    options: {
      maxAttempts?: number;
      initialDelay?: number;
      maxDelay?: number;
      factor?: number;
    } = {}
  ): Promise<T> {
    const maxAttempts = options.maxAttempts || 3;
    const initialDelay = options.initialDelay || 100;
    const maxDelay = options.maxDelay || 5000;
    const factor = options.factor || 2;

    let lastError: Error | undefined;
    let delay = initialDelay;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt === maxAttempts) {
          break;
        }

        await this.delay(delay);
        delay = Math.min(delay * factor, maxDelay);
      }
    }

    throw lastError || new Error('Retry failed');
  }
}

/**
 * Mock file system for testing
 */
export class MockFileSystem {
  private files: Map<string, string> = new Map();

  public async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  public async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  public async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  public async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  public clear(): void {
    this.files.clear();
  }

  public getFiles(): string[] {
    return Array.from(this.files.keys());
  }
}

/**
 * Type definitions
 */
export interface CodeIntegrityResult {
  originalCode: string;
  receivedCode: string;
  originalHash: string;
  receivedHash: string;
  hashMatch: boolean;
  sizeMatch: boolean;
  lineCountMatch: boolean;
  byteSize: number;
  integrityScore: number;
}

export interface MatchIntegrityResult {
  capturedPayload: any;
  storedPayload: any;
  criticalFieldsMatch: boolean;
  timestampValid: boolean;
  logsPresent: boolean;
  schemaValid: boolean;
  allFieldsPresent: string[];
  integrityScore: number;
}

export interface PerformanceStats {
  operationName: string;
  count: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  p95: number;
  p99: number;
  stdDev: number;
  total: number;
}
