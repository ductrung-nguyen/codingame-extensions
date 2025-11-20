# CodinGame Chrome Extension Specification

## 1. Purpose and Scope
1. Provide a bridge between the CodinGame web experience and the developer’s local environment.
2. Synchronize local code edited in VS Code into the CodinGame in-browser editor with optional preprocessing (comment stripping).
3. Capture CodinGame match HTTP responses (solo runs and arena battles) to extract execution artifacts (stdout, stderr, metadata).
4. Transfer captured match data to the VS Code extension for storage, statistics, and navigation.
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

### 3.2 CodinGame Network Capture
- **FR-5**: Intercept HTTP responses from CodinGame battle endpoints (solo and arena).
- **FR-6**: Parse JSON payloads to extract:
  - Match result (WIN/LOSE/DRAW)
  - Player order (0/1)
  - Match identifier
  - stdout/stderr text
  - Additional metadata (opponent, league, timestamp, arena flag, duration)
- **FR-7**: Deduplicate captures by `match_id`.
- **FR-8**: Send structured payloads to VS Code extension for storage.

### 3.3 Arena Automation
- **FR-9**: Detect arena battle loops and automatically capture every match without manual intervention.
- **FR-10**: Maintain capture state to avoid missing matches when multiple responses arrive quickly.

### 3.4 User Feedback
- **FR-11**: Provide visual indicators (toolbar popup or injected overlay) for:
  - Connection status to VS Code extension.
  - Last sync timestamp/result.
  - Capture queue health (pending/failed transmissions).
- **FR-12**: Show last received settings (strip comments toggle, target language).

### 3.5 Reliability & Recovery
- **FR-13**: Maintain retry queue with exponential backoff for payloads that fail to deliver to VS Code.
- **FR-14**: Persist minimal state (last known connection info, pending queue) in extension storage to survive browser restarts.

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
1. **Background Service Worker**
   - Central message router (VS Code ⇄ content scripts).
   - Implements webRequest listeners for network capture.
   - Manages retry queue and status reporting.
2. **Content Scripts**
   - Injected on CodinGame IDE pages.
   - Access Monaco editor to set code, read readiness state.
   - Provide DOM overlay for inline notifications if desired.
3. **Extension Popup UI**
   - Displays connection indicators, latest sync status, manual controls (retry queue flush, clear state).
4. **Messaging Bridge**
   - Interface to VS Code extension (native messaging host or websocket via chrome.sockets API).
   - Defines JSON message schema with `type`, `payload`, `requestId`.

### 5.2 Data Flow
1. VS Code sends `sync_code` message → background forwards to content script → content script injects code → response bubbled back for acknowledgment.
2. Background monitors relevant HTTP responses → extracts payload → sends `match_data` message to VS Code → waits for `ack`.
3. Popup queries background for state snapshots to render UI.

## 6. Detailed Design

### 6.1 Manifest Configuration
- `manifest_version`: 3
- `permissions`: `activeTab`, `scripting`, `storage`, `webRequest`, `webRequestBlocking`, `tabs`, `sockets`.
- `host_permissions`: `https://www.codingame.com/*`.
- `background`: service worker script (e.g., `background.js`).
- `action`: default popup referencing `popup.html`.
- `content_scripts`: match CodinGame IDE URLs, run at `document_idle`.
- `externally_connectable`: if needed to allow VS Code-hosted native app to talk.

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

#### 6.2.2 HTTP Capture Logic
- Register `chrome.webRequest.onCompleted` with filters:
  - URLs containing `/services/TestSession/run`, `/services/TestSession/play`, `/services/TestSession/start`, `/services/TestSession/submit`, `/services/gameResult/`.
- If full body needed, use `chrome.webRequest.filterResponseData` to clone stream.
- Parse JSON safely with try/catch; log malformed payloads.
- Build normalized structure (see section 7).

#### 6.2.3 Retry Queue
- Each outgoing payload to VS Code receives a `deliveryId`.
- Store pending payload in `chrome.storage.local`.
- Retry schedule: immediate, 2s, 5s, 10s, 30s, then mark as failed (visible in popup with manual resend).
- Drop payload only after explicit `ack`.

### 6.3 Content Script Responsibilities

#### 6.3.1 Editor Detection
- Poll for Monaco editor instance (`window.monaco` or specific DOM selectors like `.cg-code-editor textarea`).
- Expose readiness message to background.

#### 6.3.2 Code Injection
- Receive message with `code`, `language`, `metadata`.
- Use Monaco API `editor.getModel().setValue(code)` or fallback to DOM value assignment followed by input events.
- Optionally preserve cursor position if requested.
- Send completion status (`success`, `error`, `reason`).

#### 6.3.3 Inline Feedback (optional)
- Display toaster overlay summarizing last sync.
- Provide manual "Request Sync" button.

### 6.4 Popup UI

#### 6.4.1 Features
- Status icons: connected/disconnected to VS Code.
- Last sync timestamp, comment stripping state, selected language.
- Retry queue list with ability to resend or discard payloads.
- Button to copy diagnostic logs.

#### 6.4.2 Implementation
- Use lightweight framework (Preact) or vanilla.
- Communicate with background via `chrome.runtime.sendMessage`.

## 7. Data Contracts

### 7.1 Sync Code Request
```json
{
  "type": "sync_code",
  "requestId": "uuid",
  "payload": {
    "language": "Python3",
    "code": "string",
    "stripComments": true,
    "timestamp": "2024-05-23T10:20:30Z"
  }
}
```

### 7.2 Sync Response
```json
{
  "type": "sync_status",
  "requestId": "uuid",
  "payload": {
    "status": "success|failure",
    "details": "string"
  }
}
```

### 7.3 Match Data Payload
```json
{
  "type": "match_data",
  "payload": {
    "match_id": "123456789",
    "result": "WIN",
    "order": 0,
    "stdout": "....",
    "stderr": "....",
    "metadata": {
      "arena": true,
      "opponent": "BotXYZ",
      "league": "Gold",
      "language": "Python3",
      "duration_ms": 1234,
      "timestamp": "2024-05-23T10:25:00Z",
      "rawResponse": { "..." : "..." }
    }
  },
  "deliveryId": "uuid"
}
```

### 7.4 Match Data Ack
```json
{
  "type": "match_data_ack",
  "deliveryId": "uuid",
  "status": "received"
}
```

## 8. Error Handling Strategy
- Log detailed errors to `chrome.storage` capped to last 200 entries.
- Provide `errorCode` enums for:
  - `EDITOR_NOT_FOUND`
  - `INJECTION_TIMEOUT`
  - `NETWORK_CAPTURE_PARSE_ERROR`
  - `MESSAGE_DELIVERY_FAILED`
- Popup exposes “Download logs” to aid debugging.

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
- Support Firefox (Manifest v2/v3 hybrid) with polyfills.
- Bi-directional diff viewer within popup.
- Automatic submission triggers when local tests pass.

---
This document defines the complete functional and technical blueprint for the CodinGame Chrome extension, ensuring interoperability with the accompanying VS Code extension and reliable capture of gameplay data.
