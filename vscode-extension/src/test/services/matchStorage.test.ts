/**
 * Match Storage Service Tests
 *
 * Unit tests for MatchStorageService, MatchDataValidator, and MatchIndexManager
 * Task 2.4: Match Data Storage
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { MatchStorageService } from '../../services/MatchStorageService';
import { MatchDataValidator } from '../../services/MatchDataValidator';
import { MatchIndexManager } from '../../services/MatchIndexManager';
import { MatchPayload, MatchRecord } from '../../models/MatchRecord';

// Mock output channel
class MockOutputChannel {
  private logs: string[] = [];

  appendLine(message: string): void {
    this.logs.push(message);
  }

  clear(): void {
    this.logs = [];
  }

  getLogs(): string[] {
    return this.logs;
  }

  show(): void { }
  hide(): void { }
  dispose(): void { }
}

// Mock configuration service
class MockConfigurationService {
  private config: Map<string, any> = new Map();

  private matchesDir: string = '';

  constructor() {
    this.config.set('matches.directory', '');
    this.config.set('matches.autoReindex', true);
    this.config.set('matches.rotation.enabled', false);
    this.config.set('matches.rotation.maxMatches', 1000);
    this.config.set('matches.rotation.maxAgeDays', 30);
    this.config.set('matches.rotation.strategy', 'oldest');
  }

  onConfigChange(_handler: any) {
    return { dispose: () => { } };
  }

  getMatchesDirectory(): string {
    return this.matchesDir;
  }

  setMatchesDirectory(dir: string): void {
    this.matchesDir = dir;
  }

  get<T>(key: string, defaultValue?: T): T {
    const value = this.config.get(key);
    if (value !== undefined) {
      return value as T;
    }
    return defaultValue as T;
  }

  set(key: string, value: any): void {
    this.config.set(key, value);
  }
}

suite('MatchDataValidator Tests', () => {
  let validator: MatchDataValidator;

  setup(() => {
    validator = new MatchDataValidator();
  });

  test('validates valid payload successfully', () => {
    const payload = {
      match_id: '2001',
      result: 'WIN',
      order: 0,
      timestamp: new Date().toISOString()
    };

    const result = validator.validate(payload);

    assert.strictEqual(result.valid, true);
    assert.ok(result.data);
    assert.strictEqual(result.data.match_id, '2001');
    assert.strictEqual(result.data.result, 'WIN');
  });

  test('rejects payload with missing match_id', () => {
    const payload = {
      result: 'WIN',
      order: 0,
      timestamp: new Date().toISOString()
    };

    const result = validator.validate(payload);

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors);
    assert.ok(result.errors.some(e => e.includes('match_id')));
  });

  test('rejects payload with missing result', () => {
    const payload = {
      match_id: '2001',
      order: 0,
      timestamp: new Date().toISOString()
    };

    const result = validator.validate(payload);

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors);
    assert.ok(result.errors.some(e => e.includes('result')));
  });

  test('rejects payload with invalid result value', () => {
    const payload = {
      match_id: '2001',
      result: 'INVALID',
      order: 0,
      timestamp: new Date().toISOString()
    };

    const result = validator.validate(payload);

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors);
    assert.ok(result.errors.some(e => e.includes('Invalid result')));
  });

  test('rejects payload with invalid order', () => {
    const payload = {
      match_id: '2001',
      result: 'WIN',
      order: 2,
      timestamp: new Date().toISOString()
    };

    const result = validator.validate(payload);

    assert.strictEqual(result.valid, false);
    assert.ok(result.errors);
    assert.ok(result.errors.some(e => e.includes('order')));
  });

  test('normalizes optional fields correctly', () => {
    const payload = {
      match_id: '2001',
      result: 'WIN',
      order: 0,
      timestamp: new Date().toISOString(),
      opponent: '  Test Player  ',
      league: '  Gold  ',
      durationMs: 5000
    };

    const result = validator.validate(payload);

    assert.strictEqual(result.valid, true);
    assert.ok(result.data);
    assert.strictEqual(result.data.opponent, 'Test Player');
    assert.strictEqual(result.data.league, 'Gold');
    assert.strictEqual(result.data.durationMs, 5000);
  });

  test('defaults arena to false when not provided', () => {
    const payload = {
      match_id: '2001',
      result: 'WIN',
      order: 0,
      timestamp: new Date().toISOString()
    };

    const result = validator.validate(payload);

    assert.strictEqual(result.valid, true);
    assert.ok(result.data);
    assert.strictEqual(result.data.arena, false);
  });

  test('quick validation returns match_id for valid payload', () => {
    const payload = {
      match_id: '2001',
      result: 'WIN',
      order: 0,
      timestamp: new Date().toISOString()
    };

    const result = validator.quickValidate(payload);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.matchId, '2001');
  });

  test('quick validation fails for payload without match_id', () => {
    const payload = {
      result: 'WIN'
    };

    const result = validator.quickValidate(payload);

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.matchId, undefined);
  });
});

suite('MatchIndexManager Tests', () => {
  let indexManager: MatchIndexManager;

  setup(() => {
    indexManager = new MatchIndexManager();
  });

  function createMockRecord(
    matchId: string,
    result: 'WIN' | 'LOSE' | 'DRAW',
    order: 0 | 1,
    arena: boolean = false
  ): MatchRecord {
    return {
      matchId,
      filename: `${result}_${order}_${matchId}.json`,
      filepath: `/tmp/${result}_${order}_${matchId}.json`,
      result,
      order,
      arena,
      timestamp: new Date().toISOString(),
      storedAt: new Date().toISOString(),
      fileSize: 1024
    };
  }

  test('starts with empty index', () => {
    assert.strictEqual(indexManager.size(), 0);
  });

  test('adds record successfully', () => {
    const record = createMockRecord('2001', 'WIN', 0);
    indexManager.add(record);

    assert.strictEqual(indexManager.size(), 1);
    assert.strictEqual(indexManager.has('2001'), true);
  });

  test('retrieves added record', () => {
    const record = createMockRecord('2001', 'WIN', 0);
    indexManager.add(record);

    const retrieved = indexManager.get('2001');

    assert.ok(retrieved);
    assert.strictEqual(retrieved.matchId, '2001');
    assert.strictEqual(retrieved.result, 'WIN');
  });

  test('removes record successfully', () => {
    const record = createMockRecord('2001', 'WIN', 0);
    indexManager.add(record);

    const removed = indexManager.remove('2001');

    assert.strictEqual(removed, true);
    assert.strictEqual(indexManager.size(), 0);
    assert.strictEqual(indexManager.has('2001'), false);
  });

  test('returns false when removing non-existent record', () => {
    const removed = indexManager.remove('non-existent');
    assert.strictEqual(removed, false);
  });

  test('calculates statistics correctly', () => {
    indexManager.add(createMockRecord('2001', 'WIN', 0));
    indexManager.add(createMockRecord('2002', 'WIN', 1));
    indexManager.add(createMockRecord('2003', 'LOSE', 0));
    indexManager.add(createMockRecord('2004', 'DRAW', 1));

    const stats = indexManager.getStats();

    assert.strictEqual(stats.totalMatches, 4);
    assert.strictEqual(stats.winCount, 2);
    assert.strictEqual(stats.loseCount, 1);
    assert.strictEqual(stats.drawCount, 1);
    assert.strictEqual(stats.winRate, 50); // 2 wins out of 4 = 50%
    assert.strictEqual(stats.firstPlayerCount, 2);
    assert.strictEqual(stats.secondPlayerCount, 2);
  });

  test('filters by result', () => {
    indexManager.add(createMockRecord('2001', 'WIN', 0));
    indexManager.add(createMockRecord('2002', 'LOSE', 0));
    indexManager.add(createMockRecord('2003', 'WIN', 1));

    const wins = indexManager.filterBy({ result: 'WIN' });

    assert.strictEqual(wins.length, 2);
    assert.ok(wins.every(r => r.result === 'WIN'));
  });

  test('filters by order', () => {
    indexManager.add(createMockRecord('2001', 'WIN', 0));
    indexManager.add(createMockRecord('2002', 'LOSE', 1));
    indexManager.add(createMockRecord('2003', 'WIN', 0));

    const firstPlayer = indexManager.filterBy({ order: 0 });

    assert.strictEqual(firstPlayer.length, 2);
    assert.ok(firstPlayer.every(r => r.order === 0));
  });

  test('filters by arena', () => {
    indexManager.add(createMockRecord('2001', 'WIN', 0, true));
    indexManager.add(createMockRecord('2002', 'LOSE', 0, false));
    indexManager.add(createMockRecord('2003', 'WIN', 1, true));

    const arenaMatches = indexManager.filterBy({ arena: true });

    assert.strictEqual(arenaMatches.length, 2);
    assert.ok(arenaMatches.every(r => r.arena === true));
  });

  test('gets recent matches', () => {
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      const record = createMockRecord(`200${i}`, 'WIN', 0);
      record.timestamp = new Date(now + i * 1000).toISOString();
      indexManager.add(record);
    }

    const recent = indexManager.getRecent(3);

    assert.strictEqual(recent.length, 3);
    // Most recent should be 2004
    assert.strictEqual(recent[2].matchId, '2004');
  });

  test('gets oldest matches', () => {
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      const record = createMockRecord(`200${i}`, 'WIN', 0);
      record.timestamp = new Date(now + i * 1000).toISOString();
      indexManager.add(record);
    }

    const oldest = indexManager.getOldest(3);

    assert.strictEqual(oldest.length, 3);
    // Oldest should be 2000
    assert.strictEqual(oldest[0].matchId, '2000');
  });

  test('clears all data', () => {
    indexManager.add(createMockRecord('2001', 'WIN', 0));
    indexManager.add(createMockRecord('2002', 'LOSE', 0));

    indexManager.clear();

    assert.strictEqual(indexManager.size(), 0);
    const stats = indexManager.getStats();
    assert.strictEqual(stats.totalMatches, 0);
  });

  test('bulk load optimizes insertion', () => {
    const records = [];
    for (let i = 0; i < 100; i++) {
      records.push(createMockRecord(`200${i}`, 'WIN', 0));
    }

    indexManager.bulkLoad(records);

    assert.strictEqual(indexManager.size(), 100);
  });

  test('updates existing record', () => {
    const record = createMockRecord('2001', 'WIN', 0);
    indexManager.add(record);

    const updated = { ...record, opponent: 'New Opponent' };
    const success = indexManager.update('2001', updated);

    assert.strictEqual(success, true);
    const retrieved = indexManager.get('2001');
    assert.strictEqual(retrieved?.opponent, 'New Opponent');
  });

  test('update fails for non-existent record', () => {
    const record = createMockRecord('2001', 'WIN', 0);
    const success = indexManager.update('non-existent', record);

    assert.strictEqual(success, false);
  });
});

suite('MatchStorageService Tests', () => {
  let service: MatchStorageService;
  let tempDir: string;
  let outputChannel: MockOutputChannel;
  let configService: MockConfigurationService;

  setup(async () => {
    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'match-test-'));

    // Create mocks
    outputChannel = new MockOutputChannel();
    configService = new MockConfigurationService();
    configService.setMatchesDirectory(tempDir);

    // Create service
    service = new MatchStorageService(configService as any, outputChannel as any);
    await service.initialize();
  });

  teardown(async () => {
    // Clean up
    service.dispose();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { }
  });

  function createValidPayload(matchId: string = '2001'): MatchPayload {
    return {
      match_id: matchId,
      result: 'WIN',
      order: 0,
      timestamp: new Date().toISOString(),
      arena: false
    };
  }

  test('stores valid payload successfully', async () => {
    const payload = createValidPayload('2001');
    const result = await service.storeMatchData(payload);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.matchId, '2001');
    assert.strictEqual(result.filename, 'WIN_0_2001.json');
    assert.ok(result.duration !== undefined);
  });

  test('creates file with correct name', async () => {
    const payload = createValidPayload('2001');
    await service.storeMatchData(payload);

    const filepath = path.join(tempDir, 'WIN_0_2001.json');
    const exists = await fs.access(filepath).then(() => true).catch(() => false);

    assert.strictEqual(exists, true);
  });

  test('file contains correct JSON', async () => {
    const payload = createValidPayload('2001');
    await service.storeMatchData(payload);

    const filepath = path.join(tempDir, 'WIN_0_2001.json');
    const content = await fs.readFile(filepath, 'utf8');
    const parsed = JSON.parse(content);

    assert.strictEqual(parsed.match_id, '2001');
    assert.strictEqual(parsed.result, 'WIN');
  });

  test('updates index after storing', async () => {
    const payload = createValidPayload('2001');
    await service.storeMatchData(payload);

    assert.strictEqual(service.isDuplicate('2001'), true);
    assert.strictEqual(service.getMatchCount(), 1);
  });

  test('rejects duplicate match_id', async () => {
    const payload = createValidPayload('2001');
    await service.storeMatchData(payload);

    const result2 = await service.storeMatchData(payload);

    assert.strictEqual(result2.success, false);
    assert.strictEqual(result2.reason, 'DUPLICATE');
  });

  test('rejects invalid payload', async () => {
    const payload = {
      result: 'WIN',
      order: 0
      // Missing match_id
    };

    const result = await service.storeMatchData(payload);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'VALIDATION_FAILED');
    assert.ok(result.errors);
  });

  test('retrieves stored match by ID', async () => {
    const payload = createValidPayload('2001');
    await service.storeMatchData(payload);

    const match = await service.getMatch('2001');

    assert.ok(match);
    assert.strictEqual(match.matchId, '2001');
    assert.strictEqual(match.result, 'WIN');
  });

  test('returns null for non-existent match', async () => {
    const match = await service.getMatch('non-existent');
    assert.strictEqual(match, null);
  });

  test('gets all matches', async () => {
    await service.storeMatchData(createValidPayload('2001'));
    await service.storeMatchData(createValidPayload('2002'));
    await service.storeMatchData(createValidPayload('2003'));

    const matches = await service.getAllMatches();

    assert.strictEqual(matches.length, 3);
  });

  test('filters matches by result', async () => {
    const payload1 = createValidPayload('2001');
    payload1.result = 'WIN';
    await service.storeMatchData(payload1);

    const payload2 = createValidPayload('2002');
    payload2.result = 'LOSE';
    await service.storeMatchData(payload2);

    const wins = await service.getAllMatches({ result: 'WIN' });

    assert.strictEqual(wins.length, 1);
    assert.strictEqual(wins[0].result, 'WIN');
  });

  test('rebuilds index from filesystem', async () => {
    // Store matches
    await service.storeMatchData(createValidPayload('2001'));
    await service.storeMatchData(createValidPayload('2002'));

    // Clear service and create new one
    service.dispose();
    service = new MatchStorageService(configService as any, outputChannel as any);
    await service.initialize();

    // Index should be rebuilt
    assert.strictEqual(service.getMatchCount(), 2);
    assert.strictEqual(service.isDuplicate('2001'), true);
    assert.strictEqual(service.isDuplicate('2002'), true);
  });

  test('deletes match successfully', async () => {
    await service.storeMatchData(createValidPayload('2001'));

    const deleted = await service.deleteMatch('2001');

    assert.strictEqual(deleted, true);
    assert.strictEqual(service.getMatchCount(), 0);

    const filepath = path.join(tempDir, 'WIN_0_2001.json');
    const exists = await fs.access(filepath).then(() => true).catch(() => false);
    assert.strictEqual(exists, false);
  });

  test('delete returns false for non-existent match', async () => {
    const deleted = await service.deleteMatch('non-existent');
    assert.strictEqual(deleted, false);
  });

  test('clears all matches', async () => {
    await service.storeMatchData(createValidPayload('2001'));
    await service.storeMatchData(createValidPayload('2002'));
    await service.storeMatchData(createValidPayload('2003'));

    const deleted = await service.clearAll();

    assert.strictEqual(deleted, 3);
    assert.strictEqual(service.getMatchCount(), 0);
  });

  test('gets statistics', async () => {
    const payload1 = createValidPayload('2001');
    payload1.result = 'WIN';
    await service.storeMatchData(payload1);

    const payload2 = createValidPayload('2002');
    payload2.result = 'LOSE';
    await service.storeMatchData(payload2);

    const stats = service.getStatistics();

    assert.strictEqual(stats.totalMatches, 2);
    assert.strictEqual(stats.winCount, 1);
    assert.strictEqual(stats.loseCount, 1);
    assert.strictEqual(stats.winRate, 50);
  });

  test('sanitizes match_id in filename', async () => {
    const payload = createValidPayload('test/match:123');
    const result = await service.storeMatchData(payload);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.filename, 'WIN_0_test_match_123.json');
  });

  test('emits event when match is stored', async () => {
    let eventFired = false;
    let eventData: any = null;

    service.onMatchStored(event => {
      eventFired = true;
      eventData = event;
    });

    await service.storeMatchData(createValidPayload('2001'));

    assert.strictEqual(eventFired, true);
    assert.strictEqual(eventData.type, 'match_stored');
    assert.strictEqual(eventData.matchId, '2001');
  });

  test('reprocesses matches successfully', async () => {
    await service.storeMatchData(createValidPayload('2001'));
    await service.storeMatchData(createValidPayload('2002'));

    const result = await service.reprocessMatches(['2001', '2002']);

    assert.strictEqual(result.processed, 2);
    assert.strictEqual(result.errors, 0);
  });
});
