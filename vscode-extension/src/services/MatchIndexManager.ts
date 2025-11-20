/**
 * Match Index Manager
 *
 * Manages in-memory index of match records for fast lookups, statistics,
 * and filtering without filesystem operations.
 *
 * Task 2.4: Match Data Storage
 */

import { MatchRecord, IndexStats, MatchFilter } from '../models/MatchRecord';

export class MatchIndexManager {
  private index: Map<string, MatchRecord>;
  private sortedByTimestamp: MatchRecord[];
  private stats: IndexStats;

  constructor() {
    this.index = new Map();
    this.sortedByTimestamp = [];
    this.stats = this.initStats();
  }

  /**
   * Initialize empty statistics
   */
  private initStats(): IndexStats {
    return {
      totalMatches: 0,
      winCount: 0,
      loseCount: 0,
      drawCount: 0,
      winRate: 0,
      firstPlayerCount: 0,
      secondPlayerCount: 0,
      arenaCount: 0,
      soloCount: 0,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Add a match record to the index
   */
  add(record: MatchRecord): void {
    // Add to map
    this.index.set(record.matchId, record);

    // Update sorted array (insert in order)
    const insertIndex = this.findInsertionPoint(record.timestamp);
    this.sortedByTimestamp.splice(insertIndex, 0, record);

    // Update statistics
    this.updateStats(record, 'add');
  }

  /**
   * Remove a match record from the index
   */
  remove(matchId: string): boolean {
    const record = this.index.get(matchId);
    if (!record) {
      return false;
    }

    // Remove from map
    this.index.delete(matchId);

    // Remove from sorted array
    const sortedIndex = this.sortedByTimestamp.findIndex(r => r.matchId === matchId);
    if (sortedIndex !== -1) {
      this.sortedByTimestamp.splice(sortedIndex, 1);
    }

    // Update statistics
    this.updateStats(record, 'remove');

    return true;
  }

  /**
   * Check if a match ID exists in the index
   */
  has(matchId: string): boolean {
    return this.index.has(matchId);
  }

  /**
   * Get a match record by ID
   */
  get(matchId: string): MatchRecord | undefined {
    return this.index.get(matchId);
  }

  /**
   * Get all match records
   */
  getAll(): MatchRecord[] {
    return Array.from(this.index.values());
  }

  /**
   * Get the N most recent matches
   */
  getRecent(count: number): MatchRecord[] {
    return this.sortedByTimestamp.slice(-count);
  }

  /**
   * Get the N oldest matches
   */
  getOldest(count: number): MatchRecord[] {
    return this.sortedByTimestamp.slice(0, count);
  }

  /**
   * Filter matches by predicate
   */
  filter(predicate: (record: MatchRecord) => boolean): MatchRecord[] {
    return this.getAll().filter(predicate);
  }

  /**
   * Filter matches using structured filter criteria
   */
  filterBy(filter: MatchFilter): MatchRecord[] {
    let results = this.getAll();

    // Filter by result
    if (filter.result) {
      const allowedResults = filter.result.split(',') as Array<'WIN' | 'LOSE' | 'DRAW'>;
      results = results.filter(r => allowedResults.includes(r.result));
    }

    // Filter by order
    if (filter.order !== undefined) {
      results = results.filter(r => r.order === filter.order);
    }

    // Filter by arena
    if (filter.arena !== undefined) {
      results = results.filter(r => r.arena === filter.arena);
    }

    // Filter by opponent
    if (filter.opponent) {
      const opponentLower = filter.opponent.toLowerCase();
      results = results.filter(r => r.opponent?.toLowerCase().includes(opponentLower));
    }

    // Filter by league
    if (filter.league) {
      const leagueLower = filter.league.toLowerCase();
      results = results.filter(r => r.league?.toLowerCase() === leagueLower);
    }

    // Filter by date range
    if (filter.dateFrom) {
      const fromDate = new Date(filter.dateFrom);
      results = results.filter(r => new Date(r.timestamp) >= fromDate);
    }

    if (filter.dateTo) {
      const toDate = new Date(filter.dateTo);
      results = results.filter(r => new Date(r.timestamp) <= toDate);
    }

    // Filter by tags
    if (filter.tags && filter.tags.length > 0) {
      results = results.filter(r => {
        if (!r.tags || r.tags.length === 0) {
          return false;
        }
        return filter.tags!.some(tag => r.tags!.includes(tag));
      });
    }

    // Filter by reviewed status
    if (filter.reviewed !== undefined) {
      results = results.filter(r => r.reviewed === filter.reviewed);
    }

    // Sort by timestamp (newest first)
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Apply pagination
    if (filter.offset !== undefined) {
      results = results.slice(filter.offset);
    }

    if (filter.limit !== undefined) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  /**
   * Get current statistics
   */
  getStats(): IndexStats {
    return { ...this.stats };
  }

  /**
   * Get match count
   */
  size(): number {
    return this.index.size;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.index.clear();
    this.sortedByTimestamp = [];
    this.stats = this.initStats();
  }

  /**
   * Update a match record (replace existing)
   */
  update(matchId: string, record: MatchRecord): boolean {
    const existing = this.index.get(matchId);
    if (!existing) {
      return false;
    }

    // Remove old record stats
    this.updateStats(existing, 'remove');

    // Update map
    this.index.set(matchId, record);

    // Update sorted array
    const sortedIndex = this.sortedByTimestamp.findIndex(r => r.matchId === matchId);
    if (sortedIndex !== -1) {
      this.sortedByTimestamp[sortedIndex] = record;
    }

    // Add new record stats
    this.updateStats(record, 'add');

    return true;
  }

  /**
   * Bulk load matches (optimized for initialization)
   */
  bulkLoad(records: MatchRecord[]): void {
    // Clear existing data
    this.clear();

    // Add all records
    for (const record of records) {
      this.index.set(record.matchId, record);
    }

    // Sort once at the end
    this.sortedByTimestamp = Array.from(this.index.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Recalculate stats
    this.recalculateStats();
  }

  /**
   * Find insertion point for sorted array (binary search)
   */
  private findInsertionPoint(timestamp: string): number {
    const targetTime = new Date(timestamp).getTime();
    let left = 0;
    let right = this.sortedByTimestamp.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      const midTime = new Date(this.sortedByTimestamp[mid].timestamp).getTime();

      if (midTime < targetTime) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    return left;
  }

  /**
   * Update statistics incrementally
   */
  private updateStats(record: MatchRecord, action: 'add' | 'remove'): void {
    const delta = action === 'add' ? 1 : -1;

    this.stats.totalMatches += delta;

    // Update result counts
    switch (record.result) {
      case 'WIN':
        this.stats.winCount += delta;
        break;
      case 'LOSE':
        this.stats.loseCount += delta;
        break;
      case 'DRAW':
        this.stats.drawCount += delta;
        break;
    }

    // Update order counts
    if (record.order === 0) {
      this.stats.firstPlayerCount += delta;
    } else {
      this.stats.secondPlayerCount += delta;
    }

    // Update arena/solo counts
    if (record.arena) {
      this.stats.arenaCount += delta;
    } else {
      this.stats.soloCount += delta;
    }

    // Recalculate win rate
    const totalFinished = this.stats.winCount + this.stats.loseCount + this.stats.drawCount;
    this.stats.winRate = totalFinished > 0 ? (this.stats.winCount / totalFinished) * 100 : 0;

    // Update oldest/newest
    if (this.sortedByTimestamp.length > 0) {
      this.stats.oldestMatch = this.sortedByTimestamp[0].timestamp;
      this.stats.newestMatch = this.sortedByTimestamp[this.sortedByTimestamp.length - 1].timestamp;
    } else {
      this.stats.oldestMatch = undefined;
      this.stats.newestMatch = undefined;
    }

    this.stats.lastUpdated = new Date().toISOString();
  }

  /**
   * Recalculate all statistics from scratch
   */
  private recalculateStats(): void {
    this.stats = this.initStats();

    for (const record of this.index.values()) {
      this.stats.totalMatches++;

      switch (record.result) {
        case 'WIN':
          this.stats.winCount++;
          break;
        case 'LOSE':
          this.stats.loseCount++;
          break;
        case 'DRAW':
          this.stats.drawCount++;
          break;
      }

      if (record.order === 0) {
        this.stats.firstPlayerCount++;
      } else {
        this.stats.secondPlayerCount++;
      }

      if (record.arena) {
        this.stats.arenaCount++;
      } else {
        this.stats.soloCount++;
      }
    }

    // Calculate win rate
    const totalFinished = this.stats.winCount + this.stats.loseCount + this.stats.drawCount;
    this.stats.winRate = totalFinished > 0 ? (this.stats.winCount / totalFinished) * 100 : 0;

    // Update oldest/newest
    if (this.sortedByTimestamp.length > 0) {
      this.stats.oldestMatch = this.sortedByTimestamp[0].timestamp;
      this.stats.newestMatch = this.sortedByTimestamp[this.sortedByTimestamp.length - 1].timestamp;
    }

    this.stats.lastUpdated = new Date().toISOString();
  }

  /**
   * Export index to plain object (for serialization)
   */
  export(): { records: MatchRecord[]; stats: IndexStats } {
    return {
      records: Array.from(this.index.values()),
      stats: this.getStats()
    };
  }

  /**
   * Get summary statistics as string
   */
  getSummary(): string {
    const stats = this.stats;
    return [
      `Total Matches: ${stats.totalMatches}`,
      `Win Rate: ${stats.winRate.toFixed(1)}%`,
      `W/L/D: ${stats.winCount}/${stats.loseCount}/${stats.drawCount}`,
      `First/Second: ${stats.firstPlayerCount}/${stats.secondPlayerCount}`,
      `Arena/Solo: ${stats.arenaCount}/${stats.soloCount}`
    ].join(' | ');
  }
}
