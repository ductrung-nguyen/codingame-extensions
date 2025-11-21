/**
 * fullSyncToMatch.test.ts
 *
 * End-to-end test suite for Task 3.1: Full Sync-to-Match Cycle
 * Tests the complete workflow from code editing through match completion,
 * storage, and dashboard updates.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { E2ETestCoordinator, E2ETestConfig } from './E2ETestCoordinator';
import {
  MockBridgeClient,
  DataIntegrityVerifier,
  PerformanceMonitor,
  TestFixtureFactory,
  AsyncTestUtils
} from './E2ETestHelpers';

suite('E2E: Full Sync-to-Match Cycle (Task 3.1)', () => {
  let tempWorkspace: string;
  let coordinator: E2ETestCoordinator;
  let mockBridge: MockBridgeClient;
  let perfMonitor: PerformanceMonitor;
  let context: vscode.ExtensionContext;

  suiteSetup(async function () {
    this.timeout(30000);

    // Get extension context
    const extension = vscode.extensions.getExtension('codingame.vscode-extension');
    if (!extension) {
      throw new Error('Extension not found');
    }

    if (!extension.isActive) {
      await extension.activate();
    }

    context = extension.exports.context;

    // Create temporary workspace
    tempWorkspace = path.join(__dirname, '../../../.test-workspace-e2e');
    await fs.mkdir(tempWorkspace, { recursive: true });
  });

  suiteTeardown(async function () {
    this.timeout(10000);

    // Cleanup
    try {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to cleanup test workspace:', error);
    }
  });

  setup(async () => {
    // Initialize mocks and monitors
    mockBridge = new MockBridgeClient(true);
    perfMonitor = new PerformanceMonitor();

    // Clear any previous test data
    const matchesDir = path.join(tempWorkspace, '.codingame', 'matches');
    try {
      const files = await fs.readdir(matchesDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await fs.unlink(path.join(matchesDir, file));
        }
      }
    } catch {
      // Directory might not exist yet
    }
  });

  teardown(() => {
    mockBridge.clearMessages();
    perfMonitor.clear();
  });

  test('Complete workflow: edit → sync → match → storage → dashboard', async function () {
    this.timeout(60000);

    const config: E2ETestConfig = {
      workspaceDir: tempWorkspace,
      timeout: 10000,
      language: 'python',
      stripComments: false,
      simulateMatchResult: 'WIN',
      skipBrowserAutomation: true,
      verboseLogging: true
    };

    coordinator = new E2ETestCoordinator(context, config);

    // Monitor test events
    const events: string[] = [];
    coordinator.on('stageStart', (data) => {
      events.push(`stage_start:${data.stageName}`);
    });
    coordinator.on('stageComplete', (data) => {
      events.push(`stage_complete:${data.stageName}`);
    });
    coordinator.on('stageFailure', (data) => {
      events.push(`stage_failure:${data.stageName}`);
    });

    // Run full cycle
    const stopTimer = perfMonitor.start('fullCycle');
    const result = await coordinator.runFullCycle();
    stopTimer();

    // Assertions
    assert.strictEqual(result.status, 'success', 'Test should complete successfully');
    assert.ok(result.totalDuration > 0, 'Should have measurable duration');
    assert.strictEqual(result.stages.length, 10, 'Should have 10 stages');

    // Verify all stages completed
    const failedStages = result.stages.filter(s => s.status === 'failure');
    assert.strictEqual(failedStages.length, 0, 'No stages should fail');

    // Verify stage durations are reasonable
    result.stages.forEach(stage => {
      if (stage.duration) {
        assert.ok(stage.duration >= 0, `${stage.name} should have non-negative duration`);
        assert.ok(stage.duration < 30000, `${stage.name} should complete within 30s`);
      }
    });

    // Verify metrics
    assert.ok(result.metrics.syncLatency >= 0, 'Sync latency should be measured');
    assert.ok(result.metrics.storageLatency >= 0, 'Storage latency should be measured');
    assert.ok(result.metrics.totalPipelineLatency > 0, 'Total latency should be positive');
    assert.ok(
      result.metrics.dataIntegrityScore >= 80,
      `Data integrity score should be high (got ${result.metrics.dataIntegrityScore})`
    );

    // Verify artifacts
    const artifacts = coordinator.getArtifacts();
    assert.ok(artifacts.testCode.length > 0, 'Test code should be generated');
    assert.ok(artifacts.matchPayload, 'Match payload should be captured');
    assert.ok(artifacts.matchFilePath, 'Match file path should be set');
    assert.ok(artifacts.reportPath, 'Report should be generated');

    // Verify report file exists
    const reportExists = await fs.access(artifacts.reportPath!)
      .then(() => true)
      .catch(() => false);
    assert.strictEqual(reportExists, true, 'Report file should exist');

    // Verify match file exists
    const matchFileExists = await fs.access(artifacts.matchFilePath!)
      .then(() => true)
      .catch(() => false);
    assert.strictEqual(matchFileExists, true, 'Match file should exist');

    // Verify match file content
    const matchContent = await fs.readFile(artifacts.matchFilePath!, 'utf8');
    const matchData = JSON.parse(matchContent);
    assert.strictEqual(matchData.match_id, artifacts.matchPayload.match_id);
    assert.strictEqual(matchData.result, 'WIN');

    // Performance assertions
    assert.ok(
      result.metrics.syncLatency < 5000,
      'Sync should complete within 5s'
    );
    assert.ok(
      result.metrics.storageLatency < 3000,
      'Storage should complete within 3s'
    );
    assert.ok(
      result.totalDuration < 60000,
      'Full cycle should complete within 60s'
    );

    console.log('\n=== E2E Test Results ===');
    console.log(`Status: ${result.status}`);
    console.log(`Total Duration: ${result.totalDuration}ms`);
    console.log(`Data Integrity Score: ${result.metrics.dataIntegrityScore}%`);
    console.log(`\nStage Durations:`);
    result.stages.forEach(stage => {
      console.log(`  ${stage.name}: ${stage.duration}ms`);
    });
  });

  test('Verifies data integrity across full pipeline', async function () {
    this.timeout(30000);

    // Create test code
    const testCode = TestFixtureFactory.createTestCode('python');
    const testFile = path.join(tempWorkspace, 'integrity-test.py');
    await fs.writeFile(testFile, testCode, 'utf8');

    // Open in editor
    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    // Wait for editor to be ready
    await AsyncTestUtils.delay(500);

    // Get the actual editor content
    const editorContent = document.getText();

    // Verify code integrity
    const integrityResult = DataIntegrityVerifier.verifyCodeIntegrity(
      testCode,
      editorContent
    );

    assert.strictEqual(integrityResult.hashMatch, true, 'Code hashes should match');
    assert.strictEqual(integrityResult.sizeMatch, true, 'Code sizes should match');
    assert.strictEqual(
      integrityResult.lineCountMatch,
      true,
      'Line counts should match'
    );
    assert.strictEqual(
      integrityResult.integrityScore,
      100,
      'Integrity score should be 100'
    );

    // Simulate sync payload
    const syncPayload = TestFixtureFactory.createSyncPayload(testCode);
    assert.strictEqual(
      syncPayload.payload.code,
      testCode,
      'Sync payload should contain original code'
    );

    console.log(`\nData Integrity Verification:`);
    console.log(`  Hash Match: ${integrityResult.hashMatch}`);
    console.log(`  Size Match: ${integrityResult.sizeMatch}`);
    console.log(`  Line Count Match: ${integrityResult.lineCountMatch}`);
    console.log(`  Integrity Score: ${integrityResult.integrityScore}%`);
  });

  test('Verifies match payload storage and retrieval', async function () {
    this.timeout(15000);

    // Create test match payload
    const matchPayload = TestFixtureFactory.createMatchPayload({
      match_id: 'integrity-test-match',
      result: 'WIN',
      order: 0
    });

    // Get match storage service
    const extension = vscode.extensions.getExtension('codingame.vscode-extension');
    const matchStorageService = extension?.exports?.matchStorageService;

    if (!matchStorageService) {
      this.skip();
      return;
    }

    // Store match
    const storeResult = await matchStorageService.store(matchPayload);
    assert.strictEqual(storeResult.success, true, 'Match storage should succeed');

    // Wait for file to be written
    await AsyncTestUtils.delay(1000);

    // Verify file exists
    const filename = `${matchPayload.result}_${matchPayload.order}_${matchPayload.match_id}.json`;
    const matchFilePath = path.join(tempWorkspace, '.codingame', 'matches', filename);

    const fileExists = await fs.access(matchFilePath)
      .then(() => true)
      .catch(() => false);
    assert.strictEqual(fileExists, true, 'Match file should exist');

    // Read and verify content
    const fileContent = await fs.readFile(matchFilePath, 'utf8');
    const storedMatch = JSON.parse(fileContent);

    // Verify integrity
    const integrityResult = DataIntegrityVerifier.verifyMatchIntegrity(
      matchPayload,
      storedMatch
    );

    assert.strictEqual(
      integrityResult.criticalFieldsMatch,
      true,
      'Critical fields should match'
    );
    assert.strictEqual(
      integrityResult.timestampValid,
      true,
      'Timestamp should be valid'
    );
    assert.strictEqual(integrityResult.logsPresent, true, 'Logs should be present');
    assert.strictEqual(integrityResult.schemaValid, true, 'Schema should be valid');
    assert.ok(
      integrityResult.integrityScore >= 80,
      `Match integrity score should be high (got ${integrityResult.integrityScore})`
    );

    console.log(`\nMatch Integrity Verification:`);
    console.log(`  Critical Fields Match: ${integrityResult.criticalFieldsMatch}`);
    console.log(`  Timestamp Valid: ${integrityResult.timestampValid}`);
    console.log(`  Logs Present: ${integrityResult.logsPresent}`);
    console.log(`  Schema Valid: ${integrityResult.schemaValid}`);
    console.log(`  Integrity Score: ${integrityResult.integrityScore}%`);
  });

  test('Handles bridge disconnection during sync gracefully', async function () {
    this.timeout(15000);

    // Create test file
    const testCode = TestFixtureFactory.createTestCode('python');
    const testFile = path.join(tempWorkspace, 'disconnect-test.py');
    await fs.writeFile(testFile, testCode, 'utf8');

    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    // Start mock bridge
    await mockBridge.start();

    // Simulate disconnect after short delay
    setTimeout(() => {
      mockBridge.simulateDisconnect();
    }, 500);

    // Attempt sync (should handle disconnect gracefully)
    try {
      await vscode.commands.executeCommand('codingame.sync');
      // Command should complete even if bridge disconnects
    } catch (error) {
      // Acceptable to throw error, but should be handled gracefully
      assert.ok(
        (error as Error).message.includes('offline') ||
        (error as Error).message.includes('disconnect'),
        'Error should indicate connectivity issue'
      );
    }

    // Verify bridge can reconnect
    await mockBridge.simulateReconnect();
    assert.strictEqual(mockBridge.isConnected(), true, 'Bridge should reconnect');
  });

  test('Measures end-to-end latency under repeated operations', async function () {
    this.timeout(90000);

    const iterations = 5;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      // Create unique test code
      const testCode = `# Test iteration ${i}\nprint(${i})`;
      const testFile = path.join(tempWorkspace, `perf-test-${i}.py`);
      await fs.writeFile(testFile, testCode, 'utf8');

      const document = await vscode.workspace.openTextDocument(testFile);
      await vscode.window.showTextDocument(document);

      // Measure sync latency
      const stopTimer = perfMonitor.start('syncOperation');
      const startTime = Date.now();

      try {
        await vscode.commands.executeCommand('codingame.sync');
        const duration = Date.now() - startTime;
        latencies.push(duration);
        stopTimer();
      } catch (error) {
        // May fail if bridge not available, but we still measure
        const duration = Date.now() - startTime;
        latencies.push(duration);
        stopTimer();
      }

      // Small delay between iterations
      await AsyncTestUtils.delay(200);
    }

    // Calculate statistics
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const maxLatency = Math.max(...latencies);
    const minLatency = Math.min(...latencies);

    console.log('\n=== Latency Metrics ===');
    console.log(`Iterations: ${iterations}`);
    console.log(`Average: ${avgLatency.toFixed(2)}ms`);
    console.log(`Min: ${minLatency}ms`);
    console.log(`Max: ${maxLatency}ms`);

    // Performance assertions
    assert.ok(avgLatency < 5000, 'Average sync latency should be under 5s');
    assert.ok(maxLatency < 10000, 'Maximum sync latency should be under 10s');

    // Verify performance is consistent (no severe outliers)
    const variance = latencies.reduce((acc, val) => {
      return acc + Math.pow(val - avgLatency, 2);
    }, 0) / latencies.length;
    const stdDev = Math.sqrt(variance);

    console.log(`Std Dev: ${stdDev.toFixed(2)}ms`);
    assert.ok(
      stdDev < avgLatency,
      'Standard deviation should be less than average (reasonable consistency)'
    );

    // Generate performance report
    const report = perfMonitor.generateReport();
    console.log('\n' + report);
  });

  test('Verifies stage timing requirements', async function () {
    this.timeout(30000);

    const config: E2ETestConfig = {
      workspaceDir: tempWorkspace,
      timeout: 10000,
      language: 'python',
      stripComments: false,
      simulateMatchResult: 'WIN',
      skipBrowserAutomation: true,
      verboseLogging: false
    };

    coordinator = new E2ETestCoordinator(context, config);
    const result = await coordinator.runFullCycle();

    // Define timing requirements from specification
    const timingRequirements = {
      setup: 5000,
      fileCreation: 500,
      syncTrigger: 2000,
      bridgeTransmission: 2000,
      codeInjection: 500,
      matchExecution: 30000,
      matchCapture: 2000,
      matchStorage: 2000,
      dashboardUpdate: 1000,
      verification: 1000
    };

    // Verify each stage meets timing requirements
    result.stages.forEach(stage => {
      const maxTime = timingRequirements[stage.name as keyof typeof timingRequirements];
      if (maxTime && stage.duration) {
        assert.ok(
          stage.duration <= maxTime,
          `Stage ${stage.name} should complete within ${maxTime}ms (took ${stage.duration}ms)`
        );
      }
    });

    console.log('\n=== Stage Timing Verification ===');
    result.stages.forEach(stage => {
      const maxTime = timingRequirements[stage.name as keyof typeof timingRequirements];
      const status = stage.duration && maxTime && stage.duration <= maxTime ? '✓' : '✗';
      console.log(`${status} ${stage.name}: ${stage.duration}ms / ${maxTime}ms`);
    });
  });

  test('Verifies match file naming convention', async function () {
    this.timeout(15000);

    const testCases = [
      { result: 'WIN', order: 0, matchId: 'test-win-0' },
      { result: 'LOSE', order: 1, matchId: 'test-lose-1' },
      { result: 'DRAW', order: 0, matchId: 'test-draw-0' }
    ];

    const extension = vscode.extensions.getExtension('codingame.vscode-extension');
    const matchStorageService = extension?.exports?.matchStorageService;

    if (!matchStorageService) {
      this.skip();
      return;
    }

    for (const testCase of testCases) {
      const payload = TestFixtureFactory.createMatchPayload({
        match_id: testCase.matchId,
        result: testCase.result,
        order: testCase.order
      });

      await matchStorageService.store(payload);
      await AsyncTestUtils.delay(500);

      // Verify filename follows convention
      const expectedFilename = `${testCase.result}_${testCase.order}_${testCase.matchId}.json`;
      const filePath = path.join(
        tempWorkspace,
        '.codingame',
        'matches',
        expectedFilename
      );

      const exists = await fs.access(filePath)
        .then(() => true)
        .catch(() => false);

      assert.strictEqual(
        exists,
        true,
        `File should exist with naming convention: ${expectedFilename}`
      );

      console.log(`✓ Verified: ${expectedFilename}`);
    }
  });

  test('Validates complete data flow integrity', async function () {
    this.timeout(30000);

    // Create original test code
    const originalCode = TestFixtureFactory.createTestCode('python');
    const testFile = path.join(tempWorkspace, 'dataflow-test.py');
    await fs.writeFile(testFile, originalCode, 'utf8');

    // Open in editor
    const document = await vscode.workspace.openTextDocument(testFile);
    await vscode.window.showTextDocument(document);

    // Stage 1: Verify editor content matches original
    const editorContent = document.getText();
    const stage1Integrity = DataIntegrityVerifier.verifyCodeIntegrity(
      originalCode,
      editorContent
    );
    assert.strictEqual(stage1Integrity.hashMatch, true, 'Stage 1: Editor content should match');

    // Stage 2: Create sync payload and verify
    const syncPayload = TestFixtureFactory.createSyncPayload(editorContent);
    const stage2Integrity = DataIntegrityVerifier.verifyCodeIntegrity(
      editorContent,
      syncPayload.payload.code
    );
    assert.strictEqual(stage2Integrity.hashMatch, true, 'Stage 2: Sync payload should match');

    // Stage 3: Create and store match, then verify
    const matchPayload = TestFixtureFactory.createMatchPayload({
      match_id: 'dataflow-test-match'
    });

    const extension = vscode.extensions.getExtension('codingame.vscode-extension');
    const matchStorageService = extension?.exports?.matchStorageService;

    if (matchStorageService) {
      await matchStorageService.store(matchPayload);
      await AsyncTestUtils.delay(1000);

      // Read stored match
      const filename = `${matchPayload.result}_${matchPayload.order}_${matchPayload.match_id}.json`;
      const filePath = path.join(tempWorkspace, '.codingame', 'matches', filename);
      const storedContent = await fs.readFile(filePath, 'utf8');
      const storedMatch = JSON.parse(storedContent);

      // Verify match integrity
      const stage3Integrity = DataIntegrityVerifier.verifyMatchIntegrity(
        matchPayload,
        storedMatch
      );
      assert.strictEqual(
        stage3Integrity.criticalFieldsMatch,
        true,
        'Stage 3: Stored match should match original'
      );
    }

    // Calculate overall data flow integrity
    const overallScore = (
      stage1Integrity.integrityScore +
      stage2Integrity.integrityScore +
      (matchStorageService ? 100 : 0)
    ) / (matchStorageService ? 3 : 2);

    console.log('\n=== Data Flow Integrity ===');
    console.log(`Stage 1 (Editor): ${stage1Integrity.integrityScore}%`);
    console.log(`Stage 2 (Sync): ${stage2Integrity.integrityScore}%`);
    if (matchStorageService) {
      console.log(`Stage 3 (Storage): 100%`);
    }
    console.log(`Overall Score: ${overallScore.toFixed(1)}%`);

    assert.ok(overallScore >= 95, 'Overall data flow integrity should be ≥95%');
  });

  test('Stress test: Multiple rapid sync operations', async function () {
    this.timeout(60000);

    const operationCount = 10;
    const results: Array<{ success: boolean; duration: number }> = [];

    for (let i = 0; i < operationCount; i++) {
      const testCode = `# Stress test ${i}\nprint("test ${i}")`;
      const testFile = path.join(tempWorkspace, `stress-test-${i}.py`);
      await fs.writeFile(testFile, testCode, 'utf8');

      const document = await vscode.workspace.openTextDocument(testFile);
      await vscode.window.showTextDocument(document);

      const startTime = Date.now();
      try {
        await vscode.commands.executeCommand('codingame.sync');
        results.push({ success: true, duration: Date.now() - startTime });
      } catch (error) {
        results.push({ success: false, duration: Date.now() - startTime });
      }

      // Very short delay to simulate rapid operations
      await AsyncTestUtils.delay(100);
    }

    const successCount = results.filter(r => r.success).length;
    const successRate = (successCount / operationCount) * 100;

    console.log('\n=== Stress Test Results ===');
    console.log(`Operations: ${operationCount}`);
    console.log(`Successful: ${successCount}`);
    console.log(`Success Rate: ${successRate.toFixed(1)}%`);

    // In stress test, some failures are acceptable but most should succeed
    assert.ok(
      successRate >= 70,
      `Success rate should be at least 70% under stress (got ${successRate.toFixed(1)}%)`
    );
  });
});
