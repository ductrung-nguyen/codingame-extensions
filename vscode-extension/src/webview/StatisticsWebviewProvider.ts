/**
 * Statistics Webview Provider
 *
 * Provides a comprehensive dashboard for visualizing and analyzing CodinGame match results.
 * Implements real-time statistics, advanced filtering, match detail views, and quick actions.
 *
 * Features:
 * - Real-time match statistics with summary cards
 * - Advanced filtering (time range, result, order, opponent, league)
 * - Filter persistence across sessions
 * - Sortable and paginated match table
 * - Match detail drawer with stdout/stderr preview
 * - One-click replay navigation
 * - Integration with MatchStorageService events
 *
 * Task 2.5: Statistics Webview Interactions
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { MatchStorageService } from '../services/MatchStorageService';
import { MatchRecord, MatchStorageEvent } from '../models/MatchRecord';

/**
 * Filter state for match data
 */
interface FilterState {
  result?: 'WIN' | 'LOSE' | 'DRAW' | null;
  order?: 0 | 1 | null;
  arena?: boolean | null;
  opponent?: string | null;
  league?: string | null;
  dateRange?: {
    start: string;
    end: string;
  } | null;
  searchText?: string;
}

/**
 * Statistics summary data
 */
interface StatisticsSummary {
  totalMatches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  firstPlayerWinRate: number;
  arenaMatches: number;
  soloMatches: number;
  avgDuration: number;
}

/**
 * Opponent statistics
 */
interface OpponentStat {
  opponent: string;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
}

/**
 * Complete statistics data sent to webview
 */
interface StatisticsData {
  summary: StatisticsSummary;
  matches: MatchRecord[];
  opponents: OpponentStat[];
  filterCount: number;
  totalCount: number;
  appliedFilters: FilterState;
}

/**
 * Match detail data with logs
 */
interface MatchDetailData extends MatchRecord {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/**
 * Messages from webview to extension
 */
type WebviewMessage =
  | { type: 'webviewReady' }
  | { type: 'requestData'; filters?: FilterState }
  | { type: 'openReplay'; matchId: string }
  | { type: 'requestMatchDetails'; matchId: string }
  | { type: 'revealFile'; matchId: string }
  | { type: 'copySummary'; summary: string }
  | { type: 'clearFilters' }
  | { type: 'exportCSV'; filters?: FilterState };

/**
 * Messages from extension to webview
 */
type ExtensionMessage =
  | { type: 'initializeFilters'; filters: FilterState }
  | { type: 'dataResponse'; data: StatisticsData; filters: FilterState; timestamp: string; computeTime: number }
  | { type: 'matchAdded'; match: MatchRecord; timestamp: string }
  | { type: 'matchDetails'; details: MatchDetailData }
  | { type: 'matchDetailsError'; matchId: string; error: string }
  | { type: 'replayOpened'; matchId: string; success: boolean; error?: string };

export class StatisticsWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private static readonly FILTER_STATE_KEY = 'codingame.statistics.filters';
  private static readonly MAX_LOG_SIZE = 10240; // 10KB

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private currentFilters: FilterState;
  private updateDebounceTimer?: NodeJS.Timeout;

  constructor(
    private context: vscode.ExtensionContext,
    private matchStorageService: MatchStorageService,
    private outputChannel: vscode.OutputChannel
  ) {
    this.currentFilters = this.loadPersistedFilters();

    // Subscribe to match storage events
    this.disposables.push(
      matchStorageService.onMatchStored((event) => {
        this.handleMatchStored(event);
      })
    );

    this.log('[WEBVIEW] Statistics provider initialized');
  }

  /**
   * Resolve webview view
   * Called when webview is first shown
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media')
      ]
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from webview
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(
        async (message: WebviewMessage) => {
          await this.handleWebviewMessage(message);
        }
      )
    );

    this.log('[WEBVIEW] Webview resolved');
  }

  /**
   * Handle incoming messages from webview
   */
  private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'webviewReady':
          await this.handleWebviewReady();
          break;

        case 'requestData':
          await this.handleRequestData(message.filters);
          break;

        case 'openReplay':
          await this.handleOpenReplay(message.matchId);
          break;

        case 'requestMatchDetails':
          await this.handleMatchDetails(message.matchId);
          break;

        case 'revealFile':
          await this.handleRevealFile(message.matchId);
          break;

        case 'copySummary':
          await this.handleCopySummary(message.summary);
          break;

        case 'clearFilters':
          await this.handleClearFilters();
          break;

        case 'exportCSV':
          await this.handleExportCSV(message.filters);
          break;

        default:
          this.log(`[WEBVIEW] Unknown message type: ${(message as any).type}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`[WEBVIEW] Error handling message: ${errorMessage}`);
      vscode.window.showErrorMessage(`CodinGame Statistics: ${errorMessage}`);
    }
  }

  /**
   * Handle webview ready signal
   */
  private async handleWebviewReady(): Promise<void> {
    this.log('[WEBVIEW] Webview ready, sending initial filters');

    this.postMessage({
      type: 'initializeFilters',
      filters: this.currentFilters
    });
  }

  /**
   * Handle data request with optional filters
   */
  private async handleRequestData(filters?: FilterState): Promise<void> {
    const startTime = Date.now();

    // Update and persist filters
    if (filters) {
      this.currentFilters = filters;
      await this.persistFilters(filters);
    }

    // Compute statistics
    const data = await this.computeStatistics(this.currentFilters);
    const computeTime = Date.now() - startTime;

    this.log(`[WEBVIEW] Data computed in ${computeTime}ms (${data.matches.length} matches)`);

    // Send response
    this.postMessage({
      type: 'dataResponse',
      data: data,
      filters: this.currentFilters,
      timestamp: new Date().toISOString(),
      computeTime: computeTime
    });
  }

  /**
   * Handle opening replay URL in browser
   */
  private async handleOpenReplay(matchId: string): Promise<void> {
    try {
      const replayUrl = `https://www.codingame.com/replay/${matchId}`;
      const uri = vscode.Uri.parse(replayUrl);

      const opened = await vscode.env.openExternal(uri);

      if (opened) {
        this.log(`[WEBVIEW] Opened replay: ${replayUrl}`);

        this.postMessage({
          type: 'replayOpened',
          matchId: matchId,
          success: true
        });
      } else {
        throw new Error('Failed to open external browser');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`[WEBVIEW] Error opening replay: ${errorMessage}`);

      // Offer to copy URL to clipboard
      const action = await vscode.window.showErrorMessage(
        `Failed to open replay for match ${matchId}`,
        'Copy URL'
      );

      if (action === 'Copy URL') {
        await vscode.env.clipboard.writeText(`https://www.codingame.com/replay/${matchId}`);
        vscode.window.showInformationMessage('Replay URL copied to clipboard');
      }

      this.postMessage({
        type: 'replayOpened',
        matchId: matchId,
        success: false,
        error: errorMessage
      });
    }
  }

  /**
   * Handle match details request
   */
  private async handleMatchDetails(matchId: string): Promise<void> {
    try {
      const match = this.matchStorageService.get(matchId);

      if (!match) {
        throw new Error(`Match ${matchId} not found`);
      }

      // Read match file for full payload
      const filePath = path.join(
        this.matchStorageService.getDirectory(),
        match.filename
      );

      const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      const fullPayload = JSON.parse(Buffer.from(fileContent).toString('utf-8'));

      // Extract stdout/stderr (limit to MAX_LOG_SIZE for UI)
      const stdout = fullPayload.logs?.stdout || 'No output';
      const stderr = fullPayload.logs?.stderr || 'No errors';

      const details: MatchDetailData = {
        ...match,
        stdout: stdout.substring(0, StatisticsWebviewProvider.MAX_LOG_SIZE),
        stderr: stderr.substring(0, StatisticsWebviewProvider.MAX_LOG_SIZE),
        stdoutTruncated: stdout.length > StatisticsWebviewProvider.MAX_LOG_SIZE,
        stderrTruncated: stderr.length > StatisticsWebviewProvider.MAX_LOG_SIZE
      };

      this.log(`[WEBVIEW] Loaded details for match ${matchId}`);

      this.postMessage({
        type: 'matchDetails',
        details: details
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`[WEBVIEW] Error loading match details: ${errorMessage}`);

      this.postMessage({
        type: 'matchDetailsError',
        matchId: matchId,
        error: errorMessage
      });
    }
  }

  /**
   * Handle reveal file in Explorer
   */
  private async handleRevealFile(matchId: string): Promise<void> {
    try {
      const match = this.matchStorageService.get(matchId);

      if (!match) {
        vscode.window.showWarningMessage(`Match ${matchId} not found`);
        return;
      }

      const filePath = path.join(
        this.matchStorageService.getDirectory(),
        match.filename
      );

      const uri = vscode.Uri.file(filePath);

      // Reveal in Explorer
      await vscode.commands.executeCommand('revealInExplorer', uri);

      this.log(`[WEBVIEW] Revealed file: ${filePath}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`[WEBVIEW] Error revealing file: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to reveal match file: ${errorMessage}`);
    }
  }

  /**
   * Handle copy summary to clipboard
   */
  private async handleCopySummary(summary: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(summary);
      this.log('[WEBVIEW] Summary copied to clipboard');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`[WEBVIEW] Error copying summary: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to copy summary: ${errorMessage}`);
    }
  }

  /**
   * Handle clear filters
   */
  private async handleClearFilters(): Promise<void> {
    this.currentFilters = {};
    await this.persistFilters({});
    await this.handleRequestData({});
    this.log('[WEBVIEW] Filters cleared');
  }

  /**
   * Handle export to CSV
   */
  private async handleExportCSV(filters?: FilterState): Promise<void> {
    try {
      const data = await this.computeStatistics(filters || this.currentFilters);

      // Generate CSV content
      const headers = ['Match ID', 'Result', 'Order', 'Arena', 'Opponent', 'League', 'Duration (ms)', 'Timestamp'];
      const rows = data.matches.map(m => [
        m.matchId,
        m.result,
        m.order.toString(),
        m.arena ? 'Arena' : 'Solo',
        m.opponent || 'N/A',
        m.league || 'N/A',
        (m.durationMs || 0).toString(),
        m.timestamp
      ]);

      const csv = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
      ].join('\n');

      // Prompt for save location
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('codingame-statistics.csv'),
        filters: {
          'CSV Files': ['csv']
        }
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf-8'));
        vscode.window.showInformationMessage(`Exported ${data.matches.length} matches to ${uri.fsPath}`);
        this.log(`[WEBVIEW] Exported CSV: ${uri.fsPath}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`[WEBVIEW] Error exporting CSV: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to export CSV: ${errorMessage}`);
    }
  }

  /**
   * Handle match stored event
   */
  private handleMatchStored(event: MatchStorageEvent): void {
    if (!this.view || !event.record) {
      return;
    }

    // Debounce rapid updates
    clearTimeout(this.updateDebounceTimer);

    this.updateDebounceTimer = setTimeout(() => {
      this.postMessage({
        type: 'matchAdded',
        match: event.record!,
        timestamp: new Date().toISOString()
      });

      this.log(`[WEBVIEW] Notified of new match: ${event.record!.matchId}`);
    }, 500);
  }

  /**
   * Compute statistics from matches
   */
  private async computeStatistics(filters: FilterState): Promise<StatisticsData> {
    const allMatches = this.matchStorageService.getAll();
    const filteredMatches = this.applyFilters(allMatches, filters);

    // Compute summary metrics
    const totalMatches = filteredMatches.length;
    const wins = filteredMatches.filter(m => m.result === 'WIN').length;
    const losses = filteredMatches.filter(m => m.result === 'LOSE').length;
    const draws = filteredMatches.filter(m => m.result === 'DRAW').length;

    const firstPlayerMatches = filteredMatches.filter(m => m.order === 0);
    const firstPlayerWins = firstPlayerMatches.filter(m => m.result === 'WIN').length;

    const arenaMatches = filteredMatches.filter(m => m.arena === true).length;
    const soloMatches = totalMatches - arenaMatches;

    // Calculate averages
    const avgDuration = totalMatches > 0
      ? filteredMatches.reduce((sum, m) => sum + (m.durationMs || 0), 0) / totalMatches
      : 0;

    // Group by opponent
    const opponentStats = new Map<string, OpponentStat>();
    filteredMatches.forEach(match => {
      if (!match.opponent) {
        return;
      }

      const stat = opponentStats.get(match.opponent) || {
        opponent: match.opponent,
        matches: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        winRate: 0
      };

      stat.matches++;
      if (match.result === 'WIN') {
        stat.wins++;
      } else if (match.result === 'LOSE') {
        stat.losses++;
      } else {
        stat.draws++;
      }

      stat.winRate = stat.matches > 0 ? (stat.wins / stat.matches) * 100 : 0;

      opponentStats.set(match.opponent, stat);
    });

    // Sort matches by timestamp descending
    const sortedMatches = filteredMatches.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return {
      summary: {
        totalMatches,
        wins,
        losses,
        draws,
        winRate: totalMatches > 0 ? (wins / totalMatches) * 100 : 0,
        firstPlayerWinRate: firstPlayerMatches.length > 0
          ? (firstPlayerWins / firstPlayerMatches.length) * 100
          : 0,
        arenaMatches,
        soloMatches,
        avgDuration
      },
      matches: sortedMatches,
      opponents: Array.from(opponentStats.values()).sort((a, b) => b.matches - a.matches),
      filterCount: filteredMatches.length,
      totalCount: allMatches.length,
      appliedFilters: filters
    };
  }

  /**
   * Apply filters to match list
   */
  private applyFilters(matches: MatchRecord[], filters: FilterState): MatchRecord[] {
    let filtered = [...matches];

    if (filters.result) {
      filtered = filtered.filter(m => m.result === filters.result);
    }

    if (filters.order !== undefined && filters.order !== null) {
      filtered = filtered.filter(m => m.order === filters.order);
    }

    if (filters.arena !== undefined && filters.arena !== null) {
      filtered = filtered.filter(m => m.arena === filters.arena);
    }

    if (filters.opponent) {
      filtered = filtered.filter(m =>
        m.opponent && m.opponent.toLowerCase().includes(filters.opponent!.toLowerCase())
      );
    }

    if (filters.league) {
      filtered = filtered.filter(m =>
        m.league && m.league.toLowerCase().includes(filters.league!.toLowerCase())
      );
    }

    if (filters.dateRange) {
      const start = new Date(filters.dateRange.start).getTime();
      const end = new Date(filters.dateRange.end).getTime();
      filtered = filtered.filter(m => {
        const matchTime = new Date(m.timestamp).getTime();
        return matchTime >= start && matchTime <= end;
      });
    }

    if (filters.searchText) {
      const searchLower = filters.searchText.toLowerCase();
      filtered = filtered.filter(m =>
        m.matchId.toLowerCase().includes(searchLower) ||
        (m.opponent && m.opponent.toLowerCase().includes(searchLower)) ||
        (m.league && m.league.toLowerCase().includes(searchLower))
      );
    }

    return filtered;
  }

  /**
   * Load persisted filters from global state
   */
  private loadPersistedFilters(): FilterState {
    const stored = this.context.globalState.get<FilterState>(
      StatisticsWebviewProvider.FILTER_STATE_KEY
    );

    return stored || {};
  }

  /**
   * Persist filters to global state
   */
  private async persistFilters(filters: FilterState): Promise<void> {
    await this.context.globalState.update(
      StatisticsWebviewProvider.FILTER_STATE_KEY,
      filters
    );

    this.log(`[WEBVIEW] Persisted filters: ${JSON.stringify(filters)}`);
  }

  /**
   * Post message to webview
   */
  private postMessage(message: ExtensionMessage): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * Get HTML content for webview
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'statistics.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'statistics.css')
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>CodinGame Statistics</title>
</head>
<body>
  <div class="container">
    <!-- Loading State -->
    <div id="loading-state" class="loading-state">
      <div class="spinner"></div>
      <p>Loading statistics...</p>
    </div>

    <!-- Main Content -->
    <div id="main-content" style="display: none;">
      <!-- Summary Cards -->
      <div id="summary-cards" class="summary-cards"></div>

      <!-- Filter Bar -->
      <div class="filter-bar">
        <div class="filter-group">
          <label for="filter-result">Result:</label>
          <select id="filter-result" class="filter-input">
            <option value="">All</option>
            <option value="WIN">Win</option>
            <option value="LOSE">Loss</option>
            <option value="DRAW">Draw</option>
          </select>
        </div>

        <div class="filter-group">
          <label for="filter-order">Player Order:</label>
          <select id="filter-order" class="filter-input">
            <option value="">All</option>
            <option value="0">First (0)</option>
            <option value="1">Second (1)</option>
          </select>
        </div>

        <div class="filter-group">
          <label for="filter-arena">Type:</label>
          <select id="filter-arena" class="filter-input">
            <option value="">All</option>
            <option value="true">Arena</option>
            <option value="false">Solo</option>
          </select>
        </div>

        <div class="filter-group filter-group-wide">
          <label for="filter-search">Search:</label>
          <input
            type="text"
            id="filter-search"
            class="filter-input"
            placeholder="Match ID, opponent, league..."
          />
        </div>

        <div class="filter-group">
          <label for="filter-date-start">Date Range:</label>
          <div class="date-range">
            <input type="date" id="filter-date-start" class="filter-input" />
            <span class="date-separator">to</span>
            <input type="date" id="filter-date-end" class="filter-input" />
          </div>
        </div>

        <button id="filter-reset" class="btn-secondary">Reset Filters</button>
        <button id="export-csv" class="btn-secondary">Export CSV</button>
      </div>

      <!-- Match Table -->
      <div class="table-container">
        <table id="match-table">
          <thead>
            <tr>
              <th data-sortable data-column="result">Result</th>
              <th data-sortable data-column="order">Order</th>
              <th data-sortable data-column="arena">Type</th>
              <th data-sortable data-column="opponent">Opponent</th>
              <th data-sortable data-column="league">League</th>
              <th data-sortable data-column="timestamp">Timestamp</th>
              <th data-sortable data-column="durationMs">Duration</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <!-- Detail Drawer -->
    <div id="detail-drawer" class="drawer" hidden>
      <div class="drawer-header">
        <h2 id="drawer-title">Match Details</h2>
        <button id="drawer-close" class="btn-icon">✕</button>
      </div>

      <div class="drawer-content">
        <div id="drawer-loading" class="loading-state" hidden>
          <div class="spinner"></div>
          <p>Loading match details...</p>
        </div>

        <div id="drawer-details" hidden>
          <!-- Match metadata -->
          <section class="detail-section">
            <h3>Match Information</h3>
            <dl class="detail-list">
              <dt>Match ID:</dt>
              <dd id="detail-match-id"></dd>

              <dt>Result:</dt>
              <dd id="detail-result" class="result-badge"></dd>

              <dt>Player Order:</dt>
              <dd id="detail-order"></dd>

              <dt>Type:</dt>
              <dd id="detail-type"></dd>

              <dt>Opponent:</dt>
              <dd id="detail-opponent"></dd>

              <dt>League:</dt>
              <dd id="detail-league"></dd>

              <dt>Duration:</dt>
              <dd id="detail-duration"></dd>

              <dt>Timestamp:</dt>
              <dd id="detail-timestamp"></dd>
            </dl>
          </section>

          <!-- Stdout logs -->
          <section class="detail-section">
            <h3>Standard Output</h3>
            <div class="log-viewer">
              <pre id="detail-stdout" class="log-content">No output</pre>
            </div>
          </section>

          <!-- Stderr logs -->
          <section class="detail-section">
            <h3>Standard Error</h3>
            <div class="log-viewer">
              <pre id="detail-stderr" class="log-content">No errors</pre>
            </div>
          </section>

          <!-- Actions -->
          <section class="detail-section detail-actions">
            <button id="detail-replay" class="btn-primary">Open Replay</button>
            <button id="detail-reveal" class="btn-secondary">Reveal JSON</button>
            <button id="detail-copy" class="btn-secondary">Copy Summary</button>
          </section>
        </div>
      </div>
    </div>

    <!-- Toast Container -->
    <div id="toast-container"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Generate nonce for CSP
   */
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
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
  dispose(): void {
    clearTimeout(this.updateDebounceTimer);
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
