/**
 * Match Storage Service
 *
 * Core service for persisting match data from Chrome extension, maintaining
 * an in-memory index, and providing query/management capabilities.
 *
 * Features:
 * - Atomic file writes with temp + rename pattern
 * - Schema validation before storage
 * - Duplicate detection via in-memory index
 * - Event emission for UI synchronization
 * - Rotation policy for automatic cleanup
 * - Index rebuild and integrity checking
 * - Failed payload tracking for recovery (Task 2.7)
 *
 * Task 2.4: Match Data Storage
 * Task 2.7: Diagnostic & Recovery Commands
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import {
  MatchPayload,
  MatchRecord,
  StoreResult,
  MatchStorageEvent,
  MatchFilter,
  ReprocessResult,
  RotationPolicy,
  IntegrityReport,
  WriteResult,
} from "../models/MatchRecord";
import { MatchDataValidator } from "./MatchDataValidator";
import { MatchIndexManager } from "./MatchIndexManager";
import { ConfigurationService } from "./ConfigurationService";
import { FailedPayload } from "../diagnostics/types";

export class MatchStorageService implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private storageEmitter = new vscode.EventEmitter<MatchStorageEvent>();
  private validator: MatchDataValidator;
  private indexManager: MatchIndexManager;
  private matchesDirectory: string;
  private isInitialized: boolean = false;

  // Failed payload tracking (Task 2.7)
  private failedPayloads: FailedPayload[] = [];
  private readonly MAX_FAILED_PAYLOADS = 100;

  public readonly onMatchStored = this.storageEmitter.event;

  constructor(
    private configService: ConfigurationService,
    private outputChannel: vscode.OutputChannel,
  ) {
    this.validator = new MatchDataValidator();
    this.indexManager = new MatchIndexManager();
    this.matchesDirectory = "";

    this.disposables.push(this.storageEmitter);

    // Listen for configuration changes
    this.disposables.push(
      this.configService.onConfigChange((event) => {
        if (event.key === "codingame.matches.directory") {
          this.handleDirectoryChange(event.newValue as string);
        }
      }),
    );
  }

  /**
   * Initialize the storage service
   * Loads configuration and rebuilds index if needed
   */
  async initialize(): Promise<void> {
    this.log("[MATCH] Initializing match storage service...");

    try {
      // Get matches directory from configuration
      this.matchesDirectory = this.configService.getMatchesDirectory();

      // Create directory if it doesn't exist
      if (!existsSync(this.matchesDirectory)) {
        this.log(
          `[MATCH] Directory does not exist, creating: ${this.matchesDirectory}`,
        );
        await fs.mkdir(this.matchesDirectory, { recursive: true });
        this.log(`[MATCH] Directory created successfully`);
      }

      // Auto-rebuild index if configured
      const autoReindex = this.configService.get<boolean>(
        "matches.autoReindex",
        true,
      );
      if (autoReindex) {
        await this.rebuildIndex();
      }

      this.isInitialized = true;
      this.log("[MATCH] Storage service initialized successfully");
      this.log(`[MATCH] Directory: ${this.matchesDirectory}`);
      this.log(`[MATCH] Index size: ${this.indexManager.size()} matches`);
    } catch (error) {
      this.log(`[MATCH] Initialization failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Store a match payload
   * Main entry point for receiving data from bridge
   */
  async storeMatchData(payload: unknown): Promise<StoreResult> {
    if (!this.isInitialized) {
      return {
        success: false,
        reason: "INTERNAL_ERROR",
        error: "Storage service not initialized",
      };
    }

    const startTime = Date.now();

    try {
      // Step 1: Validate schema
      const validationResult = this.validator.validate(payload);
      if (!validationResult.valid) {
        this.log(
          `[MATCH] Validation failed: ${validationResult.errors?.join(", ")}`,
        );
        return {
          success: false,
          reason: "VALIDATION_FAILED",
          errors: validationResult.errors,
        };
      }

      const matchData = validationResult.data as MatchPayload;

      // Step 2: Check for duplicates (considering category)
      const category = matchData.category || "";
      if (this.isDuplicate(matchData.match_id, category)) {
        const categoryInfo = category ? ` in category '${category}'` : "";
        this.log(
          `[MATCH] Duplicate detected: ${matchData.match_id}${categoryInfo} (dropped)`,
        );
        return {
          success: false,
          reason: "DUPLICATE",
          matchId: matchData.match_id,
        };
      }

      // Step 3: Determine target directory based on category
      let targetDirectory = this.matchesDirectory;

      if (category) {
        // Create subdirectory for category
        targetDirectory = path.join(this.matchesDirectory, category);
        if (!existsSync(targetDirectory)) {
          this.log(`[MATCH] Creating category directory: ${category}`);
          await fs.mkdir(targetDirectory, { recursive: true });
        }
      }

      // Step 4: Generate filename
      const filename = this.generateFilename(matchData);
      const filepath = path.join(targetDirectory, filename);

      // Step 5: Atomic write
      const writeResult = await this.atomicWrite(filepath, matchData);
      if (!writeResult.success) {
        // Track failed payload for recovery (Task 2.7)
        this.trackFailedPayload(matchData, writeResult.error || "WRITE_FAILED");
        return {
          success: false,
          reason: "WRITE_FAILED",
          error: writeResult.error,
        };
      }

      // Step 6: Create match record
      const record = await this.createMatchRecord(
        matchData,
        filename,
        filepath,
      );

      // Step 7: Update index
      this.indexManager.add(record);

      // Step 8: Emit event
      this.storageEmitter.fire({
        type: "match_stored",
        matchId: matchData.match_id,
        filename,
        record,
        timestamp: new Date().toISOString(),
      });

      const duration = Date.now() - startTime;
      const displayPath = category ? `${category}/${filename}` : filename;
      this.log(`[MATCH] Stored ${displayPath} (${duration}ms)`);

      // Step 9: Check rotation policy
      if (this.shouldApplyRotation()) {
        this.applyRotationPolicy().catch((err) => {
          this.log(`[MATCH] Rotation failed: ${err.message}`);
        });
      }

      return {
        success: true,
        matchId: matchData.match_id,
        filename,
        duration,
      };
    } catch (error) {
      this.log(`[MATCH] Unexpected error: ${(error as Error).message}`);

      // Track failed payload for recovery (Task 2.7)
      if (payload && typeof payload === "object" && "match_id" in payload) {
        this.trackFailedPayload(
          payload as MatchPayload,
          (error as Error).message,
        );
      }

      return {
        success: false,
        reason: "INTERNAL_ERROR",
        error: (error as Error).message,
      };
    }
  }

  /**
   * Check if a match ID already exists
   */
  isDuplicate(matchId: string, category?: string): boolean {
    // If category is specified, check for match in that specific category
    if (category) {
      const categoryKey = `${category}:${matchId}`;
      return this.indexManager.has(categoryKey);
    }
    // Otherwise, check if match exists in any category
    return this.indexManager.has(matchId);
  }

  /**
   * Get a match by ID
   */
  async getMatch(matchId: string): Promise<MatchRecord | null> {
    return this.indexManager.get(matchId) || null;
  }

  /**
   * Get all matches with optional filtering
   */
  async getAllMatches(filter?: MatchFilter): Promise<MatchRecord[]> {
    if (filter) {
      return this.indexManager.filterBy(filter);
    }
    return this.indexManager.getAll();
  }

  /**
   * Get recent matches
   */
  getRecentMatches(count: number = 10): MatchRecord[] {
    return this.indexManager.getRecent(count);
  }

  /**
   * Get match statistics
   */
  getStatistics() {
    return this.indexManager.getStats();
  }

  /**
   * Get match count
   */
  getMatchCount(): number {
    return this.indexManager.size();
  }

  /**
   * Get a match record by ID
   */
  get(matchId: string): MatchRecord | undefined {
    return this.indexManager.get(matchId);
  }

  /**
   * Get all match records
   */
  getAll(): MatchRecord[] {
    return this.indexManager.getAll();
  }

  /**
   * Rebuild index from filesystem
   */
  async rebuildIndex(): Promise<void> {
    this.log("[MATCH] Rebuilding index from filesystem...");

    const startTime = Date.now();
    this.indexManager.clear();

    try {
      let processed = 0;
      let errors = 0;

      // Helper function to scan a directory for JSON files
      const scanDirectory = async (dirPath: string, category: string = "") => {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);

          if (entry.isDirectory()) {
            // Recursively scan subdirectory (category folder)
            await scanDirectory(fullPath, entry.name);
          } else if (
            entry.isFile() &&
            entry.name.endsWith(".json") &&
            !entry.name.startsWith(".")
          ) {
            // Process JSON file
            try {
              const content = await fs.readFile(fullPath, "utf8");
              const matchData = JSON.parse(content) as MatchPayload;

              // Ensure category is set from directory structure if not in payload
              if (category && !matchData.category) {
                matchData.category = category;
              }

              const record = await this.createMatchRecord(
                matchData,
                entry.name,
                fullPath,
              );
              this.indexManager.add(record);
              processed++;
            } catch (error) {
              const displayPath = category
                ? `${category}/${entry.name}`
                : entry.name;
              this.log(
                `[MATCH] Failed to index ${displayPath}: ${(error as Error).message}`,
              );
              errors++;
            }
          }
        }
      };

      // Start scanning from the matches directory
      await scanDirectory(this.matchesDirectory);

      const duration = Date.now() - startTime;
      this.log(
        `[MATCH] Index rebuilt: ${processed} matches, ${errors} errors (${duration}ms)`,
      );
      this.log(`[MATCH] ${this.indexManager.getSummary()}`);

      // Emit rebuild complete event
      this.storageEmitter.fire({
        type: "index_rebuilt",
        timestamp: new Date().toISOString(),
        metadata: {
          matchCount: processed,
          errorCount: errors,
        },
      });
    } catch (error) {
      this.log(`[MATCH] Index rebuild failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Reprocess matches (re-validate and update index)
   */
  async reprocessMatches(matchIds?: string[]): Promise<ReprocessResult> {
    const targetIds =
      matchIds || Array.from(this.indexManager.getAll().map((r) => r.matchId));

    let processed = 0;
    let errors = 0;
    const errorDetails: Array<{ matchId: string; error: string }> = [];

    for (const matchId of targetIds) {
      try {
        const record = this.indexManager.get(matchId);
        if (!record) {
          throw new Error("Match not found in index");
        }

        const content = await fs.readFile(record.filepath, "utf8");
        const matchData = JSON.parse(content) as MatchPayload;

        // Re-validate
        const validationResult = this.validator.validate(matchData);
        if (!validationResult.valid) {
          throw new Error(
            `Validation failed: ${validationResult.errors?.join(", ")}`,
          );
        }

        // Update index with fresh data
        const updatedRecord = await this.createMatchRecord(
          matchData,
          record.filename,
          record.filepath,
        );
        this.indexManager.update(matchId, updatedRecord);
        processed++;
      } catch (error) {
        this.log(
          `[MATCH] Reprocess failed for ${matchId}: ${(error as Error).message}`,
        );
        errors++;
        errorDetails.push({ matchId, error: (error as Error).message });
      }
    }

    this.log(`[MATCH] Reprocessed ${processed} matches (${errors} errors)`);

    return {
      processed,
      errors,
      errorDetails,
    };
  }

  /**
   * Delete a match
   */
  async deleteMatch(matchId: string): Promise<boolean> {
    const record = this.indexManager.get(matchId);
    if (!record) {
      return false;
    }

    try {
      // Delete file
      await fs.unlink(record.filepath);

      // Remove from index
      this.indexManager.remove(matchId);

      // Emit event
      this.storageEmitter.fire({
        type: "match_deleted",
        matchId,
        filename: record.filename,
        timestamp: new Date().toISOString(),
      });

      this.log(`[MATCH] Deleted ${record.filename}`);
      return true;
    } catch (error) {
      this.log(
        `[MATCH] Failed to delete ${matchId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Clear all matches
   */
  async clearAll(): Promise<number> {
    const matches = this.indexManager.getAll();
    let deleted = 0;

    for (const record of matches) {
      if (await this.deleteMatch(record.matchId)) {
        deleted++;
      }
    }

    this.log(`[MATCH] Cleared ${deleted} matches`);
    return deleted;
  }

  /**
   * Apply rotation policy
   */
  async applyRotationPolicy(): Promise<number> {
    const policy = this.getRotationPolicy();

    if (!policy.enabled) {
      return 0;
    }

    const matches = this.indexManager.getAll();
    let toDelete: MatchRecord[] = [];

    // Strategy 1: Max matches limit
    if (policy.maxMatches && matches.length > policy.maxMatches) {
      const oldest = this.indexManager.getOldest(
        matches.length - policy.maxMatches,
      );
      toDelete = [...toDelete, ...oldest];
    }

    // Strategy 2: Age-based cleanup
    if (policy.maxAgeDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - policy.maxAgeDays);

      const oldMatches = matches.filter(
        (m) => new Date(m.timestamp) < cutoffDate,
      );

      toDelete = [...toDelete, ...oldMatches];
    }

    // Strategy 3: Keep wins only
    if (policy.strategy === "keep_wins") {
      const losesAndDraws = matches.filter((m) => m.result !== "WIN");
      toDelete = [...toDelete, ...losesAndDraws];
    }

    // Deduplicate
    const uniqueToDelete = Array.from(new Set(toDelete.map((r) => r.matchId)))
      .map((id) => this.indexManager.get(id))
      .filter((r) => r !== undefined) as MatchRecord[];

    // Delete
    for (const record of uniqueToDelete) {
      await this.deleteMatch(record.matchId);
    }

    if (uniqueToDelete.length > 0) {
      this.log(`[MATCH] Rotation: deleted ${uniqueToDelete.length} matches`);

      this.storageEmitter.fire({
        type: "rotation_applied",
        timestamp: new Date().toISOString(),
        metadata: {
          deletedCount: uniqueToDelete.length,
          policy,
        },
      });
    }

    return uniqueToDelete.length;
  }

  /**
   * Validate integrity of storage
   */
  async validateIntegrity(): Promise<IntegrityReport> {
    this.log("[MATCH] Validating storage integrity...");

    const report: IntegrityReport = {
      totalFiles: 0,
      validFiles: 0,
      corruptedFiles: [],
      missingFromIndex: [],
      orphanedInIndex: [],
      timestamp: new Date().toISOString(),
    };

    try {
      // Get all files
      const files = await fs.readdir(this.matchesDirectory);
      const jsonFiles = files.filter(
        (f) => f.endsWith(".json") && !f.startsWith("."),
      );
      report.totalFiles = jsonFiles.length;

      // Check each file
      for (const filename of jsonFiles) {
        try {
          const filepath = path.join(this.matchesDirectory, filename);
          const content = await fs.readFile(filepath, "utf8");
          const matchData = JSON.parse(content) as MatchPayload;

          // Validate
          const validationResult = this.validator.validate(matchData);
          if (validationResult.valid) {
            report.validFiles++;

            // Check if in index
            if (!this.indexManager.has(matchData.match_id)) {
              report.missingFromIndex.push(filename);
            }
          } else {
            report.corruptedFiles.push(filename);
          }
        } catch (error) {
          report.corruptedFiles.push(filename);
        }
      }

      // Check for orphaned index entries
      const indexedMatches = this.indexManager.getAll();
      for (const record of indexedMatches) {
        if (!existsSync(record.filepath)) {
          report.orphanedInIndex.push(record.matchId);
        }
      }

      this.log(
        `[MATCH] Integrity check: ${report.validFiles}/${report.totalFiles} valid, ${report.corruptedFiles.length} corrupted, ${report.missingFromIndex.length} missing from index`,
      );
    } catch (error) {
      this.log(`[MATCH] Integrity check failed: ${(error as Error).message}`);
    }

    return report;
  }

  /**
   * Export index to file
   */
  async exportIndex(filepath: string): Promise<void> {
    const data = this.indexManager.export();
    const json = JSON.stringify(data, null, 2);
    await fs.writeFile(filepath, json, "utf8");
    this.log(`[MATCH] Index exported to ${filepath}`);
  }

  /**
   * Get matches directory path
   */
  getDirectory(): string {
    return this.matchesDirectory;
  }

  /**
   * Generate filename from match data
   */
  private generateFilename(matchData: MatchPayload): string {
    const { result, order, match_id } = matchData;

    // Sanitize match_id to ensure filesystem safety
    const safeMatchId = match_id.replace(/[^a-zA-Z0-9_-]/g, "_");

    // Format: <RESULT>_<ORDER>_<MATCH_ID>.json
    return `${result}_${order}_${safeMatchId}.json`;
  }

  /**
   * Atomic write using temp file + rename
   */
  private async atomicWrite(
    filepath: string,
    data: MatchPayload,
  ): Promise<WriteResult> {
    const tempPath = `${filepath}.tmp`;

    try {
      // Write to temporary file
      const jsonContent = JSON.stringify(data, null, 2);
      await fs.writeFile(tempPath, jsonContent, "utf8");

      // Verify write succeeded
      const stats = await fs.stat(tempPath);
      if (stats.size === 0) {
        throw new Error("Temporary file is empty");
      }

      // Atomic rename
      await fs.rename(tempPath, filepath);

      return {
        success: true,
        bytesWritten: stats.size,
      };
    } catch (error) {
      // Cleanup temp file if it exists
      try {
        await fs.unlink(tempPath);
      } catch {}

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Create match record from payload
   */
  private async createMatchRecord(
    matchData: MatchPayload,
    filename: string,
    filepath: string,
  ): Promise<MatchRecord> {
    const stats = await fs.stat(filepath);

    // Create a unique key that includes category for proper indexing
    const category = matchData.category || "";
    const indexKey = category
      ? `${category}:${matchData.match_id}`
      : matchData.match_id;

    return {
      matchId: indexKey,
      filename,
      filepath,
      result: matchData.result,
      order: matchData.order,
      arena: matchData.arena || false,
      category: category || undefined,
      opponent: matchData.opponent,
      league: matchData.league,
      durationMs: matchData.durationMs,
      timestamp: matchData.timestamp,
      storedAt: new Date(stats.mtime).toISOString(),
      fileSize: stats.size,
    };
  }

  /**
   * Get rotation policy from configuration
   */
  private getRotationPolicy(): RotationPolicy {
    return {
      enabled: this.configService.get<boolean>(
        "matches.rotation.enabled",
        false,
      ),
      maxMatches: this.configService.get<number>("matches.rotation.maxMatches"),
      maxAgeDays: this.configService.get<number>("matches.rotation.maxAgeDays"),
      strategy: this.configService.get<"oldest" | "by_result" | "keep_wins">(
        "matches.rotation.strategy",
        "oldest",
      ),
    };
  }

  /**
   * Check if rotation should be applied
   */
  private shouldApplyRotation(): boolean {
    const policy = this.getRotationPolicy();
    if (!policy.enabled) {
      return false;
    }

    // Apply after every 10 matches stored
    return this.indexManager.size() % 10 === 0;
  }

  /**
   * Handle directory configuration change
   */
  private async handleDirectoryChange(newDirectory: string): Promise<void> {
    if (newDirectory === this.matchesDirectory) {
      return;
    }

    this.log(`[MATCH] Directory changed: ${newDirectory}`);
    this.matchesDirectory = newDirectory;

    // Rebuild index for new directory
    if (existsSync(newDirectory)) {
      await this.rebuildIndex();
    } else {
      this.log(`[MATCH] New directory does not exist: ${newDirectory}`);
      this.indexManager.clear();
    }
  }

  /**
   * Log message to output channel
   */
  private log(message: string): void {
    this.outputChannel.appendLine(message);
  }

  /**
   * Dispose resources
   */
  /**
   * Track failed payload for recovery (Task 2.7)
   */
  private trackFailedPayload(payload: MatchPayload, error: string): void {
    const failedPayload: FailedPayload = {
      payload,
      timestamp: new Date().toISOString(),
      attempts: 1,
      lastError: error,
    };

    // Check if this payload already exists (update attempts)
    const existingIndex = this.failedPayloads.findIndex(
      (fp) => fp.payload.deliveryId === payload.deliveryId,
    );

    if (existingIndex >= 0) {
      this.failedPayloads[existingIndex].attempts++;
      this.failedPayloads[existingIndex].lastError = error;
      this.failedPayloads[existingIndex].timestamp = new Date().toISOString();
    } else {
      this.failedPayloads.push(failedPayload);

      // Trim if exceeds max
      if (this.failedPayloads.length > this.MAX_FAILED_PAYLOADS) {
        this.failedPayloads.shift();
      }
    }

    this.updateFailedMatchesContext();
    this.log(
      `[MATCH] Failed payload tracked: deliveryId=${payload.deliveryId}, attempts=${failedPayload.attempts}`,
    );
  }

  /**
   * Get all failed payloads (Task 2.7)
   */
  getFailedPayloads(): FailedPayload[] {
    return [...this.failedPayloads];
  }

  /**
   * Clear specific failed payload (Task 2.7)
   */
  clearFailedPayload(deliveryId: string): void {
    const before = this.failedPayloads.length;
    this.failedPayloads = this.failedPayloads.filter(
      (fp) => fp.payload.deliveryId !== deliveryId,
    );
    const after = this.failedPayloads.length;

    if (before !== after) {
      this.updateFailedMatchesContext();
      this.log(`[MATCH] Cleared failed payload: deliveryId=${deliveryId}`);
    }
  }

  /**
   * Clear all failed payloads (Task 2.7)
   */
  clearFailedPayloads(): void {
    const count = this.failedPayloads.length;
    this.failedPayloads = [];
    this.updateFailedMatchesContext();
    this.log(`[MATCH] Cleared ${count} failed payload(s)`);
  }

  /**
   * Update VS Code context for failed matches (Task 2.7)
   */
  private updateFailedMatchesContext(): void {
    vscode.commands.executeCommand(
      "setContext",
      "codingame.hasFailedMatches",
      this.failedPayloads.length > 0,
    );
  }

  /**
   * Get count of failed payloads (Task 2.7)
   */
  getFailedPayloadsCount(): number {
    return this.failedPayloads.length;
  }

  /**
   * Clear all match files (Task 2.7)
   */
  async clearAllMatches(): Promise<number> {
    try {
      const files = await fs.readdir(this.matchesDirectory);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      let deletedCount = 0;
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.matchesDirectory, file);
          await fs.unlink(filePath);
          deletedCount++;
        } catch (error) {
          this.log(
            `[MATCH] Failed to delete ${file}: ${(error as Error).message}`,
          );
        }
      }

      // Clear index
      this.indexManager.clear();

      this.log(`[MATCH] Cleared ${deletedCount} match file(s)`);
      return deletedCount;
    } catch (error) {
      this.log(`[MATCH] Failed to clear matches: ${(error as Error).message}`);
      return 0;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.indexManager.clear();
    this.failedPayloads = [];
  }
}
