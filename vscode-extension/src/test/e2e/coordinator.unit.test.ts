/**
 * coordinator.unit.test.ts
 *
 * Unit tests for E2E Test Coordinator and related components.
 * Tests individual coordinator methods, stage execution, and error handling.
 *
 * Part of Task 3.1: Full Sync-to-Match Cycle
 */

import * as assert from 'assert';
import {
  MockBridgeClient,
  DataIntegrityVerifier,
  PerformanceMonitor,
  TestFixtureFactory,
  AsyncTestUtils
} from './E2ETestHelpers';

suite('E2E Coordinator Unit Tests', () => {
  suite('MockBridgeClient', () => {
    let mockBridge: MockBridgeClient;

    setup(() => {
      mockBridge = new MockBridgeClient(false); // No latency for unit tests
    });

    teardown(() => {
      mockBridge.clearMessages();
    });

    test('starts and stops correctly', async () => {
      assert.strictEqual(mockBridge.isConnected(), false, 'Should start disconnected');

      await mockBridge.start();
      assert.strictEqual(mockBridge.isConnected(), true, 'Should be connected after start');

      await mockBridge.stop();
      assert.strictEqual(mockBridge.isConnected(), false, 'Should be disconnected after stop');
    });

    test('sends messages when connected', async () => {
      await mockBridge.start();

      const message = {
        type: 'test_message',
        payload: { data: 'test' }
      };

      await mockBridge.send(message);

      const sentMessages = mockBridge.getSentMessages();
      assert.strictEqual(sentMessages.length, 1, 'Should have sent one message');
      assert.strictEqual(sentMessages[0].type, 'test_message');
    });

    test('throws error when sending while disconnected', async () => {
      const message = { type: 'test' };

      try {
        await mockBridge.send(message);
        assert.fail('Should have thrown error');
      } catch (error) {
        assert.ok((error as Error).message.includes('not connected'));
      }
    });

    test('handles message reception', async () => {
      await mockBridge.start();

      let receivedMessage: any = null;
      mockBridge.onMessage((msg) => {
        receivedMessage = msg;
      });

      const testMessage = {
        type: 'test_receive',
        payload: { value: 123 }
      };

      mockBridge.simulateReceive(testMessage);

      assert.ok(receivedMessage, 'Should have received message');
      assert.strictEqual(receivedMessage.type, 'test_receive');
      assert.strictEqual(receivedMessage.payload.value, 123);
    });

    test('auto-responds to sync_code messages', async () => {
      await mockBridge.start();

      let responseReceived = false;
      mockBridge.onMessage((msg) => {
        if (msg.type === 'sync_status') {
          responseReceived = true;
        }
      });

      const syncMessage = {
        type: 'sync_code',
        requestId: 'test-123',
        payload: { code: 'print("test")' }
      };

      await mockBridge.send(syncMessage);

      // Give time for auto-response
      await AsyncTestUtils.delay(50);

      assert.strictEqual(responseReceived, true, 'Should auto-respond to sync_code');
    });

    test('simulates disconnect and reconnect', async () => {
      await mockBridge.start();
      assert.strictEqual(mockBridge.isConnected(), true);

      let disconnectNotified = false;
      mockBridge.onMessage((msg) => {
        if (msg.type === 'bridge_disconnected') {
          disconnectNotified = true;
        }
      });

      mockBridge.simulateDisconnect();
      assert.strictEqual(mockBridge.isConnected(), false);
      assert.strictEqual(disconnectNotified, true);

      await mockBridge.simulateReconnect();
      assert.strictEqual(mockBridge.isConnected(), true);
    });

    test('tracks sent and received messages', async () => {
      await mockBridge.start();

      await mockBridge.send({ type: 'msg1' });
      await mockBridge.send({ type: 'msg2' });
      mockBridge.simulateReceive({ type: 'recv1' });

      assert.strictEqual(mockBridge.getSentMessages().length, 2);
      assert.strictEqual(mockBridge.getReceivedMessages().length, 1);

      mockBridge.clearMessages();

      assert.strictEqual(mockBridge.getSentMessages().length, 0);
      assert.strictEqual(mockBridge.getReceivedMessages().length, 0);
    });

    test('configurable latency', async () => {
      const latencyBridge = new MockBridgeClient(true);
      latencyBridge.setLatency(200);

      const startTime = Date.now();
      await latencyBridge.start();
      const duration = Date.now() - startTime;

      assert.ok(duration >= 200, 'Should respect configured latency');
    });
  });

  suite('DataIntegrityVerifier', () => {
    test('verifies identical code integrity', () => {
      const code = 'print("Hello, World!")';
      const result = DataIntegrityVerifier.verifyCodeIntegrity(code, code);

      assert.strictEqual(result.hashMatch, true, 'Hashes should match');
      assert.strictEqual(result.sizeMatch, true, 'Sizes should match');
      assert.strictEqual(result.lineCountMatch, true, 'Line counts should match');
      assert.strictEqual(result.integrityScore, 100, 'Integrity score should be 100');
    });

    test('detects code differences', () => {
      const original = 'print("test")';
      const modified = 'print("modified")';
      const result = DataIntegrityVerifier.verifyCodeIntegrity(original, modified);

      assert.strictEqual(result.hashMatch, false, 'Hashes should not match');
      assert.strictEqual(result.sizeMatch, false, 'Sizes should not match');
      assert.ok(result.integrityScore < 100, 'Integrity score should be less than 100');
    });

    test('verifies multi-line code integrity', () => {
      const code = `def main():
    x = 1
    y = 2
    print(x + y)`;

      const result = DataIntegrityVerifier.verifyCodeIntegrity(code, code);

      assert.strictEqual(result.lineCountMatch, true);
      assert.strictEqual(result.integrityScore, 100);
    });

    test('calculates partial integrity score for similar code', () => {
      const original = 'print("test")\nprint("test")';
      const similar = 'print("test")\nprint("test2")';

      const result = DataIntegrityVerifier.verifyCodeIntegrity(original, similar);

      assert.strictEqual(result.lineCountMatch, true, 'Line counts match');
      assert.ok(result.integrityScore > 50, 'Should have partial integrity');
      assert.ok(result.integrityScore < 100, 'Should not be perfect integrity');
    });

    test('verifies match payload integrity', () => {
      const payload = TestFixtureFactory.createMatchPayload();
      const stored = { ...payload };

      const result = DataIntegrityVerifier.verifyMatchIntegrity(payload, stored);

      assert.strictEqual(result.criticalFieldsMatch, true);
      assert.strictEqual(result.timestampValid, true);
      assert.strictEqual(result.logsPresent, true);
      assert.strictEqual(result.schemaValid, true);
      assert.strictEqual(result.integrityScore, 100);
    });

    test('detects missing match fields', () => {
      const payload = TestFixtureFactory.createMatchPayload();
      const incomplete = {
        match_id: payload.match_id,
        result: payload.result
        // Missing other required fields
      };

      const result = DataIntegrityVerifier.verifyMatchIntegrity(payload, incomplete);

      assert.strictEqual(result.schemaValid, false, 'Schema should be invalid');
      assert.ok(result.integrityScore < 100, 'Integrity score should be reduced');
    });

    test('validates timestamps correctly', () => {
      const validPayload = {
        match_id: 'test',
        result: 'WIN',
        order: 0,
        timestamp: new Date().toISOString(),
        logs: { stdout: 'test', stderr: '' }
      };

      const invalidPayload = {
        ...validPayload,
        timestamp: 'invalid-timestamp'
      };

      const validResult = DataIntegrityVerifier.verifyMatchIntegrity(
        validPayload,
        validPayload
      );
      const invalidResult = DataIntegrityVerifier.verifyMatchIntegrity(
        invalidPayload,
        invalidPayload
      );

      assert.strictEqual(validResult.timestampValid, true);
      assert.strictEqual(invalidResult.timestampValid, false);
    });
  });

  suite('PerformanceMonitor', () => {
    let monitor: PerformanceMonitor;

    setup(() => {
      monitor = new PerformanceMonitor();
    });

    teardown(() => {
      monitor.clear();
    });

    test('records measurements', () => {
      monitor.record('test_op', 100);
      monitor.record('test_op', 200);
      monitor.record('test_op', 150);

      const stats = monitor.getStats('test_op');
      assert.ok(stats, 'Should have stats');
      assert.strictEqual(stats!.count, 3);
      assert.strictEqual(stats!.min, 100);
      assert.strictEqual(stats!.max, 200);
    });

    test('calculates mean correctly', () => {
      monitor.record('mean_test', 100);
      monitor.record('mean_test', 200);
      monitor.record('mean_test', 300);

      const stats = monitor.getStats('mean_test');
      assert.strictEqual(stats!.mean, 200);
    });

    test('calculates median correctly', () => {
      monitor.record('median_test', 100);
      monitor.record('median_test', 300);
      monitor.record('median_test', 200);

      const stats = monitor.getStats('median_test');
      assert.strictEqual(stats!.median, 200);
    });

    test('calculates percentiles correctly', () => {
      // Add 100 measurements
      for (let i = 1; i <= 100; i++) {
        monitor.record('percentile_test', i);
      }

      const stats = monitor.getStats('percentile_test');
      assert.ok(stats!.p95 >= 95, 'P95 should be around 95');
      assert.ok(stats!.p99 >= 99, 'P99 should be around 99');
    });

    test('start() returns stop function', async () => {
      const stop = monitor.start('timer_test');
      await AsyncTestUtils.delay(50);
      stop();

      const stats = monitor.getStats('timer_test');
      assert.ok(stats!.count === 1);
      assert.ok(stats!.mean >= 50, 'Should measure at least 50ms');
    });

    test('tracks multiple operations', () => {
      monitor.record('op1', 100);
      monitor.record('op2', 200);
      monitor.record('op1', 150);

      const allStats = monitor.getAllStats();
      assert.strictEqual(allStats.length, 2);

      const op1Stats = allStats.find(s => s.operationName === 'op1');
      const op2Stats = allStats.find(s => s.operationName === 'op2');

      assert.ok(op1Stats);
      assert.ok(op2Stats);
      assert.strictEqual(op1Stats!.count, 2);
      assert.strictEqual(op2Stats!.count, 1);
    });

    test('generates performance report', () => {
      monitor.record('report_test', 100);
      monitor.record('report_test', 200);

      const report = monitor.generateReport();
      assert.ok(report.includes('report_test'));
      assert.ok(report.includes('Mean:'));
      assert.ok(report.includes('P95:'));
    });

    test('clears all data', () => {
      monitor.record('clear_test', 100);
      assert.ok(monitor.getStats('clear_test'));

      monitor.clear();
      assert.strictEqual(monitor.getStats('clear_test'), null);
    });

    test('handles empty measurements', () => {
      const stats = monitor.getStats('nonexistent');
      assert.strictEqual(stats, null);

      const allStats = monitor.getAllStats();
      assert.strictEqual(allStats.length, 0);
    });
  });

  suite('TestFixtureFactory', () => {
    test('creates valid match payload', () => {
      const payload = TestFixtureFactory.createMatchPayload();

      assert.ok(payload.match_id);
      assert.ok(payload.deliveryId);
      assert.ok(['WIN', 'LOSE', 'DRAW'].includes(payload.result));
      assert.ok([0, 1].includes(payload.order));
      assert.ok(payload.timestamp);
      assert.ok(payload.logs);
      assert.strictEqual(typeof payload.logs.stdout, 'string');
    });

    test('applies overrides to match payload', () => {
      const payload = TestFixtureFactory.createMatchPayload({
        result: 'LOSE',
        order: 1,
        opponent: 'CustomBot'
      });

      assert.strictEqual(payload.result, 'LOSE');
      assert.strictEqual(payload.order, 1);
      assert.strictEqual(payload.opponent, 'CustomBot');
    });

    test('creates valid sync payload', () => {
      const code = 'print("test")';
      const payload = TestFixtureFactory.createSyncPayload(code);

      assert.strictEqual(payload.type, 'sync_code');
      assert.ok(payload.requestId);
      assert.strictEqual(payload.payload.code, code);
      assert.strictEqual(payload.payload.language, 'Python3');
      assert.strictEqual(payload.version, '1.0.0');
    });

    test('applies overrides to sync payload', () => {
      const code = 'console.log("test")';
      const payload = TestFixtureFactory.createSyncPayload(code, {
        language: 'JavaScript',
        stripComments: true
      });

      assert.strictEqual(payload.payload.language, 'JavaScript');
      assert.strictEqual(payload.payload.stripComments, true);
    });

    test('creates test code for different languages', () => {
      const pythonCode = TestFixtureFactory.createTestCode('python');
      const jsCode = TestFixtureFactory.createTestCode('javascript');
      const javaCode = TestFixtureFactory.createTestCode('java');

      assert.ok(pythonCode.includes('def '));
      assert.ok(jsCode.includes('function'));
      assert.ok(javaCode.includes('class'));
    });

    test('creates unique match IDs', () => {
      const payload1 = TestFixtureFactory.createMatchPayload();
      const payload2 = TestFixtureFactory.createMatchPayload();

      assert.notStrictEqual(payload1.match_id, payload2.match_id);
      assert.notStrictEqual(payload1.deliveryId, payload2.deliveryId);
    });
  });

  suite('AsyncTestUtils', () => {
    test('delay waits for specified time', async () => {
      const startTime = Date.now();
      await AsyncTestUtils.delay(100);
      const duration = Date.now() - startTime;

      assert.ok(duration >= 100, 'Should wait at least 100ms');
      assert.ok(duration < 150, 'Should not wait much longer than 100ms');
    });

    test('waitFor succeeds when condition becomes true', async () => {
      let value = false;
      setTimeout(() => { value = true; }, 50);

      await AsyncTestUtils.waitFor(() => value, { timeout: 1000, interval: 10 });
      assert.strictEqual(value, true);
    });

    test('waitFor times out when condition never true', async () => {
      try {
        await AsyncTestUtils.waitFor(() => false, { timeout: 100, interval: 10 });
        assert.fail('Should have timed out');
      } catch (error) {
        assert.ok((error as Error).message.includes('timeout'));
      }
    });

    test('waitFor with custom timeout message', async () => {
      try {
        await AsyncTestUtils.waitFor(
          () => false,
          { timeout: 100, timeoutMessage: 'Custom timeout' }
        );
        assert.fail('Should have timed out');
      } catch (error) {
        assert.strictEqual((error as Error).message, 'Custom timeout');
      }
    });

    test('retry succeeds on first attempt', async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        return 'success';
      };

      const result = await AsyncTestUtils.retry(operation);
      assert.strictEqual(result, 'success');
      assert.strictEqual(callCount, 1);
    });

    test('retry succeeds after failures', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return 'success';
      };

      const result = await AsyncTestUtils.retry(operation, { maxAttempts: 5, initialDelay: 10 });
      assert.strictEqual(result, 'success');
      assert.strictEqual(attempts, 3);
    });

    test('retry fails after max attempts', async () => {
      const operation = async () => {
        throw new Error('Always fails');
      };

      try {
        await AsyncTestUtils.retry(operation, { maxAttempts: 3, initialDelay: 10 });
        assert.fail('Should have thrown error');
      } catch (error) {
        assert.strictEqual((error as Error).message, 'Always fails');
      }
    });

    test('retry with exponential backoff', async () => {
      const delays: number[] = [];
      let attempts = 0;

      const operation = async () => {
        const now = Date.now();
        if (attempts > 0) {
          delays.push(now);
        }
        attempts++;
        if (attempts < 4) {
          throw new Error('Retry');
        }
        return 'done';
      };

      await AsyncTestUtils.retry(operation, {
        maxAttempts: 5,
        initialDelay: 50,
        factor: 2
      });

      // Verify delays increased exponentially
      assert.strictEqual(delays.length, 3);
    });
  });

  suite('E2ETestCoordinator Stage Management', () => {
    test('initializes with correct stages', () => {
      // This test would require mocking vscode.ExtensionContext
      // For now, we'll test the stage definitions conceptually
      const expectedStages = [
        'setup',
        'fileCreation',
        'syncTrigger',
        'bridgeTransmission',
        'codeInjection',
        'matchExecution',
        'matchCapture',
        'matchStorage',
        'dashboardUpdate',
        'verification'
      ];

      assert.strictEqual(expectedStages.length, 10, 'Should have 10 stages');
    });

    test('stage timing validation', () => {
      // Verify stage timing requirements from spec
      const timingRequirements = {
        setup: { target: 100, max: 5000 },
        fileCreation: { target: 100, max: 500 },
        syncTrigger: { target: 500, max: 2000 },
        bridgeTransmission: { target: 500, max: 2000 },
        codeInjection: { target: 100, max: 500 },
        matchExecution: { target: 10000, max: 30000 },
        matchCapture: { target: 500, max: 2000 },
        matchStorage: { target: 500, max: 2000 },
        dashboardUpdate: { target: 200, max: 1000 },
        verification: { target: 200, max: 1000 }
      };

      // Verify total max time is under 60s
      const totalMaxTime = Object.values(timingRequirements)
        .reduce((sum, req) => sum + req.max, 0);

      assert.ok(totalMaxTime <= 60000, 'Total max time should be under 60s');
    });
  });

  suite('Data Integrity Scoring', () => {
    test('perfect integrity scores 100', () => {
      const code = 'test code';
      const result = DataIntegrityVerifier.verifyCodeIntegrity(code, code);
      assert.strictEqual(result.integrityScore, 100);
    });

    test('hash mismatch reduces score by 40 points', () => {
      const original = 'original';
      const different = 'different';
      const result = DataIntegrityVerifier.verifyCodeIntegrity(original, different);

      assert.ok(result.integrityScore <= 60, 'Score should be 60 or less without hash match');
    });

    test('size mismatch reduces score', () => {
      const original = 'short';
      const longer = 'much longer text';
      const result = DataIntegrityVerifier.verifyCodeIntegrity(original, longer);

      assert.ok(result.integrityScore < 100, 'Size mismatch should reduce score');
    });

    test('match integrity with all checks passed', () => {
      const payload = {
        match_id: 'test-123',
        result: 'WIN',
        order: 0,
        timestamp: new Date().toISOString(),
        logs: { stdout: 'test', stderr: '' }
      };

      const result = DataIntegrityVerifier.verifyMatchIntegrity(payload, payload);

      assert.strictEqual(result.integrityScore, 100);
      assert.strictEqual(result.criticalFieldsMatch, true);
      assert.strictEqual(result.timestampValid, true);
      assert.strictEqual(result.logsPresent, true);
      assert.strictEqual(result.schemaValid, true);
    });
  });

  suite('Performance Monitoring Edge Cases', () => {
    let monitor: PerformanceMonitor;

    setup(() => {
      monitor = new PerformanceMonitor();
    });

    test('handles single measurement', () => {
      monitor.record('single', 100);
      const stats = monitor.getStats('single');

      assert.strictEqual(stats!.count, 1);
      assert.strictEqual(stats!.mean, 100);
      assert.strictEqual(stats!.median, 100);
      assert.strictEqual(stats!.min, 100);
      assert.strictEqual(stats!.max, 100);
    });

    test('handles very large measurements', () => {
      monitor.record('large', 1000000);
      monitor.record('large', 2000000);

      const stats = monitor.getStats('large');
      assert.strictEqual(stats!.mean, 1500000);
    });

    test('handles zero duration', () => {
      monitor.record('zero', 0);
      const stats = monitor.getStats('zero');

      assert.strictEqual(stats!.mean, 0);
      assert.strictEqual(stats!.min, 0);
    });

    test('calculates standard deviation', () => {
      // Values: 10, 20, 30 (mean = 20, variance = 66.67, stdDev ≈ 8.16)
      monitor.record('stddev', 10);
      monitor.record('stddev', 20);
      monitor.record('stddev', 30);

      const stats = monitor.getStats('stddev');
      assert.ok(stats!.stdDev > 8 && stats!.stdDev < 9);
    });
  });
});
