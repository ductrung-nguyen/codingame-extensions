# CodinGame VS Code Extension Specification

## 1. Purpose and Scope
1. Provide a robust VS Code companion that synchronizes local CodinGame bot code with the CodinGame web editor via the Chrome extension.
2. Receive, store, and visualize match telemetry captured by the Chrome extension.
3. Offer workflow enhancements (comment stripping, statistics dashboard, quick navigation to replays) tailored to CodinGame development.
4. Maintain secure, reliable, and low-latency communication with the Chrome extension using a local messaging bridge.

## 2. Target Users
- Individual CodinGame competitors iterating rapidly on local bots.
- Engineering teams collaborating on CodinGame strategies needing centralized performance insights.
- Developers seeking reproducible match data and streamlined submission workflows.

## 3. Functional Requirements

### 3.1 Code Synchronization
- **FR-1**: Provide command palette entries and status bar buttons to trigger synchronization.
- **FR-2**: Collect code from the active editor (or configured file) and package metadata (language, timestamp, strip-comments flag).
- **FR-3**: Invoke comment stripping pipeline when enabled, preserving indentation where possible.
- **FR-4**: Transmit `sync_code` payload to Chrome extension and await confirmation.
- **FR-5**: Surface success/failure messages via VS Code notifications and status bar indicators.

### 3.2 Match Data Reception & Storage
- **FR-6**: Listen for `match_data` messages from Chrome extension over persistent channel.
- **FR-7**: Validate payload schema, normalize, and store as JSON files using `<result>_<order>_<match_id>.json`.
- **FR-8**: Maintain configurable storage directory (default `.codingame/matches`).
- **FR-9**: Emit events to UI layer when new matches are saved.

### 3.3 Statistics & Visualization
- **FR-10**: Provide dedicated webview panel displaying aggregate statistics (win rate, order distribution, arena vs. solo).
- **FR-11**: Offer filters (time range, result, opponent, league) and searchable match list.
- **FR-12**: Enable row actions: open replay URL, open JSON file, copy summary.
- **FR-13**: Persist UI filter preferences using global state.

### 3.4 Settings & Configuration
- **FR-14**: Expose configuration keys:
  - `codingame.sync.stripComments` (boolean)
  - `codingame.sync.targetFile` (string path)
  - `codingame.matches.directory` (string path)
  - `codingame.bridge.port` / `codingame.bridge.pipe` (communication settings)
- **FR-15**: Provide quick pick to toggle comment stripping.
- **FR-16**: Validate directories on change and prompt to create if missing.

### 3.5 Communication Bridge
- **FR-17**: Establish local websocket (default `ws://127.0.0.1:45123`) or native host pipe.
- **FR-18**: Support bi-directional messaging with heartbeats and reconnection.
- **FR-19**: Log bridge diagnostics to VS Code Output channel (`CodinGame`).

### 3.6 Diagnostics & Developer UX
- **FR-20**: Offer `CodinGame: Open Logs` command to inspect recent events.
- **FR-21**: Provide `CodinGame: Resend Last Code Snapshot` and `CodinGame: Retry Failed Matches`.
- **FR-22**: Show inline notifications when Chrome extension disconnects or when capture queue backlog occurs.

## 4. Non-Functional Requirements

| Category    | Requirement                                                                 |
|-------------|-----------------------------------------------------------------------------|
| Performance | Code packaging and send latency < 300 ms for files under 500 KB.            |
| Reliability | Reconnect bridge within 5 seconds after disconnection; ensure at-least-once delivery of match payloads. |
| Usability   | Commands discoverable via Command Palette; tooltips for status bar icons.   |
| Security    | Only accepts connections from loopback interface; sanitizes webview data.   |
| Portability | Works on macOS, Windows, Linux; no OS-specific dependencies in extension.   |
| Maintainability | Modular architecture with separated services and comprehensive logging. |

## 5. Architecture Overview

### 5.1 High-Level Modules
1. **Activation Manager**  
   Registers commands, initializes services, manages disposables.

2. **Configuration Service**  
   Wraps VS Code configuration API, emits events on changes, validates paths.

3. **Comment Processing Service**  
   Provides language-aware comment stripping (Tree-sitter/AST if available, regex fallback).

4. **Bridge Client**  
   Handles websocket/native messaging connections, message serialization, heartbeats, reconnection logic.

5. **Sync Controller**  
   Orchestrates code gathering, preprocessing, message dispatch, and result notifications.

6. **Match Storage Service**  
   Persists JSON payloads, ensures filename conventions, emits events when new files appear.

7. **Statistics Webview**  
   Renders UI, communicates via `postMessage`, requests data refreshes, applies filters.

8. **Logging & Telemetry**  
   Provides structured logs to VS Code Output channel, optional verbose mode.

### 5.2 Data Flow
1. User runs `CodinGame: Sync Code to Browser`.
2. Sync Controller reads active editor content, optionally strips comments.
3. Payload sent through Bridge Client → Chrome extension → CodinGame editor.
4. Chrome extension captures match result → sends `match_data`.
5. Bridge Client receives payload → Match Storage writes JSON → Statistics webview updates list.

## 6. Detailed Design

### 6.1 Extension Activation
- On activation:
  1. Initialize configuration service and validate directories.
  2. Start bridge client and register message handlers.
  3. Register commands and status bar items.
  4. Lazy-load statistics webview resources when first opened.

### 6.2 Command Set
| Command ID | Description |
|------------|-------------|
| `codingame.sync` | Trigger code synchronization. |
| `codingame.toggleStripComments` | Toggle global strip-comments flag. |
| `codingame.resendLast` | Replays last successful sync payload. |
| `codingame.showStatistics` | Opens statistics dashboard. |
| `codingame.retryFailedMatches` | Reprocesses failed match payloads (if any). |
| `codingame.openLogs` | Opens Output channel. |
| `codingame.configureStorageDir` | Prompts user to pick match storage folder. |

### 6.3 Status Bar Indicators
- **Sync Status Item**: icon toggles between idle, syncing, success, failure.
- **Strip Comments Item**: shows state (on/off) and allows click to toggle.
- Tooltips display last sync time and connection status.

### 6.4 Comment Stripping Strategy
1. Determine language via VS Code document languageId.
2. Preferred approach: use AST parser (e.g., `@typescript-eslint/parser`, `tree-sitter` bindings) packaged in extension.
3. Fallback regex templates per language family.
4. Provide extension setting `codingame.sync.commentStrategy` (`auto`, `regex`, `none`).
5. Preserve newline count to keep stack traces aligned.

### 6.5 Match Storage
- Write files under `<workspace>/.codingame/matches` by default.
- Ensure atomic writes using temp file + rename.
- Maintain SQLite-lite index (optional) or in-memory index built from directory scan.
- Provide rotation policy (e.g., keep last N matches) configurable via settings.

### 6.6 Statistics Webview
- Built with lightweight front-end (Svelte/React) bundled via esbuild/webpack.
- Features:
  - Summary cards: total matches, win %, first-player win %, arena vs. solo counts.
  - Filters: result, order, opponent, league, date range slider.
  - Table with sortable columns and pagination.
  - Detail drawer showing stdout/stderr snippet, metadata, buttons:
    - “Open Replay” (launch default browser with CodinGame URL using `vscode.env.openExternal`).
    - “Reveal JSON in Explorer”.
    - “Copy telemetry summary”.
- Data lifecycle:
  - Webview requests initial dataset via `getMatches`.
  - Extension responds with aggregated data.
  - Webview posts filter updates; extension recomputes or webview filters locally depending on dataset size.
- Security:
  - Use `vscode-resource` URIs for local assets.
  - Sanitize dynamic content before injection.

### 6.7 Communication Protocol
- Transport: WebSocket server started by VS Code (default port 45123, configurable).
- Message envelope:
```json
{
  "type": "string",
  "requestId": "uuid | null",
  "payload": {},
  "version": "1.0.0"
}
```
- Supported message types:
  - `sync_code` (outgoing)
  - `sync_status` (incoming)
  - `match_data` (incoming)
  - `match_data_ack` (outgoing)
  - `settings_update` (bidirectional)
  - `heartbeat` (bidirectional)
  - `log` (incoming for Chrome diagnostics)
- Heartbeats every 10 seconds; close connection after 3 missed heartbeats.

### 6.8 Error Handling & Logging
- Output channel categories: `[SYNC]`, `[BRIDGE]`, `[MATCH]`, `[UI]`.
- For critical errors, show VS Code notifications with action buttons (e.g., “Open Logs”, “Retry”).
- Maintain in-memory ring buffer of last 200 bridge events for export.

## 7. Data Models

### 7.1 SyncContext
```ts
interface SyncContext {
  documentUri: string;
  languageId: string;
  code: string;
  stripComments: boolean;
  timestamp: string;
  commentStrategy: "auto" | "regex" | "none";
}
```

### 7.2 MatchRecord
```ts
interface MatchRecord {
  matchId: string;
  filename: string;
  result: "WIN" | "LOSE" | "DRAW";
  order: 0 | 1;
  arena: boolean;
  opponent: string;
  league: string;
  durationMs: number;
  timestamp: string;
  stdoutPath: string;
  stderrPath: string;
  metadataPath: string;
}
```

### 7.3 Webview Messages
```ts
type WebviewMessage =
  | { type: "requestData"; filters: MatchFilter }
  | { type: "openReplay"; matchId: string }
  | { type: "revealFile"; path: string }
  | { type: "toggleReviewed"; matchId: string; reviewed: boolean };
```

## 8. Security & Privacy
- Restrict bridge server to listen only on loopback interface.
- Randomize auth token per session; Chrome extension must supply token with each message.
- Store minimal personal data; allow user to purge matches via command.
- Sanitize stdout/stderr before displaying in webview (escape HTML entities).
- Do not log full code or match content unless user enables verbose diagnostics.

## 9. Testing Strategy

### 9.1 Unit Tests
- Use `mocha`/`chai` via `vscode-test` for:
  - Comment stripping logic per language.
  - Filename generation and storage path resolution.
  - Configuration change handlers.
  - Message serialization/deserialization.

### 9.2 Integration Tests
- Mock Chrome extension using test harness that connects to websocket.
- Scenario coverage:
  1. Successful sync and ack cycle.
  2. Lost connection and automatic reconnection.
  3. Match payload write and dashboard refresh.
- Utilize temporary workspace directories for filesystem assertions.

### 9.3 Manual QA Checklist
1. Install extension and run `CodinGame: Show Statistics`.
2. Toggle strip comments; confirm status bar reflects change.
3. Perform sync on multiple languages (Python, JS, C++).
4. Simulate match payload reception; verify JSON file creation and dashboard update.
5. Test reconnection by restarting Chrome extension.
6. Validate open replay action opens correct browser URL.
7. Verify settings persistence across VS Code restarts.

## 10. Packaging & Deployment
- Build using `vsce package`.
- Include README with setup instructions (Chrome extension install, bridge configuration).
- Provide changelog and version alignment with Chrome extension (major/minor parity).
- Optional pre-release channel for beta testers.

## 11. Future Enhancements
- Two-way diff viewer comparing local code to CodinGame editor snapshot.
- Automatic submission triggers when match performance exceeds threshold.
- Integration with CodinGame API (if official endpoints become available).
- Multi-workspace awareness for teams sharing match storage directories.

---

This specification outlines the comprehensive functional and technical blueprint for the CodinGame VS Code extension, ensuring seamless collaboration with the Chrome extension, reliable match data archiving, and productivity-focused tooling for CodinGame developers.
