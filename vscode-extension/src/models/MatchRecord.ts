/**
 * Match Record Types and Interfaces
 *
 * Defines data structures for match storage, validation, and indexing.
 * Task 2.4: Match Data Storage
 */

/**
 * Match payload received from Chrome extension
 * This is the raw data structure sent over the bridge
 */
export interface MatchPayload {
  // Required fields
  match_id: string;
  result: "WIN" | "LOSE" | "DRAW";
  order: 0 | 1;
  timestamp: string; // ISO 8601 format

  // Optional metadata
  category?: string; // Subdirectory for organizing matches (e.g., team name)
  arena?: boolean;
  opponent?: string;
  league?: string;
  durationMs?: number;

  // Game data
  gameResult?: {
    scores?: Record<string, number>;
    summary?: string;
    rank?: number;
  };

  // Logs
  logs?: {
    stdout?: string[];
    stderr?: string[];
  };

  // Additional context
  metadata?: Record<string, unknown>;

  // Delivery tracking
  deliveryId?: string;
}

/**
 * Match record stored in index
 * This is the normalized structure used internally
 */
export interface MatchRecord {
  // Core identification
  matchId: string;
  filename: string;

  // Match details
  result: "WIN" | "LOSE" | "DRAW";
  order: 0 | 1;
  arena: boolean;

  // Context
  category?: string; // Category/group for organizing matches (e.g., team name)
  opponent?: string;
  league?: string;
  durationMs?: number;

  // Timestamps
  timestamp: string; // Match completion time (from payload)
  storedAt: string; // Storage time (when written to disk)

  // File info
  fileSize: number;
  filepath: string;

  // Computed/user-managed
  reviewed?: boolean;
  tags?: string[];
  notes?: string;
}

/**
 * Result of a store operation
 */
export interface StoreResult {
  success: boolean;
  matchId?: string;
  filename?: string;
  duration?: number; // Storage time in ms
  reason?: StoreFailureReason;
  errors?: string[];
  error?: string;
}

/**
 * Reasons for storage failure
 */
export type StoreFailureReason =
  | "VALIDATION_FAILED"
  | "DUPLICATE"
  | "WRITE_FAILED"
  | "INTERNAL_ERROR"
  | "DIRECTORY_NOT_FOUND";

/**
 * Schema validation result
 */
export interface ValidationResult {
  valid: boolean;
  data?: MatchPayload;
  errors?: string[];
}

/**
 * Events emitted by MatchStorageService
 */
export interface MatchStorageEvent {
  type: "match_stored" | "match_deleted" | "index_rebuilt" | "rotation_applied";
  matchId?: string;
  filename?: string;
  record?: MatchRecord;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Statistics computed from match index
 */
export interface IndexStats {
  totalMatches: number;
  winCount: number;
  loseCount: number;
  drawCount: number;
  winRate: number; // Percentage
  firstPlayerCount: number; // order === 0
  secondPlayerCount: number; // order === 1
  arenaCount: number;
  soloCount: number;
  lastUpdated: string;
  oldestMatch?: string; // timestamp
  newestMatch?: string; // timestamp
}

/**
 * Filter criteria for match queries
 */
export interface MatchFilter {
  result?: "WIN" | "LOSE" | "DRAW" | "WIN,LOSE" | "WIN,DRAW" | "LOSE,DRAW";
  order?: 0 | 1;
  arena?: boolean;
  opponent?: string;
  league?: string;
  dateFrom?: string; // ISO 8601
  dateTo?: string; // ISO 8601
  tags?: string[];
  reviewed?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Result of a reprocess operation
 */
export interface ReprocessResult {
  processed: number;
  errors: number;
  errorDetails: Array<{ matchId: string; error: string }>;
}

/**
 * Rotation policy configuration
 */
export interface RotationPolicy {
  enabled: boolean;
  maxMatches?: number;
  maxAgeDays?: number;
  strategy: "oldest" | "by_result" | "keep_wins";
}

/**
 * Integrity check report
 */
export interface IntegrityReport {
  totalFiles: number;
  validFiles: number;
  corruptedFiles: string[];
  missingFromIndex: string[];
  orphanedInIndex: string[];
  timestamp: string;
}

/**
 * Write operation result
 */
export interface WriteResult {
  success: boolean;
  error?: string;
  bytesWritten?: number;
}

/**
 * Configuration change event
 */
export interface ConfigChangeEvent {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  scope: number; // vscode.ConfigurationTarget
}

/**
 * Helper type for match result
 */
export type MatchResult = "WIN" | "LOSE" | "DRAW";

/**
 * Helper type for player order
 */
export type PlayerOrder = 0 | 1;
