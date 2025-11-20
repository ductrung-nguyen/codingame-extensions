# CodinGame Chrome Extension Specification

## 1. Purpose and Scope
1. Provide a bridge between the CodinGame web experience and the developer's local environment.
2. Synchronize local code edited in VS Code into the CodinGame in-browser editor with optional preprocessing (comment stripping).
3. Capture CodinGame match data through multiple methods:
   - Direct API calls to `/services/gameResult/findByGameId` for specific matches
   - Interception of battle list responses from `/services/gamesPlayersRanking/findLastBattlesByAgentId`
   - Support for "View Last Battles" leaderboard feature with batch capture capability
4. Transfer captured match data to the VS Code extension for storage, statistics, and navigation with category-based organization.
5. Operate reliably on Chromium-based browsers (Chrome, Edge) using Manifest V3 requirements.

## 2. Target Users
- Competitive CodinGame programmers who develop locally.
- Teams building CodinGame bots who need reproducible match data and centralized statistics.

## 3. Functional Requirements

### 3.1 Code Synchronization
- **FR-1**: Receive code payloads originating from the VS Code extension via a messaging channel (native messaging or websocket bridge).
- **FR-2**: Inject code into the CodinGame IDE DOM (Monaco-based editor) when a sync command is issued.
- **FR-3**: Confirm injection success/failure via response messages (acknowledgments).
- **FR-4**: Handle strip-comments flag and reflect it in UI indicators.

### 3.2 CodinGame Match Capture
- **FR-5**: Capture match data through multiple strategies:
  - **Page-script injection**: Intercept API responses in page context where Angular is accessible
  - **Direct API calls**: Fetch match data using CodinGame's public APIs
  - **Battle list capture**: Extract available battles from leaderboard "View Last Battles" feature
- **FR-6**: Parse JSON payloads to extract:
  - Match result (WIN/LOSE/DRAW)
  - Player order (0/1)
  - Match identifier (gameId)
  - stdout/stderr text
  - Category/team name for organization
  - Additional metadata (opponent, league, timestamp, arena flag, duration, scores, ranks, frames)
- **FR-7**: Deduplicate captures by `match_id` and `category` combination (same match can exist in multiple categories).
- **FR-8**: Send structured payloads to VS Code extension for storage with category information.

### 3.3 Leaderboard Battle Capture
- **FR-9**: Provide floating capture panel UI on leaderboard pages with:
  - Category input (auto-populated from team name)
  - Batch capture button
  - Pause/resume controls during capture
  - Status indicators (success/error/pending counts)
- **FR-10**: Auto-extract team/category name from battle list for default categorization.
- **FR-11**: Handle "View Last Battles" panel interaction:
  - Detect when user opens last battles for any team
  - Capture list of available battles
  - Allow user-initiated batch capture of all visible battles
- **FR-12**: Maintain capture state to avoid duplicates and track progress during batch operations.

### 3.4 User Feedback
- **FR-13**: Provide visual indicators:
  - **Floating capture panel**: Shows capture progress, status, and category selection
  - **Toolbar popup**: Displays connection status, WebSocket state, IDE tabs, and queue status
  - **Console logging**: Detailed logging for debugging and flow tracing
- **FR-14**: Show real-time capture feedback:
  - Success/error/pending counts
  - Current category being captured
  - Pause/resume state
- **FR-15**: Provide debug utilities:
  - `window.__cgDebug` helpers in content script
  - `self.debugCG` helpers in background script
  - Queue inspection and manual retry capabilities

### 3.5 Reliability & Recovery
- **FR-16**: Maintain retry queue with scheduled backoff for payloads that fail to deliver to VS Code.
- **FR-17**: Persist retry queue in `chrome.storage.local` to survive browser restarts.
- **FR-18**: Handle extension context invalidation gracefully with user-friendly warnings.
- **FR-19**: Deduplicate matches using time-windowed cache (`seenMatches` map with 5-minute window).
- **FR-20**: Support manual retry for failed deliveries via popup controls.

## 4. Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| Performance | Injection latency < 500 ms from command receipt (when editor already loaded). |
| Reliability | Lossless delivery of match payloads (guarantee via retries until VS Code acknowledges). |
| Security | Operate only on CodinGame domains, never expose user code elsewhere. |
| Compatibility | Manifest V3, Chrome 114+, Edge 112+. |
| Privacy | Store only data necessary for functionality; allow clearing state from popup. |
| Usability | Minimal configuration steps; provide onboarding instructions via popup. |

## 5. Architecture Overview

### 5.1 Components
1. **Background Service Worker** (`background.js`)
   - WebSocket bridge to VS Code extension (port 43210 by default)
   - Heartbeat mechanism for connection health monitoring
   - Message normalization and payload validation
   - Retry queue management with persistence
   - Delivery tracking with acknowledgment system
   - IDE tab registration and lifecycle management
   - Debug utilities for queue/state inspection
   
2. **Content Script** (`content-script.js`)
   - Runs on CodinGame pages (IDE and leaderboard)
   - Monaco editor access for code synchronization
   - Floating capture panel UI injection
   - Session info extraction (userId, testSessionHandle)
   - Battle list capture from DOM and API
   - Category/team name auto-extraction
   - Extension context validation and error handling
   
3. **Page Script** (`page-script.js`)
   - Injected into page context (CSP-compliant)
   - Intercepts XHR/fetch responses in Angular context
   - Captures `findLastBattlesByAgentId` responses
   - Forwards battle lists to content script via `window.postMessage`
   
4. **Extension Popup UI** (`popup.html`, `popup.js`)
   - WebSocket connection status and controls
   - IDE tab tracking and selection
   - Retry queue visualization
   - Manual retry and queue management
   - Debug command buttons
   - Log viewing
   
5. **WebSocket Bridge**
   - Persistent connection to VS Code extension
   - JSON message protocol with versioning
   - Automatic reconnection with exponential backoff
   - Delivery confirmation via acknowledgments

### 5.2 Data Flow

#### Code Synchronization Flow
1. VS Code sends `sync_code` message via WebSocket → background receives and dispatches to registered IDE tab
2. Content script injects code into Monaco editor → sends success/failure response
3. Background forwards response to VS Code with status and metadata

#### Battle Capture Flow (Leaderboard)
1. User clicks "VIEW LAST BATTLES" on leaderboard → CodinGame requests `findLastBattlesByAgentId`
2. Page script intercepts response → extracts battle list → posts to content script via `window.__cgBattleListCaptured`
3. Content script stores `availableBattles` array and auto-extracts team name for category
4. User clicks "Capture" button in floating panel → content script iterates through battles
5. For each battle: content script calls `fetchAndProcessBattle(gameId, userId, category)`
6. Content script fetches from `/services/gameResult/findByGameId` → validates response
7. Content script sends `battle_response_captured` to background with `{url, body, userId, gameId, category}`
8. Background normalizes payload → creates `match_data` message → queues for delivery
9. WebSocket sends to VS Code → VS Code stores match in `matches/<category>/` directory
10. VS Code sends `match_data_ack` → background removes from retry queue

#### Deduplication Strategy
- Background maintains `seenMatches` map with timestamps
- Matches seen within 5-minute window are dropped
- VS Code performs additional duplicate check based on `match_id` + `category` combination
- Same match can exist in multiple categories without being rejected

#### Retry and Recovery
- Failed deliveries added to `retryQueue` with exponential backoff schedule
- Queue persisted to `chrome.storage.local`
- Manual retry available via popup or debug commands
- Extension reload preserves pending deliveries

## 6. Detailed Design

### 6.1 Manifest Configuration
- `manifest_version`: 3
- `permissions`: `activeTab`, `scripting`, `storage`, `tabs`
- `host_permissions`: `https://www.codingame.com/*`
- `background`: service worker script `background.js`
- `action`: default popup `popup.html`
- `content_scripts`: 
  - Match pattern: `https://www.codingame.com/*`
  - Run at: `document_idle`
  - Files: `content-script.js`
- `web_accessible_resources`: `page-script.js` (for CSP-compliant injection)
- Note: WebSocket connection via standard WebSocket API (not chrome.sockets, which is deprecated)

### 6.2 Background Service Worker Responsibilities

#### 6.2.1 Message Handling
- Maintain map of pending requests keyed by `requestId`.
- Enforce timeout/resend for unacknowledged sync commands.
- Support message types:
  - `sync_code`
  - `sync_status`
  - `match_data_ack`
  - `settings_update`
  - `heartbeat`

#### 6.2.2 Battle Response Processing
- Receive `battle_response_captured` messages from content script containing:
  - `url`: API endpoint path
  - `body`: Raw JSON response text
  - `userId`: Current user's CodinGame ID
  - `gameId`: Match identifier
  - `category`: Optional category/team name
- Call `processBattleResponse()` to normalize payload
- Use `normalizeMatchPayload()` to extract:
  - Match result determination from scores/ranks
  - Player order detection
  - stdout/stderr extraction
  - Metadata compilation (opponent, league, duration, etc.)
- Support multiple response structures:
  - Direct game result objects
  - Wrapped structures (gameResult, currentGameResult)
  - Test session responses
- Deduplicate via `seenMatches` map (5-minute window)
- Forward normalized payload via `forwardMatchPayload()`

#### 6.2.3 Retry Queue
- Each outgoing payload receives a `deliveryId` (UUID or timestamp-based).
- Queue entry structure:
  ```javascript
  {
    deliveryId: string,
    payload: MatchPayload,
    attempts: number,
    nextAttemptTs: timestamp,
    lastError: string,
    manualRetry: boolean
  }
  ```
- Retry schedule: [2s, 5s, 10s, 30s, 60s, 120s] (6 attempts max)
- Queue persisted to `chrome.storage.local` under `STORAGE_QUEUE_KEY`
- Loaded on service worker startup via `initializeRetryQueue()`
- Processed by `processRetryQueue()` with intelligent scheduling
- Manual retry available: `self.debugCG.manualRetryAll()` or popup button
- Payload removed only after receiving `match_data_ack` with matching `deliveryId`

### 6.3 Content Script Responsibilities

#### 6.3.1 Editor Detection
- Poll for Monaco editor instance:
  - Check `window.monaco` global
  - Query DOM selector `.monaco-editor` or `.cg-code-editor`
  - Validate editor model exists and is writable
- Send `ide_ready` message to background upon detection
- Register tab with background as available for code sync
- Re-register on navigation or page reload

#### 6.3.2 Code Injection
- Receive message with `code`, `language`, `metadata`.
- Use Monaco API `editor.getModel().setValue(code)` or fallback to DOM value assignment followed by input events.
- Optionally preserve cursor position if requested.
- Send completion status (`success`, `error`, `reason`).

#### 6.3.3 Floating Capture Panel
- Inject on leaderboard pages when battle lists are available
- UI components:
  - Category input field (auto-populated from team name)
  - Capture button with dynamic text
  - Pause/Resume button (appears during capture)
  - Status text showing progress and results
- Features:
  - Category sanitization (lowercase, alphanumeric, hyphens)
  - Capture progress tracking (X/Y battles)
  - Error handling and user feedback
  - Pause capability during batch operations
- Styling: Gradient purple theme, fixed positioning, responsive design

### 6.4 Popup UI

#### 6.4.1 Features
- **Connection Status**:
  - WebSocket state indicator (Connected/Disconnected/Connecting)
  - Last heartbeat timestamp
  - Reconnect button with attempt counter
- **IDE Tabs**:
  - List of registered IDE tabs with URLs
  - Last ready/active timestamps
  - Current language detection
- **Sync Status**:
  - Last sync result and timestamp
  - Comment stripping state toggle
- **Retry Queue**:
  - Count of pending deliveries
  - Manual retry button
  - Clear queue option
- **Debug Tools**:
  - Check battle queue status
  - View seen matches
  - Send test battle
  - Clear seen matches cache
  - Content script connection test
- **Logs**:
  - Recent activity log viewer
  - Clear logs button

#### 6.4.2 Implementation
- Vanilla JavaScript (no framework dependencies)
- Real-time updates via message passing
- Background state queries on popup open
- Command buttons invoke background methods
- Responsive layout with sections

## 7. Data Contracts

### 7.1 Sync Code Request (from VS Code)
```json
{
  "type": "sync_code",
  "requestId": "uuid",
  "payload": {
    "language": "Python3",
    "code": "string",
    "stripComments": true,
    "fileName": "solution.py",
    "timestamp": "2024-05-23T10:20:30Z"
  },
  "version": "1.0"
}
```

### 7.2 Sync Response (to VS Code)
```json
{
  "type": "sync_status",
  "requestId": "uuid",
  "payload": {
    "status": "success",
    "changed": true,
    "strategy": "monaco_api",
    "reason": null,
    "details": "Code injected successfully",
    "tabId": 12345,
    "language": "Python3",
    "codeLength": 1234
  }
}
```

### 7.3 Match Data Payload (to VS Code)
```json
{
  "type": "match_data",
  "payload": {
    "match_id": "123456789",
    "result": "WIN",
    "order": 0,
    "timestamp": "2024-05-23T10:25:00Z",
    "stdout": "Console output...",
    "stderr": "Error output...",
    "category": "team-alpha",
    "metadata": {
      "arena": true,
      "opponent": "BotXYZ",
      "league": "Gold",
      "language": "Python3",
      "duration_ms": 1234,
      "timestamp": "2024-05-23T10:25:00Z",
      "playerIndex": 0,
      "scores": [100, 50],
      "ranks": [1, 2],
      "frames": 450,
      "tooltips": [],
      "refereeInput": "",
      "rawResponse": { }
    }
  },
  "deliveryId": "uuid-or-timestamp",
  "version": "1.0"
}
```

### 7.4 Match Data Ack (from VS Code)
```json
{
  "type": "match_data_ack",
  "deliveryId": "uuid-or-timestamp",
  "status": "received"
}
```

### 7.5 Battle Response Captured (internal, content → background)
```json
{
  "type": "battle_response_captured",
  "payload": {
    "url": "/services/gameResult/findByGameId",
    "body": "raw JSON string",
    "userId": 12345678,
    "gameId": 123456789,
    "category": "team-alpha"
  }
}
```

### 7.6 WebSocket Hello (extension → VS Code)
```json
{
  "type": "hello",
  "requestId": "uuid",
  "payload": {
    "token": null,
    "version": "1.0",
    "clientType": "chrome-extension",
    "timestamp": "2024-05-23T10:20:30Z"
  },
  "version": "1.0"
}
```

### 7.7 Heartbeat (bidirectional)
```json
{
  "type": "heartbeat",
  "timestamp": "2024-05-23T10:20:30Z"
}
```

## 8. Error Handling Strategy

### 8.1 Error Categories
- **Connection Errors**:
  - WebSocket connection failures
  - Heartbeat timeout
  - Extension context invalidation
- **Capture Errors**:
  - Battle fetch failures (HTTP errors)
  - Invalid JSON responses
  - Missing required fields
- **Sync Errors**:
  - Editor not found
  - Monaco API failures
  - Code injection timeout
- **Delivery Errors**:
  - WebSocket send failures
  - Acknowledgment timeout
  - Queue overflow

### 8.2 Error Handling Mechanisms
- Comprehensive console logging at each step
- User-friendly error messages in capture panel
- Graceful degradation (continue processing other battles on single failure)
- Extension context validation before operations
- Try-catch blocks around all external API calls
- Retry queue for delivery failures
- Error state persistence for debugging

### 8.3 Logging
- Logs stored in `chrome.storage.local` with rotation (last 100 entries)
- Structure: `{ id, timestamp, level, context, message }`
- Viewable in popup UI
- Downloadable for bug reports
- Console.log mirroring for development

## 9. Security & Privacy Considerations
- Restrict host permissions strictly to CodinGame.
- Do not transmit captured data to third parties; only to local VS Code bridge.
- Expose clear toggle to pause capture.
- Warn user when enabling comment stripping (code semantics may change).
- Sanitize data injected into popup or overlays to prevent DOM injection.

## 10. Testing Plan

### 10.1 Unit Tests (where possible)
- Background message routing (using `chrome.runtime` mocks).
- Retry queue timing logic.
- JSON parsing helpers and filename derivation.

### 10.2 Integration Tests
- Use Puppeteer to load CodinGame mock page and verify code injection.
- Simulate HTTP responses with mocked service worker tests.
- Automated scenario: VS Code mock sends code → extension injects → ack returned.

### 10.3 Manual QA Checklist
1. Install extension, connect to VS Code bridge.
2. Sync code on blank editor; confirm success message.
3. Toggle strip-comments; verify indicator updates.
4. Run solo match; ensure JSON payload captured and delivered.
5. Run arena session; verify multiple matches recorded without duplication.
6. Disconnect VS Code; confirm retry queue accumulates and later flushes.
7. Test on Chrome and Edge latest versions.

## 11. Deployment & Distribution
- Build artifacts via `npm run build` producing `/dist`.
- Zip manifest and assets for Chrome Web Store submission.
- Provide developer mode installation instructions (load unpacked).
- Versioning scheme aligned with VS Code extension (e.g., `1.0.x`).

## 12. Future Enhancements
- **Multi-browser Support**: Firefox with Manifest v2/v3 hybrid and polyfills
- **Enhanced UI**:
  - Bi-directional diff viewer within popup
  - Visual replay viewer for captured matches
  - Statistics dashboard in popup
- **Advanced Capture**:
  - Automatic tournament tracking across multiple days
  - Match filtering before capture (result, opponent, etc.)
  - Bulk export to external formats
- **Automation**:
  - Auto-submit when local tests pass
  - Continuous monitoring mode for new battles
  - Scheduled captures at specific intervals
- **Category Management**:
  - Category renaming/merging UI
  - Category templates for tournaments
  - Auto-categorization rules based on opponent patterns
- **Performance**:
  - Indexed DB for large battle collections
  - Streaming capture for high-volume scenarios
  - Compression for payload transmission

## 13. Debug Utilities

### 13.1 Content Script Debug Commands
Available via `window.__cgDebug`:
- `testBackgroundConnection()`: Test message passing to background
- `getAvailableBattles()`: View captured battle list
- `getCapturedBattles()`: View battles marked as captured
- `setCategory(name)`: Manually set capture category
- `getCategory()`: Get current category

### 13.2 Background Script Debug Commands
Available via `self.debugCG`:
- `checkBattleQueue()`: Inspect retry queue status
- `checkSeenMatches()`: View deduplication cache
- `clearSeenMatches()`: Reset duplicate detection
- `testSendBattle()`: Send test match to VS Code
- `getState()`: Get full background state
- `showState()`: Log state to console
- `listTabs()`: Show registered IDE tabs

### 13.3 Popup Debug Actions
- Check content script injection status
- Force WebSocket reconnection
- Manual retry all queued deliveries
- Clear all caches and state
- Export diagnostic report

## 14. Category-Based Organization

### 14.1 Purpose
- Organize matches by team, tournament, or competition
- Allow same match to exist in multiple categories
- Support statistical analysis per category
- Enable flexible workspace organization

### 14.2 Category Extraction
- Auto-extracted from battle list fields:
  - `agent.pseudo` or `agent.nickname`
  - `codingamer.pseudo` or `codingamer.nickname`
  - DOM pseudo elements as fallback
- Sanitization rules:
  - Convert to lowercase
  - Replace non-alphanumeric with hyphens
  - Collapse consecutive hyphens
  - Trim leading/trailing hyphens
- User override via capture panel input

### 14.3 Storage Structure
- VS Code stores matches in `matches/<category>/` subdirectories
- Index key format: `category:match_id` for duplicate detection
- Uncategorized matches stored in root `matches/` directory
- Category information preserved in match metadata

---
This document defines the complete functional and technical blueprint for the CodinGame Chrome extension, ensuring interoperability with the accompanying VS Code extension and reliable capture of gameplay data.
