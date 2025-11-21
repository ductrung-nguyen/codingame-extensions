/**
 * Unit Tests for StatisticsWebviewProvider
 *
 * Tests for Task 2.5: Statistics Webview Interactions
 * Covers all core functionality including statistics computation,
 * filtering, message handling, and integration with MatchStorageService.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { StatisticsWebviewProvider } from '../../webview/StatisticsWebviewProvider';
import { MatchRecord, MatchStorageEvent } from '../../models/MatchRecord';

suite('StatisticsWebviewProvider Tests', () => {
  let provider: StatisticsWebviewProvider;
  let mockContext: vscode.ExtensionContext;
  let mockMatchStorage: MockMatchStorageService;
  let mockOutputChannel: vscode.OutputChannel;
  let globalState: Map<string, any>;

  setup(() => {
    // Create mock global state
    globalState = new Map();

    // Create mock context
    mockContext = {
      subscriptions: [],
      workspaceState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => []
      },
      globalState: {
        get: (key: string) => globalState.get(key),
        update: (key: string, value: any) => {
          globalState.set(key, value);
          return Promise.resolve();
        },
        keys: () => Array.from(globalState.keys()),
        setKeysForSync: () => { }
      },
      extensionUri: vscode.Uri.file('/mock/extension/path'),
      extensionPath: '/mock/extension/path',
      storagePath: '/mock/storage',
      globalStoragePath: '/mock/global/storage',
      logPath: '/mock/log',
      extensionMode: vscode.ExtensionMode.Development,
      extension: {} as any,
      secrets: {} as any,
      storageUri: undefined,
      globalStorageUri: vscode.Uri.file('/mock/global/storage'),
      logUri: vscode.Uri.file('/mock/log'),
      environmentVariableCollection: {} as any,
      languageModelAccessInformation: {} as any,
      asAbsolutePath: (relativePath: string) => path.join('/mock/extension/path', relativePath)
    } as any as vscode.ExtensionContext;

    // Create mock output channel
    mockOutputChannel = {
      name: 'CodinGame Test',
      append: () => { },
      appendLine: () => { },
      clear: () => { },
      show: () => { },
      hide: () => { },
      dispose: () => { },
      replace: () => { }
    } as vscode.OutputChannel;

    // Create mock match storage service
    mockMatchStorage = new MockMatchStorageService();

    // Create provider
    provider = new StatisticsWebviewProvider(
      mockContext,
      mockMatchStorage as any,
      mockOutputChannel
    );
  });

  teardown(() => {
    provider.dispose();
    globalState.clear();
  });

  suite('Statistics Computation', () => {
    test('should compute correct statistics for empty dataset', async () => {
      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.summary.totalMatches, 0);
      assert.strictEqual(data.summary.wins, 0);
      assert.strictEqual(data.summary.losses, 0);
      assert.strictEqual(data.summary.draws, 0);
      assert.strictEqual(data.summary.winRate, 0);
      assert.strictEqual(data.summary.firstPlayerWinRate, 0);
      assert.strictEqual(data.summary.arenaMatches, 0);
      assert.strictEqual(data.summary.soloMatches, 0);
      assert.strictEqual(data.summary.avgDuration, 0);
      assert.strictEqual(data.matches.length, 0);
      assert.strictEqual(data.opponents.length, 0);
    });

    test('should compute correct statistics for single match', async () => {
      mockMatchStorage.addMatch({
        matchId: '1001',
        filename: 'WIN_0_1001.json',
        filepath: '/path/WIN_0_1001.json',
        fileSize: 1024,
        storedAt: new Date().toISOString(),
        result: 'WIN',
        order: 0,
        arena: true,
        opponent: 'TestOpponent',
        league: 'Gold',
        durationMs: 5000,
        timestamp: new Date().toISOString()
      });

      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.summary.totalMatches, 1);
      assert.strictEqual(data.summary.wins, 1);
      assert.strictEqual(data.summary.losses, 0);
      assert.strictEqual(data.summary.draws, 0);
      assert.strictEqual(data.summary.winRate, 100);
      assert.strictEqual(data.summary.firstPlayerWinRate, 100);
      assert.strictEqual(data.summary.arenaMatches, 1);
      assert.strictEqual(data.summary.soloMatches, 0);
      assert.strictEqual(data.summary.avgDuration, 5000);
      assert.strictEqual(data.matches.length, 1);
      assert.strictEqual(data.opponents.length, 1);
      assert.strictEqual(data.opponents[0].opponent, 'TestOpponent');
      assert.strictEqual(data.opponents[0].wins, 1);
    });

    test('should compute correct win rate for multiple matches', async () => {
      // Add 3 wins and 2 losses (60% win rate)
      for (let i = 0; i < 3; i++) {
        mockMatchStorage.addMatch(createMockMatch(`win${i}`, 'WIN', 0, true));
      }
      for (let i = 0; i < 2; i++) {
        mockMatchStorage.addMatch(createMockMatch(`loss${i}`, 'LOSE', 1, true));
      }

      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.summary.totalMatches, 5);
      assert.strictEqual(data.summary.wins, 3);
      assert.strictEqual(data.summary.losses, 2);
      assert.strictEqual(data.summary.winRate, 60);
    });

    test('should compute correct first player win rate', async () => {
      // First player: 2 wins, 1 loss (66.67% win rate)
      mockMatchStorage.addMatch(createMockMatch('1', 'WIN', 0, true));
      mockMatchStorage.addMatch(createMockMatch('2', 'WIN', 0, true));
      mockMatchStorage.addMatch(createMockMatch('3', 'LOSE', 0, true));
      // Second player: 1 win, 1 loss
      mockMatchStorage.addMatch(createMockMatch('4', 'WIN', 1, true));
      mockMatchStorage.addMatch(createMockMatch('5', 'LOSE', 1, true));

      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.summary.totalMatches, 5);
      assert.strictEqual(data.summary.firstPlayerWinRate, (2 / 3) * 100);
    });

    test('should distinguish arena vs solo matches', async () => {
      mockMatchStorage.addMatch(createMockMatch('1', 'WIN', 0, true));
      mockMatchStorage.addMatch(createMockMatch('2', 'WIN', 0, true));
      mockMatchStorage.addMatch(createMockMatch('3', 'LOSE', 0, false));

      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.summary.arenaMatches, 2);
      assert.strictEqual(data.summary.soloMatches, 1);
    });

    test('should compute average duration correctly', async () => {
      mockMatchStorage.addMatch(createMockMatch('1', 'WIN', 0, true, 2000));
      mockMatchStorage.addMatch(createMockMatch('2', 'LOSE', 0, true, 4000));
      mockMatchStorage.addMatch(createMockMatch('3', 'WIN', 0, true, 6000));

      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.summary.avgDuration, 4000);
    });

    test('should aggregate opponent statistics', async () => {
      mockMatchStorage.addMatch(createMockMatch('1', 'WIN', 0, true, 1000, 'Opponent1'));
      mockMatchStorage.addMatch(createMockMatch('2', 'LOSE', 0, true, 1000, 'Opponent1'));
      mockMatchStorage.addMatch(createMockMatch('3', 'WIN', 0, true, 1000, 'Opponent2'));

      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.opponents.length, 2);

      const opp1 = data.opponents.find((o: any) => o.opponent === 'Opponent1');
      assert.ok(opp1);
      assert.strictEqual(opp1.matches, 2);
      assert.strictEqual(opp1.wins, 1);
      assert.strictEqual(opp1.losses, 1);
      assert.strictEqual(opp1.winRate, 50);

      const opp2 = data.opponents.find((o: any) => o.opponent === 'Opponent2');
      assert.ok(opp2);
      assert.strictEqual(opp2.matches, 1);
      assert.strictEqual(opp2.wins, 1);
    });

    test('should sort matches by timestamp descending', async () => {
      const now = new Date();
      mockMatchStorage.addMatch(createMockMatch('1', 'WIN', 0, true, 1000, 'A', new Date(now.getTime() - 3000).toISOString()));
      mockMatchStorage.addMatch(createMockMatch('2', 'WIN', 0, true, 1000, 'B', new Date(now.getTime() - 1000).toISOString()));
      mockMatchStorage.addMatch(createMockMatch('3', 'WIN', 0, true, 1000, 'C', new Date(now.getTime() - 2000).toISOString()));

      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.matches[0].matchId, '2'); // Most recent
      assert.strictEqual(data.matches[1].matchId, '3');
      assert.strictEqual(data.matches[2].matchId, '1'); // Oldest
    });
  });

  suite('Filter Application', () => {
    setup(() => {
      // Add diverse dataset
      mockMatchStorage.addMatch(createMockMatch('1', 'WIN', 0, true, 1000, 'Opponent1', '2024-01-01T00:00:00Z', 'Gold'));
      mockMatchStorage.addMatch(createMockMatch('2', 'LOSE', 1, true, 2000, 'Opponent2', '2024-01-02T00:00:00Z', 'Silver'));
      mockMatchStorage.addMatch(createMockMatch('3', 'WIN', 0, false, 3000, null, '2024-01-03T00:00:00Z', 'Gold'));
      mockMatchStorage.addMatch(createMockMatch('4', 'DRAW', 1, true, 4000, 'Opponent1', '2024-01-04T00:00:00Z', 'Bronze'));
      mockMatchStorage.addMatch(createMockMatch('5', 'WIN', 1, true, 5000, 'Opponent3', '2024-01-05T00:00:00Z', 'Gold'));
    });

    test('should filter by result', async () => {
      const filters = { result: 'WIN' as const };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 3);
      data.matches.forEach((m: any) => assert.strictEqual(m.result, 'WIN'));
    });

    test('should filter by order', async () => {
      const filters = { order: 0 };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 2);
      data.matches.forEach((m: any) => assert.strictEqual(m.order, 0));
    });

    test('should filter by arena type', async () => {
      const filters = { arena: true };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 4);
      data.matches.forEach((m: any) => assert.strictEqual(m.arena, true));
    });

    test('should filter by opponent', async () => {
      const filters = { opponent: 'Opponent1' };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 2);
      assert.ok(data.matches.every((m: any) => m.opponent?.includes('Opponent1')));
    });

    test('should filter by league', async () => {
      const filters = { league: 'Gold' };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 3);
      data.matches.forEach((m: any) => assert.ok(m.league?.includes('Gold')));
    });

    test('should filter by date range', async () => {
      const filters = {
        dateRange: {
          start: '2024-01-02T00:00:00Z',
          end: '2024-01-04T23:59:59Z'
        }
      };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 3); // Matches 2, 3, 4
      assert.ok(data.matches.some((m: any) => m.matchId === '2'));
      assert.ok(data.matches.some((m: any) => m.matchId === '3'));
      assert.ok(data.matches.some((m: any) => m.matchId === '4'));
    });

    test('should filter by search text', async () => {
      const filters = { searchText: 'Opponent2' };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 1);
      assert.strictEqual(data.matches[0].matchId, '2');
    });

    test('should apply multiple filters (AND logic)', async () => {
      const filters = {
        result: 'WIN' as const,
        order: 0
      };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 2); // Matches 1 and 3
      data.matches.forEach((m: any) => {
        assert.strictEqual(m.result, 'WIN');
        assert.strictEqual(m.order, 0);
      });
    });

    test('should return correct filter count', async () => {
      const filters = {
        result: 'WIN' as const,
        order: 0
      };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.filterCount, 2); // 2 matches pass filters
      assert.strictEqual(data.totalCount, 5); // Total in dataset
    });

    test('should handle empty filter results', async () => {
      const filters = {
        result: 'WIN' as const,
        opponent: 'NonExistent'
      };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 0);
      assert.strictEqual(data.summary.totalMatches, 0);
    });

    test('should recalculate summary for filtered data', async () => {
      const filters = { result: 'WIN' as const };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.summary.totalMatches, 3);
      assert.strictEqual(data.summary.wins, 3);
      assert.strictEqual(data.summary.losses, 0);
      assert.strictEqual(data.summary.winRate, 100);
    });
  });

  suite('Filter Persistence', () => {
    test('should save filters to global state', async () => {
      const filters = { result: 'WIN' as const, order: 0 };
      await (provider as any).persistFilters(filters);

      const stored = globalState.get('codingame.statistics.filters');
      assert.deepStrictEqual(stored, filters);
    });

    test('should load persisted filters on initialization', () => {
      const filters = { result: 'LOSE' as const, arena: true };
      globalState.set('codingame.statistics.filters', filters);

      const newProvider = new StatisticsWebviewProvider(
        mockContext,
        mockMatchStorage as any,
        mockOutputChannel
      );

      const loaded = (newProvider as any).currentFilters;
      assert.deepStrictEqual(loaded, filters);

      newProvider.dispose();
    });

    test('should return empty object when no filters persisted', () => {
      const loaded = (provider as any).loadPersistedFilters();
      assert.deepStrictEqual(loaded, {});
    });

    test('should update current filters when handling requestData', async () => {
      (provider as any).view = {
        webview: {
          postMessage: () => Promise.resolve(true)
        }
      };

      const filters = { result: 'DRAW' as const };
      await (provider as any).handleRequestData(filters);

      assert.deepStrictEqual((provider as any).currentFilters, filters);
    });
  });

  suite('Message Handling', () => {
    test('should handle webviewReady message', async () => {
      let postMessageCalled = false;
      let postedMessage: any = null;

      (provider as any).view = {
        webview: {
          postMessage: (msg: any) => {
            postMessageCalled = true;
            postedMessage = msg;
            return Promise.resolve(true);
          }
        }
      };

      await (provider as any).handleWebviewMessage({ type: 'webviewReady' });

      assert.strictEqual(postMessageCalled, true);
      assert.strictEqual(postedMessage.type, 'initializeFilters');
      assert.ok(postedMessage.filters);
    });

    test('should handle requestData message', async () => {
      let postMessageCalled = false;
      let postedMessage: any = null;

      (provider as any).view = {
        webview: {
          postMessage: (msg: any) => {
            postMessageCalled = true;
            postedMessage = msg;
            return Promise.resolve(true);
          }
        }
      };

      const filters = { result: 'WIN' as const };
      await (provider as any).handleWebviewMessage({
        type: 'requestData',
        filters: filters
      });

      assert.strictEqual(postMessageCalled, true);
      assert.strictEqual(postedMessage.type, 'dataResponse');
      assert.ok(postedMessage.data);
      assert.ok(postedMessage.timestamp);
      assert.strictEqual(typeof postedMessage.computeTime, 'number');
    });

    test('should persist filters on requestData', async () => {
      (provider as any).view = {
        webview: {
          postMessage: () => Promise.resolve(true)
        }
      };

      const filters = { result: 'LOSE' as const };
      await (provider as any).handleWebviewMessage({
        type: 'requestData',
        filters: filters
      });

      const stored = globalState.get('codingame.statistics.filters');
      assert.deepStrictEqual(stored, filters);
    });

    test('should handle clearFilters message', async () => {
      // Set some filters first
      await (provider as any).persistFilters({ result: 'WIN' as const });

      (provider as any).view = {
        webview: {
          postMessage: () => Promise.resolve(true)
        }
      };

      await (provider as any).handleWebviewMessage({ type: 'clearFilters' });

      const stored = globalState.get('codingame.statistics.filters');
      assert.deepStrictEqual(stored, {});
    });
  });

  suite('Real-Time Updates', () => {
    test('should handle match stored event', (done) => {
      let postMessageCalled = false;

      (provider as any).view = {
        webview: {
          postMessage: (msg: any) => {
            if (msg.type === 'matchAdded') {
              postMessageCalled = true;
              assert.strictEqual(msg.match.matchId, '9999');
              done();
            }
            return Promise.resolve(true);
          }
        }
      };

      const newMatch = createMockMatch('9999', 'WIN', 0, true);
      const event: MatchStorageEvent = {
        type: 'match_stored',
        matchId: '9999',
        record: newMatch,
        timestamp: new Date().toISOString()
      };

      mockMatchStorage.emit(event);

      // Wait for debounce (500ms + buffer)
      setTimeout(() => {
        if (!postMessageCalled) {
          done(new Error('postMessage was not called'));
        }
      }, 700);
    });

    test('should debounce rapid updates', (done) => {
      let callCount = 0;

      (provider as any).view = {
        webview: {
          postMessage: (msg: any) => {
            if (msg.type === 'matchAdded') {
              callCount++;
            }
            return Promise.resolve(true);
          }
        }
      };

      // Emit 3 events rapidly
      for (let i = 0; i < 3; i++) {
        const match = createMockMatch(`rapid${i}`, 'WIN', 0, true);
        mockMatchStorage.emit({
          type: 'match_stored',
          matchId: match.matchId,
          record: match,
          timestamp: new Date().toISOString()
        });
      }

      // Should only result in 1 postMessage call (last one)
      setTimeout(() => {
        assert.strictEqual(callCount, 1);
        done();
      }, 700);
    });

    test('should not send updates when view is not available', (done) => {
      let postMessageCalled = false;

      // No view set
      (provider as any).view = undefined;

      const match = createMockMatch('noview', 'WIN', 0, true);
      mockMatchStorage.emit({
        type: 'match_stored',
        matchId: match.matchId,
        record: match,
        timestamp: new Date().toISOString()
      });

      setTimeout(() => {
        assert.strictEqual(postMessageCalled, false);
        done();
      }, 700);
    });
  });

  suite('Edge Cases', () => {
    test('should handle matches without opponent', async () => {
      mockMatchStorage.addMatch(createMockMatch('solo1', 'WIN', 0, false, 1000, null));

      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.summary.totalMatches, 1);
      assert.strictEqual(data.opponents.length, 0); // No opponent to aggregate
    });

    test('should handle matches without duration', async () => {
      mockMatchStorage.addMatch(createMockMatch('noduration', 'WIN', 0, true, undefined));

      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.summary.avgDuration, 0);
    });

    test('should handle invalid date ranges gracefully', async () => {
      mockMatchStorage.addMatch(createMockMatch('1', 'WIN', 0, true, 1000, 'A', '2024-01-01T00:00:00Z'));

      const filters = {
        dateRange: {
          start: '2024-01-02T00:00:00Z',
          end: '2024-01-01T00:00:00Z' // End before start
        }
      };

      const data = await (provider as any).computeStatistics(filters);

      // Should return empty results (no matches in inverted range)
      assert.strictEqual(data.matches.length, 0);
    });

    test('should handle empty opponent name', async () => {
      mockMatchStorage.addMatch(createMockMatch('empty', 'WIN', 0, true, 1000, ''));

      const data = await (provider as any).computeStatistics({});

      assert.strictEqual(data.summary.totalMatches, 1);
      // Empty string opponent should not create opponent stat
      assert.strictEqual(data.opponents.length, 0);
    });

    test('should handle case-insensitive search', async () => {
      mockMatchStorage.addMatch(createMockMatch('1', 'WIN', 0, true, 1000, 'TestOpponent'));

      const filters = { searchText: 'testopponent' };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 1);
    });

    test('should handle mixed case league names', async () => {
      mockMatchStorage.addMatch(createMockMatch('1', 'WIN', 0, true, 1000, 'A', undefined, 'GoLd'));

      const filters = { league: 'gold' };
      const data = await (provider as any).computeStatistics(filters);

      assert.strictEqual(data.matches.length, 1);
    });
  });

  suite('Disposal', () => {
    test('should dispose resources', () => {
      const disposables: any[] = [];
      (provider as any).disposables = disposables;

      let disposed = false;
      disposables.push({
        dispose: () => { disposed = true; }
      });

      provider.dispose();

      assert.strictEqual(disposed, true);
    });

    test('should clear debounce timer on dispose', () => {
      (provider as any).updateDebounceTimer = setTimeout(() => { }, 10000);
      const timerId = (provider as any).updateDebounceTimer;

      provider.dispose();

      // Timer should be cleared
      assert.ok(timerId);
    });
  });
});

/**
 * Helper Functions
 */

function createMockMatch(
  id: string,
  result: 'WIN' | 'LOSE' | 'DRAW',
  order: 0 | 1,
  arena: boolean,
  durationMs?: number,
  opponent?: string | null,
  timestamp?: string,
  league?: string
): MatchRecord {
  return {
    matchId: id,
    filename: `${result}_${order}_${id}.json`,
    filepath: `/path/${result}_${order}_${id}.json`,
    fileSize: 1024,
    storedAt: new Date().toISOString(),
    result: result,
    order: order,
    arena: arena,
    opponent: opponent || undefined,
    league: league || undefined,
    durationMs: durationMs,
    timestamp: timestamp || new Date().toISOString()
  };
}

/**
 * Mock MatchStorageService
 */
class MockMatchStorageService {
  private matches: Map<string, MatchRecord> = new Map();
  private eventEmitter = new vscode.EventEmitter<MatchStorageEvent>();

  public readonly onMatchStored = this.eventEmitter.event;

  addMatch(match: MatchRecord): void {
    this.matches.set(match.matchId, match);
  }

  get(matchId: string): MatchRecord | undefined {
    return this.matches.get(matchId);
  }

  getAll(): MatchRecord[] {
    return Array.from(this.matches.values());
  }

  getDirectory(): string {
    return '/mock/matches/directory';
  }

  emit(event: MatchStorageEvent): void {
    this.eventEmitter.fire(event);
  }

  clear(): void {
    this.matches.clear();
  }
}
