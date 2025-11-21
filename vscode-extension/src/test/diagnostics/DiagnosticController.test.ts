/**
 * Unit Tests for DiagnosticController
 *
 * Simplified tests for diagnostic and recovery operations
 * Task 2.7: Diagnostic & Recovery Commands
 */

import * as assert from 'assert';
import { DiagnosticController } from '../../diagnostics/DiagnosticController';

suite('DiagnosticController Test Suite', () => {
  let controller: DiagnosticController;
  let mockSyncController: any;
  let mockMatchStorage: any;
  let mockBridgeClient: any;
  let mockConfigService: any;
  let mockOutputChannel: any;
  let mockContext: any;

  setup(() => {
    // Create mock output channel
    mockOutputChannel = {
      appendLine: () => { },
      show: () => { },
      dispose: () => { }
    };

    // Create mock sync controller
    mockSyncController = {
      getLastSyncPayload: () => undefined,
      getLastSyncTime: () => undefined,
      getLastSyncResult: () => undefined,
      clearCache: () => { }
    };

    // Create mock match storage service
    mockMatchStorage = {
      getFailedPayloads: () => [],
      clearFailedPayload: () => { },
      clearFailedPayloads: () => { },
      getFailedPayloadsCount: () => 0,
      clearAllMatches: async () => 0,
      getMatchCount: () => 0
    };

    // Create mock bridge client
    mockBridgeClient = {
      getConnectionState: () => 'connected',
      send: async () => { },
      onMessage: () => { }
    };

    // Create mock configuration service
    mockConfigService = {
      get: (key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'diagnostics.maxRecoveryHistory': 50,
          'diagnostics.confirmDestructive': false,
          'bridge.port': 45123,
          'sync.stripComments': false,
          'sync.commentStrategy': 'auto',
          'matches.directory': '.codingame/matches'
        };
        return config[key] !== undefined ? config[key] : defaultValue;
      }
    };

    // Create mock extension context
    mockContext = {
      subscriptions: [],
      extension: {
        packageJSON: {
          version: '0.1.0'
        }
      },
      globalState: {
        get: () => undefined,
        update: () => Promise.resolve()
      }
    };

    // Initialize controller
    controller = new DiagnosticController(
      mockSyncController,
      mockMatchStorage,
      mockBridgeClient,
      mockConfigService,
      mockOutputChannel,
      mockContext
    );
  });

  teardown(() => {
    controller.dispose();
  });

  suite('resendLastSnapshot', () => {
    test('should fail when no cached payload exists', async () => {
      // Arrange
      mockSyncController.getLastSyncPayload = () => undefined;

      // Act
      const result = await controller.resendLastSnapshot();

      // Assert
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'NO_CACHED_PAYLOAD');
      assert.ok(result.timestamp);
    });

    test('should fail when bridge is offline', async () => {
      // Arrange
      const mockPayload = {
        type: 'sync_code' as const,
        requestId: 'test123',
        timestamp: new Date().toISOString(),
        payload: {
          language: 'Python3',
          code: 'print(42)',
          stripComments: false,
          strategy: 'none',
          fileName: 'test.py',
          originalSize: 10,
          processedSize: 10
        }
      };

      mockSyncController.getLastSyncPayload = () => mockPayload;
      mockSyncController.getLastSyncTime = () => new Date();
      mockBridgeClient.getConnectionState = () => 'disconnected';

      // Act
      const result = await controller.resendLastSnapshot();

      // Assert
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'BRIDGE_OFFLINE');
    });
  });

  suite('retryFailedMatches', () => {
    test('should return success with 0 processed when no failed payloads', async () => {
      // Arrange
      mockMatchStorage.getFailedPayloads = () => [];

      // Act
      const result = await controller.retryFailedMatches();

      // Assert
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.processed, 0);
      assert.strictEqual(result.succeeded, 0);
      assert.strictEqual(result.failed, 0);
    });
  });

  suite('generateDiagnosticReport', () => {
    test('should generate report with all sections', async () => {
      // Arrange
      mockMatchStorage.getFailedPayloadsCount = () => 2;
      mockMatchStorage.getMatchCount = () => 50;

      // Act
      const report = await controller.generateDiagnosticReport();

      // Assert
      assert.ok(report.timestamp);
      assert.ok(report.version);
      assert.ok(report.bridge);
      assert.ok(report.sync);
      assert.ok(report.storage);
      assert.ok(report.recovery);
      assert.ok(report.config);
      assert.ok(report.system);
      assert.strictEqual(report.storage.failedPayloads, 2);
    });
  });

  suite('clearCache', () => {
    test('should clear sync cache', async () => {
      // Arrange
      let cacheClearCalled = false;
      mockSyncController.clearCache = () => {
        cacheClearCalled = true;
      };

      // Act
      await controller.clearCache({ clearSync: true, clearFailed: false, clearHistory: false });

      // Assert
      assert.strictEqual(cacheClearCalled, true);
    });
  });

  suite('helper methods', () => {
    test('getFailedMatchCount should return correct count', () => {
      // Arrange
      mockMatchStorage.getFailedPayloadsCount = () => 7;

      // Act
      const count = controller.getFailedMatchCount();

      // Assert
      assert.strictEqual(count, 7);
    });

    test('hasLastSync should return false when no payload', () => {
      // Arrange
      mockSyncController.getLastSyncPayload = () => undefined;

      // Act
      const hasSync = controller.hasLastSync();

      // Assert
      assert.strictEqual(hasSync, false);
    });
  });

  suite('disposal', () => {
    test('should dispose without errors', () => {
      // Act & Assert
      assert.doesNotThrow(() => {
        controller.dispose();
      });
    });
  });
});
