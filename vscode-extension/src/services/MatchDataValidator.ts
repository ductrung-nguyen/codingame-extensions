/**
 * Match Data Validator
 *
 * Validates incoming match payloads from Chrome extension and normalizes data.
 * Ensures data integrity before storage.
 *
 * Task 2.4: Match Data Storage
 */

import { MatchPayload, ValidationResult } from '../models/MatchRecord';

export class MatchDataValidator {
  /**
   * Validate a match payload against the expected schema
   */
  validate(payload: unknown): ValidationResult {
    const errors: string[] = [];

    // Type check
    if (typeof payload !== 'object' || payload === null) {
      return {
        valid: false,
        errors: ['Payload must be an object']
      };
    }

    const data = payload as Record<string, unknown>;

    // Validate required fields
    errors.push(...this.validateRequiredFields(data));

    // Validate field types and values
    errors.push(...this.validateFieldTypes(data));

    // Validate field constraints
    errors.push(...this.validateConstraints(data));

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // Normalize and return
    const normalized = this.normalizePayload(data);
    return {
      valid: true,
      data: normalized
    };
  }

  /**
   * Validate that all required fields are present
   */
  private validateRequiredFields(data: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const requiredFields = ['match_id', 'result', 'order', 'timestamp'];

    for (const field of requiredFields) {
      if (!(field in data)) {
        errors.push(`Missing required field: ${field}`);
      } else if (data[field] === null || data[field] === undefined) {
        errors.push(`Required field cannot be null or undefined: ${field}`);
      }
    }

    return errors;
  }

  /**
   * Validate field types
   */
  private validateFieldTypes(data: Record<string, unknown>): string[] {
    const errors: string[] = [];

    // match_id must be string
    if ('match_id' in data && typeof data.match_id !== 'string') {
      errors.push(`match_id must be a string, got ${typeof data.match_id}`);
    }

    // result must be string
    if ('result' in data && typeof data.result !== 'string') {
      errors.push(`result must be a string, got ${typeof data.result}`);
    }

    // order must be number
    if ('order' in data && typeof data.order !== 'number') {
      errors.push(`order must be a number, got ${typeof data.order}`);
    }

    // timestamp must be string
    if ('timestamp' in data && typeof data.timestamp !== 'string') {
      errors.push(`timestamp must be a string, got ${typeof data.timestamp}`);
    }

    // Optional fields type validation
    if ('arena' in data && data.arena !== null && typeof data.arena !== 'boolean') {
      errors.push(`arena must be a boolean, got ${typeof data.arena}`);
    }

    if ('opponent' in data && data.opponent !== null && typeof data.opponent !== 'string') {
      errors.push(`opponent must be a string, got ${typeof data.opponent}`);
    }

    if ('league' in data && data.league !== null && typeof data.league !== 'string') {
      errors.push(`league must be a string, got ${typeof data.league}`);
    }

    if ('durationMs' in data && data.durationMs !== null && typeof data.durationMs !== 'number') {
      errors.push(`durationMs must be a number, got ${typeof data.durationMs}`);
    }

    return errors;
  }

  /**
   * Validate field value constraints
   */
  private validateConstraints(data: Record<string, unknown>): string[] {
    const errors: string[] = [];

    // match_id must be non-empty
    if ('match_id' in data && typeof data.match_id === 'string') {
      if (data.match_id.length === 0) {
        errors.push('match_id must be a non-empty string');
      }
      if (data.match_id.length > 256) {
        errors.push('match_id must be less than 256 characters');
      }
    }

    // result must be valid enum value
    if ('result' in data && typeof data.result === 'string') {
      const validResults = ['WIN', 'LOSE', 'DRAW'];
      if (!validResults.includes(data.result)) {
        errors.push(`Invalid result: ${data.result} (must be WIN, LOSE, or DRAW)`);
      }
    }

    // order must be 0 or 1
    if ('order' in data && typeof data.order === 'number') {
      if (![0, 1].includes(data.order)) {
        errors.push(`Invalid order: ${data.order} (must be 0 or 1)`);
      }
    }

    // timestamp must be valid ISO 8601
    if ('timestamp' in data && typeof data.timestamp === 'string') {
      if (!this.isValidTimestamp(data.timestamp)) {
        errors.push(`Invalid timestamp format: ${data.timestamp} (must be ISO 8601)`);
      }
    }

    // durationMs must be non-negative
    if ('durationMs' in data && typeof data.durationMs === 'number') {
      if (data.durationMs < 0) {
        errors.push(`durationMs must be non-negative, got ${data.durationMs}`);
      }
    }

    return errors;
  }

  /**
   * Normalize payload to standard format
   */
  private normalizePayload(data: Record<string, unknown>): MatchPayload {
    const normalized: MatchPayload = {
      match_id: String(data.match_id),
      result: data.result as 'WIN' | 'LOSE' | 'DRAW',
      order: Number(data.order) as 0 | 1,
      timestamp: String(data.timestamp)
    };

    // Normalize optional fields
    if ('arena' in data && data.arena !== null && data.arena !== undefined) {
      normalized.arena = Boolean(data.arena);
    } else {
      // Default to false if not specified
      normalized.arena = false;
    }

    if ('opponent' in data && data.opponent) {
      normalized.opponent = String(data.opponent).trim();
    }

    if ('league' in data && data.league) {
      normalized.league = String(data.league).trim();
    }

    if ('durationMs' in data && data.durationMs !== null && data.durationMs !== undefined) {
      normalized.durationMs = Number(data.durationMs);
    }

    // Normalize nested objects
    if ('gameResult' in data && typeof data.gameResult === 'object' && data.gameResult !== null) {
      normalized.gameResult = this.normalizeGameResult(data.gameResult as Record<string, unknown>);
    }

    if ('logs' in data && typeof data.logs === 'object' && data.logs !== null) {
      normalized.logs = this.normalizeLogs(data.logs as Record<string, unknown>);
    }

    if ('metadata' in data && typeof data.metadata === 'object' && data.metadata !== null) {
      normalized.metadata = data.metadata as Record<string, unknown>;
    }

    if ('deliveryId' in data && data.deliveryId) {
      normalized.deliveryId = String(data.deliveryId);
    }

    return normalized;
  }

  /**
   * Normalize game result object
   */
  private normalizeGameResult(gameResult: Record<string, unknown>): MatchPayload['gameResult'] {
    const normalized: MatchPayload['gameResult'] = {};

    if ('scores' in gameResult && typeof gameResult.scores === 'object' && gameResult.scores !== null) {
      normalized.scores = gameResult.scores as Record<string, number>;
    }

    if ('summary' in gameResult && gameResult.summary) {
      normalized.summary = String(gameResult.summary);
    }

    if ('rank' in gameResult && typeof gameResult.rank === 'number') {
      normalized.rank = gameResult.rank;
    }

    return normalized;
  }

  /**
   * Normalize logs object
   */
  private normalizeLogs(logs: Record<string, unknown>): MatchPayload['logs'] {
    const normalized: MatchPayload['logs'] = {};

    if ('stdout' in logs) {
      if (Array.isArray(logs.stdout)) {
        normalized.stdout = logs.stdout.map(line => String(line));
      } else if (typeof logs.stdout === 'string') {
        // Split string into lines
        normalized.stdout = logs.stdout.split('\n');
      }
    }

    if ('stderr' in logs) {
      if (Array.isArray(logs.stderr)) {
        normalized.stderr = logs.stderr.map(line => String(line));
      } else if (typeof logs.stderr === 'string') {
        // Split string into lines
        normalized.stderr = logs.stderr.split('\n');
      }
    }

    return normalized;
  }

  /**
   * Validate ISO 8601 timestamp format
   */
  private isValidTimestamp(timestamp: string): boolean {
    try {
      const date = new Date(timestamp);
      // Check if date is valid and can be converted back to ISO string
      return !isNaN(date.getTime()) && date.toISOString().startsWith(timestamp.substring(0, 10));
    } catch {
      return false;
    }
  }

  /**
   * Quick validation check for duplicate detection (lightweight)
   * Only checks if match_id exists and is valid
   */
  quickValidate(payload: unknown): { valid: boolean; matchId?: string } {
    if (typeof payload !== 'object' || payload === null) {
      return { valid: false };
    }

    const data = payload as Record<string, unknown>;

    if (!('match_id' in data) || typeof data.match_id !== 'string' || data.match_id.length === 0) {
      return { valid: false };
    }

    return {
      valid: true,
      matchId: data.match_id
    };
  }
}
