/* eslint-disable no-restricted-globals */
/**
 * CodinGame Chrome Extension - Background Service Worker
 *
 * Responsibilities:
 * 1. Maintain a resilient websocket connection to the local VS Code bridge
 * 2. Expose connection state for popup UI queries
 * 3. Relay heartbeats/status to retry queue (future tasks)
 */

const DEFAULT_WS_URL = "ws://127.0.0.1:45123";
const BRIDGE_VERSION = "1.0.0";
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const RECONNECT_SCHEDULE_MS = [2_000, 5_000, 10_000, 30_000];
const BATTLE_ENDPOINTS = [
  "https://www.codingame.com/services/TestSession/run*",
  "https://www.codingame.com/services/TestSession/start*",
  "https://www.codingame.com/services/TestSession/submit*",
  "https://www.codingame.com/services/TestSession/play*",
  "https://www.codingame.com/services/gameResult/*",
  "https://www.codingame.com/services/gameResult/findById*",
  "https://www.codingame.com/services/gameResult/findByIds*",
  "https://www.codingame.com/services/Arena/*",
  "https://www.codingame.com/services/Challenge/*",
];
const DEDUPE_WINDOW_MS = 60_000;
const RETRY_SCHEDULE_MS = [0, 2_000, 5_000, 10_000, 30_000];
const MAX_RETRY_ATTEMPTS = RETRY_SCHEDULE_MS.length;
const STORAGE_QUEUE_KEY = "cg_match_retry_queue";
const LOG_STORAGE_KEY = "cg_popup_logs";
const MAX_LOG_ENTRIES = 300;
const SYNC_RESPONSE_TIMEOUT_MS = 8_000;
const IDE_TAB_IDLE_TTL_MS = 15 * 60 * 1000;
const MAX_DEFERRED_SYNC_STATUSES = 20;
const RESPONSE_DECODER = new TextDecoder();
const seenMatches = new Map();
const retryQueue = new Map();
const ideTabs = new Map();
const pendingSyncRequests = new Map();
const deferredSyncStatuses = [];

let ws = null;
let reconnectAttempts = 0;
let heartbeatTimer = null;
let lastHeartbeatAck = 0;
let intentionalDisconnect = false;
let retryTimer = null;
let queueLoaded = false;
let retryProcessing = false;
let logsLoaded = false;
let logs = [];
let lastActiveIdeTabId = null;

const state = {
  connected: false,
  retrying: false,
  retryDelay: 0,
  lastError: null,
  token: null,
  lastSync: null,
  lastSyncResult: null,
};

// Note: Token loading and connection moved to after initialization (see end of file)

if (chrome?.tabs) {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    markIdeTabActive(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    unregisterIdeTab(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (
      ideTabs.has(tabId) &&
      changeInfo?.status === "loading" &&
      changeInfo?.url &&
      !isCodinGameUrl(changeInfo.url)
    ) {
      unregisterIdeTab(tabId);
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "editor_ready" && sender?.tab?.id) {
    console.log("[TAB] Received editor_ready from content script", {
      tabId: sender.tab.id,
      url: sender.tab.url,
      payload: message.payload,
    });
    registerIdeTab(sender.tab, message.payload || {});
    sendResponse?.({ ok: true });
    return true;
  }
  if (message?.type === "sync_status" && sender?.tab?.id) {
    handleTabSyncResponse(message.requestId, message, { tabId: sender.tab.id });
    sendResponse?.({ ok: true });
    return true;
  }
  if (message?.type === "battle_response_captured") {
    // Content script captured battle response (MV3 compatible approach)
    console.log(
      "[BATTLE] Received battle_response_captured from content script",
    );
    console.log("[BATTLE] URL:", message.payload?.url);
    console.log("[BATTLE] Body length:", message.payload?.body?.length);
    if (message.payload?.userId) {
      console.log("[BATTLE] User ID:", message.payload.userId);
    }
    if (message.payload?.gameId) {
      console.log("[BATTLE] Game ID:", message.payload.gameId);
    }
    if (message.payload?.category) {
      console.log("[BATTLE] Category:", message.payload.category);
    }
    if (message.payload?.body) {
      console.log("[BATTLE] Processing battle response...");
      console.log(
        "[BATTLE] Received category from content script:",
        message.payload.category || "(empty)",
      );
      processBattleResponse(
        { url: message.payload.url },
        message.payload.body,
        message.payload.userId,
        message.payload.gameId,
        message.payload.category,
      );
    } else {
      console.warn("[BATTLE] No body in payload");
    }
    sendResponse?.({ ok: true });
    return true;
  }
  if (message?.type === "debug_state") {
    sendResponse?.({
      state,
      ideTabsCount: ideTabs.size,
      ideTabs: Array.from(ideTabs.values()),
      lastActiveIdeTabId,
      pendingSyncCount: pendingSyncRequests.size,
      wsConnected: ws ? ws.readyState === WebSocket.OPEN : false,
    });
    return true;
  }
  if (message?.type === "bridge_status_request") {
    sendResponse({ ...state, lastHeartbeatAck });
    return true;
  }
  if (message?.type === "bridge_connect") {
    state.token = message.token || null;
    connectToBridge(true);
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "retry_queue_status_request") {
    sendResponse(getRetryQueueStatus());
    return true;
  }
  if (message?.type === "retry_queue_resend_all") {
    const count = manualRetryAll();
    sendResponse({ ok: true, count });
    return true;
  }
  if (message?.type === "popup_status_request") {
    sendResponse(getPopupStatus());
    return true;
  }
  if (message?.type === "popup_clear_logs") {
    clearLogs();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "reload_config") {
    // Reload auth token from storage
    chrome.storage.local.get(["cg_auth_token"], (result) => {
      if (result.cg_auth_token) {
        state.token = result.cg_auth_token;
        console.info("[bridge] reloaded auth token from storage");
        pushLog("info", "Auth token reloaded");
        // Try to reconnect with new token
        if (!state.connected) {
          connectToBridge(true);
        }
      }
    });
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// Initialize after all functions are defined (moved to end of file)

function connectToBridge(force = false) {
  if (
    !force &&
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  intentionalDisconnect = false; // Reset flag when initiating connection
  cleanupSocket();
  const retryDelay =
    RECONNECT_SCHEDULE_MS[
      Math.min(reconnectAttempts, RECONNECT_SCHEDULE_MS.length - 1)
    ];
  if (!force && reconnectAttempts > 0) {
    state.retrying = true;
    state.retryDelay = retryDelay;
    console.warn(
      `[bridge] reconnect attempt #${reconnectAttempts}, delay ${retryDelay}ms`,
    );
    setTimeout(() => openSocket(), retryDelay);
  } else {
    openSocket();
  }
}

function openSocket() {
  try {
    ws = new WebSocket(DEFAULT_WS_URL);
  } catch (err) {
    recordError(err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.info("[bridge] websocket connected");
    reconnectAttempts = 0;
    state.connected = true;
    state.retrying = false;
    state.retryDelay = 0;
    lastHeartbeatAck = Date.now();
    intentionalDisconnect = false; // Clear flag on successful connection
    sendHello();
    startHeartbeat();
    pushLog("info", "Bridge connected");
    flushDeferredSyncStatuses();
  };

  ws.onmessage = (event) => {
    handleBridgeMessage(event.data);
  };

  ws.onerror = (event) => {
    const errorMsg =
      event?.error?.message || event?.message || "WebSocket connection failed";
    recordError(errorMsg);
  };

  ws.onclose = (event) => {
    console.warn("[bridge] websocket closed", {
      code: event.code,
      reason: event.reason,
    });
    state.connected = false;
    cleanupSocket();

    // Don't reconnect if:
    // 1. Intentional disconnect
    // 2. Normal closure (1000) - usually means another client is connecting
    // 3. Going away (1001)
    const shouldReconnect =
      !intentionalDisconnect && event.code !== 1000 && event.code !== 1001;

    if (shouldReconnect) {
      scheduleReconnect();
      pushLog("warn", "Bridge disconnected, reconnecting...");
    } else {
      console.info(
        "[bridge] Normal closure or intentional disconnect, not reconnecting",
      );
      pushLog(
        "info",
        event.code === 1000 ? "Replaced by another client" : "Bridge closed",
      );
      reconnectAttempts = 0; // Reset reconnect counter
      intentionalDisconnect = false; // Reset flag
    }
  };
}

function handleBridgeMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (err) {
    console.error("[bridge] failed to parse message", err);
    return;
  }

  if (message.type === "heartbeat") {
    lastHeartbeatAck = Date.now();
    // Respond with heartbeat_ack
    sendBridgeMessage({
      type: "heartbeat_ack",
      requestId: message.requestId,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (message.type === "heartbeat_ack") {
    lastHeartbeatAck = Date.now();
    return;
  }

  if (message.type === "auth_ack") {
    if (message.payload?.status === "success") {
      console.info("[bridge] authentication successful");
      pushLog("info", "Authentication successful");
    } else {
      console.error("[bridge] authentication failed:", message.payload?.reason);
      pushLog(
        "error",
        `Authentication failed: ${message.payload?.reason || "unknown"}`,
      );
      state.lastError = {
        message: `Authentication failed: ${message.payload?.reason || "Invalid token"}`,
        timestamp: new Date().toISOString(),
      };
    }
    return;
  }

  if (message.type === "log") {
    console.log("[bridge/log]", message.payload || "");
    return;
  }

  if (message.type === "match_data_ack") {
    const deliveryId = message.deliveryId || message.payload?.deliveryId;
    if (deliveryId) {
      console.log("[BATTLE] Received match_data_ack for delivery:", deliveryId);
      acknowledgeDelivery(deliveryId);
    } else {
      console.warn("[BATTLE] Received match_data_ack without deliveryId");
    }
    return;
  }

  if (message.type === "sync_code") {
    console.log("[SYNC] Received sync_code message from bridge", {
      requestId: message.requestId,
      payloadSize: message.payload?.code?.length || 0,
      language: message.payload?.language,
    });
    pushLog("info", `[SYNC] Received sync_code: ${message.requestId}`);
    dispatchSyncCode(message);
    return;
  }

  // Future: pass through sync_status/match_data/etc. to other components.
  console.debug("[bridge] received message", message.type);
}

function sendHello() {
  // VS Code bridge expects 'auth' message type, not 'hello'
  const message = {
    type: "auth",
    requestId: `auth_${Date.now()}`,
    payload: {
      token: state.token,
      version: chrome.runtime.getManifest().version,
      clientType: "chrome-extension",
      timestamp: new Date().toISOString(),
    },
    version: "1.0.0",
  };

  if (!state.token) {
    console.error("[bridge] cannot authenticate: no token available");
    console.error(
      "[bridge] please configure the auth token in extension options",
    );
    return;
  }

  sendBridgeMessage(message);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    const now = Date.now();
    if (now - lastHeartbeatAck > HEARTBEAT_TIMEOUT_MS) {
      console.warn("[bridge] heartbeat timeout detected, closing socket");
      ws.close();
      return;
    }
    sendBridgeMessage({
      type: "heartbeat",
      timestamp: new Date().toISOString(),
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function cleanupSocket() {
  stopHeartbeat();
  if (ws) {
    try {
      ws.close();
    } catch (_) {
      // ignore
    }
    ws = null;
  }
}

function scheduleReconnect() {
  reconnectAttempts += 1;
  connectToBridge();
}

function sendBridgeMessage(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn(
      "[bridge] cannot send, socket not open. readyState:",
      ws?.readyState,
    );
    return false;
  }
  try {
    // Ensure version field is always included
    const message = {
      ...payload,
      version: payload.version || BRIDGE_VERSION,
    };
    console.log(
      "[bridge] Sending message type:",
      message.type,
      "deliveryId:",
      message.deliveryId,
    );
    ws.send(JSON.stringify(message));
    return true;
  } catch (err) {
    console.error("[bridge] Failed to send message:", err);
    recordError(err);
    return false;
  }
}

function setupBattleCapture() {
  if (!chrome?.webRequest?.onCompleted) {
    console.warn("[capture] webRequest API unavailable");
    return;
  }
  const urls = BATTLE_ENDPOINTS.map((pattern) => pattern);

  // MV3: Use onCompleted instead of onBeforeRequest with blocking
  // Battle responses will be captured via content script message passing
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.method === "POST" && details.statusCode === 200) {
        // Signal content script to capture this request's response
        chrome.tabs
          .sendMessage(details.tabId, {
            type: "capture_battle_response",
            requestId: details.requestId,
            url: details.url,
          })
          .catch(() => {
            // Tab may not have content script, ignore
          });
      }
    },
    { urls },
    [], // No blocking in MV3
  );

  console.info("[capture] webRequest listener registered (non-blocking)");
}

function handleBattleRequest(details) {
  // Deprecated: No longer used with MV3 non-blocking approach
  // Battle capture now handled via content script interception
  console.warn("[capture] handleBattleRequest called but deprecated in MV3");
}

function decodeChunks(chunks) {
  // Keep for backward compatibility but no longer used
  let text = "";
  for (const chunk of chunks) {
    text += RESPONSE_DECODER.decode(chunk, { stream: true });
  }
  text += RESPONSE_DECODER.decode();
  return text;
}

function processBattleResponse(details, body, userId, gameId, category = "") {
  console.log("[BATTLE] processBattleResponse called");
  console.log(
    "[BATTLE] Context - userId:",
    userId,
    "gameId:",
    gameId,
    "category:",
    category || "(empty)",
  );
  console.log(
    "[BATTLE] Category parameter received:",
    typeof category,
    "value:",
    category,
  );
  const normalized = normalizeMatchPayload(body, userId, gameId, category);
  if (!normalized) {
    console.warn("[BATTLE] Failed to normalize match payload");
    return;
  }
  console.log("[BATTLE] Normalized match:", {
    match_id: normalized.match_id,
    result: normalized.result,
    order: normalized.order,
  });
  const now = Date.now();
  trimSeenMatches(now);
  const previous = seenMatches.get(normalized.match_id);
  if (previous && now - previous < DEDUPE_WINDOW_MS) {
    console.info("[BATTLE] duplicate match ignored", normalized.match_id);
    return;
  }
  seenMatches.set(normalized.match_id, now);
  console.log("[BATTLE] Forwarding match payload...");
  forwardMatchPayload(normalized, category);
}

function normalizeMatchPayload(
  body,
  contextUserId,
  contextGameId,
  category = "",
) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    console.error("[BATTLE] Failed to parse JSON:", err);
    return null;
  }

  console.log(
    "[BATTLE] Context - userId:",
    contextUserId,
    "gameId:",
    contextGameId,
  );

  console.log("[BATTLE] Response top-level keys:", Object.keys(data));

  // Helper to safely inspect object structure
  const inspectObject = (obj, name, maxDepth = 2) => {
    if (!obj || typeof obj !== "object") {
      console.log(`[BATTLE] ${name}:`, obj);
      return;
    }
    const keys = Object.keys(obj);
    console.log(`[BATTLE] ${name} has ${keys.length} keys:`, keys);
    if (maxDepth > 0 && keys.length > 0 && keys.length < 20) {
      keys.forEach((key) => {
        const val = obj[key];
        if (val && typeof val === "object" && !Array.isArray(val)) {
          console.log(`[BATTLE]   ${name}.${key} (object):`, Object.keys(val));
        } else {
          console.log(
            `[BATTLE]   ${name}.${key}:`,
            typeof val === "string" && val.length > 100
              ? `${val.substring(0, 100)}...`
              : val,
          );
        }
      });
    }
  };

  // Check for flat game result structure (gameId, scores, ranks)
  if (data?.gameId && data?.scores && data?.ranks) {
    console.log("[BATTLE] Detected flat game result structure");

    // Log detailed information about the response
    console.log("[BATTLE] gameId:", data.gameId);
    console.log("[BATTLE] scores:", data.scores);
    console.log("[BATTLE] ranks:", data.ranks);
    console.log("[BATTLE] metadata type:", typeof data.metadata);
    console.log("[BATTLE] metadata:", data.metadata);

    // Inspect frames array for player information
    if (data.frames && Array.isArray(data.frames) && data.frames.length > 0) {
      console.log("[BATTLE] frames array length:", data.frames.length);
      console.log("[BATTLE] first frame keys:", Object.keys(data.frames[0]));
      if (data.frames[0].agents) {
        console.log("[BATTLE] first frame agents:", data.frames[0].agents);
      }
      if (data.frames[0].view) {
        console.log("[BATTLE] first frame view:", data.frames[0].view);
      }
    }

    // Try to determine player index from various sources
    let playerIndex = null;

    // Method 1: Check frames array for agentId that matches contextUserId
    // In CodinGame responses, frames often contain agentId indicating which player's perspective
    if (contextUserId && data.frames && Array.isArray(data.frames)) {
      console.log("[BATTLE] Searching frames for player agentId...");
      for (const frame of data.frames) {
        if (frame.agentId !== undefined && frame.agentId !== -1) {
          // Found a frame with agentId - this is likely the player's index
          playerIndex = frame.agentId;
          console.log("[BATTLE] Player index from frame.agentId:", playerIndex);
          break;
        }
      }
    }

    // Method 2: Check if we have agents array with userId
    if (playerIndex === null && contextUserId && data.agents) {
      for (let i = 0; i < data.agents.length; i++) {
        if (
          data.agents[i] &&
          data.agents[i].codingamer &&
          data.agents[i].codingamer.userId === contextUserId
        ) {
          playerIndex = i;
          console.log(
            "[BATTLE] Player index from agents array matching userId:",
            playerIndex,
          );
          break;
        }
      }
    }

    // Method 3: Check metadata for player index information
    if (
      playerIndex === null &&
      data.metadata &&
      typeof data.metadata === "object"
    ) {
      if (typeof data.metadata.playerIndex === "number") {
        playerIndex = data.metadata.playerIndex;
        console.log(
          "[BATTLE] Player index from metadata.playerIndex:",
          playerIndex,
        );
      } else if (typeof data.metadata.agentId === "number") {
        playerIndex = data.metadata.agentId;
        console.log(
          "[BATTLE] Player index from metadata.agentId:",
          playerIndex,
        );
      }
    }

    // Method 4: Check top-level fields for player index
    if (playerIndex === null && typeof data.playerIndex === "number") {
      playerIndex = data.playerIndex;
      console.log("[BATTLE] Player index from data.playerIndex:", playerIndex);
    } else if (playerIndex === null && typeof data.agentId === "number") {
      playerIndex = data.agentId;
      console.log("[BATTLE] Player index from data.agentId:", playerIndex);
    }

    // Method 5: For arena replays, player 0 is typically the one who requested the replay
    // But we should validate this with the scores/ranks to ensure consistency
    if (playerIndex === null) {
      playerIndex = 0;
      console.log("[BATTLE] Using default player index 0 (replay requester)");
    }

    // Ensure playerIndex is valid
    if (typeof playerIndex !== "number" || playerIndex < 0 || playerIndex > 1) {
      console.warn(
        "[BATTLE] Invalid player index:",
        playerIndex,
        "- defaulting to 0",
      );
      playerIndex = 0;
    }

    // Determine result based on ranks (rank 0 = winner, higher rank = loser)
    const myRank = data.ranks[playerIndex];
    const opponentIndex = playerIndex === 0 ? 1 : 0;
    const opponentRank = data.ranks[opponentIndex];

    let result;
    if (myRank < opponentRank) {
      result = "WIN";
    } else if (myRank > opponentRank) {
      result = "LOSE";
    } else {
      result = "DRAW";
    }

    console.log(
      `[BATTLE] Player index: ${playerIndex}, My rank: ${myRank}, Opponent rank: ${opponentRank}, Result: ${result}`,
    );
    console.log(
      `[BATTLE] Player scores: [${data.scores[playerIndex]}] vs [${data.scores[opponentIndex]}]`,
    );

    const timestamp = new Date().toISOString();

    console.log(
      "[BATTLE] normalizeMatchPayload returning with category:",
      category || "(empty)",
    );
    return {
      match_id: String(data.gameId),
      result: result,
      order: playerIndex,
      timestamp: timestamp,
      stdout: data.stdout || "",
      stderr: data.stderr || "",
      category: category,
      metadata: {
        arena: Boolean(data?.arena ?? false),
        opponent: data?.opponent ?? "unknown",
        league: data?.league ?? "",
        language: data?.language ?? "",
        duration_ms: data?.duration_ms ?? null,
        timestamp: timestamp,
        playerIndex: playerIndex,
        scores: data.scores,
        ranks: data.ranks,
        frames: data.frames?.length ?? 0,
        tooltips: data.tooltips || [],
        refereeInput: data.refereeInput || "",
        rawResponse: data,
      },
    };
  }

  // Check for wrapped match structure
  const match =
    data?.gameResult || data?.currentGameResult || data?.match || null;

  console.log("[BATTLE] Match object found:", match ? "yes" : "no");

  if (!match) {
    console.warn(
      "[BATTLE] No match object found, inspecting response structure:",
    );
    inspectObject(data?.gameResult, "data.gameResult", 1);
    inspectObject(data?.currentGameResult, "data.currentGameResult", 1);
    inspectObject(data?.match, "data.match", 1);
    inspectObject(data, "data (top level)", 1);
    return null;
  }

  inspectObject(match, "match", 1);

  if (!match.id) {
    console.warn("[BATTLE] Match object exists but has no id property");
    return null;
  }
  const rawResult = (match.result || data?.result || "").toUpperCase();
  const normalizedResult = ["WIN", "LOSE", "DRAW"].includes(rawResult)
    ? rawResult
    : rawResult || "UNKNOWN";
  const orderCandidate = Number.isInteger(data?.startingIndex)
    ? data.startingIndex
    : match.playerIndex;
  const order = orderCandidate === 0 ? 0 : 1;
  const stdout = match.stdout || data?.stdout || data?.logs?.stdout || "";
  const stderr = match.stderr || data?.stderr || data?.logs?.stderr || "";
  const timestamp = new Date().toISOString();
  console.log(
    "[BATTLE] normalizeMatchPayload (fallback path) returning with category:",
    category || "(empty)",
  );
  return {
    match_id: String(match.id),
    result: normalizedResult,
    order: order,
    timestamp: timestamp,
    stdout,
    stderr,
    category: category,
    metadata: {
      arena: Boolean(data?.arena ?? match?.arena ?? false),
      opponent: match?.opponent ?? data?.opponent ?? "unknown",
      league: match?.league ?? data?.league ?? "",
      language: data?.language ?? "",
      duration_ms: match?.durationMs ?? data?.duration_ms ?? null,
      timestamp: timestamp,
      rawResponse: data,
    },
  };
}

function forwardMatchPayload(payload, category = "") {
  const deliveryId =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;

  // Ensure category is included in payload
  const payloadWithCategory = {
    ...payload,
    category: category || payload.category || "",
  };

  const message = {
    type: "match_data",
    payload: payloadWithCategory,
    deliveryId,
  };
  console.log("[BATTLE] Match queued for delivery:", deliveryId);
  console.log(
    "[BATTLE] Category in forwardMatchPayload:",
    category || "(empty)",
  );
  console.log(
    "[BATTLE] Final payload category:",
    payloadWithCategory.category || "(empty)",
  );
  console.log("[BATTLE] WebSocket state:", ws ? ws.readyState : "no socket");
  queueMatchDelivery(message);
}

function queueMatchDelivery(message) {
  console.log("[BATTLE] Adding to retry queue:", message.deliveryId);
  retryQueue.set(message.deliveryId, {
    deliveryId: message.deliveryId,
    payload: message.payload,
    attempts: 0,
    nextAttemptTs: Date.now(),
    lastError: null,
    manualRetry: false,
  });
  persistRetryQueue();
  console.log("[BATTLE] Retry queue size:", retryQueue.size);
  scheduleRetryProcessing(0);
}

function trimSeenMatches(now) {
  for (const [matchId, ts] of seenMatches.entries()) {
    if (now - ts > DEDUPE_WINDOW_MS) {
      seenMatches.delete(matchId);
    }
  }
}

function initializeRetryQueue() {
  if (!chrome?.storage?.local) {
    queueLoaded = true;
    return;
  }
  chrome.storage.local.get([STORAGE_QUEUE_KEY], (result) => {
    if (chrome.runtime.lastError) {
      console.warn("[retry] failed to load queue", chrome.runtime.lastError);
      queueLoaded = true;
      return;
    }
    const savedEntries = Array.isArray(result?.[STORAGE_QUEUE_KEY])
      ? result[STORAGE_QUEUE_KEY]
      : [];
    for (const entry of savedEntries) {
      if (!entry?.deliveryId) {
        continue;
      }
      retryQueue.set(entry.deliveryId, {
        deliveryId: entry.deliveryId,
        payload: entry.payload,
        attempts: entry.attempts || 0,
        nextAttemptTs: entry.nextAttemptTs || Date.now(),
        lastError: entry.lastError || null,
        manualRetry: Boolean(entry.manualRetry),
      });
    }
    queueLoaded = true;
    if (retryQueue.size > 0) {
      scheduleRetryProcessing(0);
    }
  });
}

function manualRetryAll() {
  if (retryQueue.size === 0) {
    return 0;
  }
  const count = retryQueue.size;
  const now = Date.now();
  for (const entry of retryQueue.values()) {
    entry.nextAttemptTs = now;
    entry.manualRetry = true;
  }
  persistRetryQueue();
  scheduleRetryProcessing(0);
  return count;
  console.info("[retry] manual resend triggered", {
    count: retryQueue.size,
    manual_retry: true,
  });
}

function getRetryQueueStatus() {
  return {
    ready: queueLoaded,
    pending: retryQueue.size,
    entries: Array.from(retryQueue.values()).map((entry) => ({
      deliveryId: entry.deliveryId,
      attempts: entry.attempts,
      nextAttemptTs: entry.nextAttemptTs,
      lastError: entry.lastError || null,
      manualRetry: Boolean(entry.manualRetry),
    })),
  };
}

function scheduleRetryProcessing(delay = 0) {
  if (retryQueue.size === 0) {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    return;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
  }
  retryTimer = setTimeout(() => {
    retryTimer = null;
    processRetryQueue();
  }, delay);
}

function processRetryQueue() {
  if (retryProcessing) {
    scheduleRetryProcessing(500);
    return;
  }
  if (!queueLoaded) {
    scheduleRetryProcessing(500);
    return;
  }
  if (retryQueue.size === 0) {
    return;
  }
  retryProcessing = true;
  const now = Date.now();
  let nextWake = null;

  for (const entry of retryQueue.values()) {
    if (entry.nextAttemptTs > now) {
      nextWake =
        nextWake === null
          ? entry.nextAttemptTs
          : Math.min(nextWake, entry.nextAttemptTs);
      continue;
    }
    const message = {
      type: "match_data",
      payload: {
        ...entry.payload,
        deliveryId: entry.deliveryId,
      },
      deliveryId: entry.deliveryId,
    };
    const sent = sendBridgeMessage(message);
    if (sent) {
      console.info(`[retry] sent payload ${entry.deliveryId}`, {
        manual_retry: Boolean(entry.manualRetry),
      });
      entry.manualRetry = false;
      entry.lastError = null;
    } else {
      entry.lastError = "BRIDGE_OFFLINE";
    }
    entry.attempts = Math.min(entry.attempts + 1, MAX_RETRY_ATTEMPTS - 1);
    const delay =
      RETRY_SCHEDULE_MS[Math.min(entry.attempts, RETRY_SCHEDULE_MS.length - 1)];
    entry.nextAttemptTs = now + delay;
    nextWake =
      nextWake === null
        ? entry.nextAttemptTs
        : Math.min(nextWake, entry.nextAttemptTs);
  }

  persistRetryQueue();
  retryProcessing = false;

  if (nextWake !== null && retryQueue.size > 0) {
    const delay = Math.max(nextWake - Date.now(), 250);
    scheduleRetryProcessing(delay);
  }
}

function acknowledgeDelivery(deliveryId) {
  if (!deliveryId || !retryQueue.has(deliveryId)) {
    return;
  }
  retryQueue.delete(deliveryId);
  persistRetryQueue();
  if (retryQueue.size === 0 && retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  } else if (retryQueue.size > 0) {
    scheduleRetryProcessing(0);
  }
}

function persistRetryQueue() {
  if (!chrome?.storage?.local) {
    return;
  }
  const serialized = Array.from(retryQueue.values()).map((entry) => ({
    deliveryId: entry.deliveryId,
    payload: entry.payload,
    attempts: entry.attempts,
    nextAttemptTs: entry.nextAttemptTs,
    lastError: entry.lastError || null,
    manualRetry: Boolean(entry.manualRetry),
  }));
  chrome.storage.local.set({ [STORAGE_QUEUE_KEY]: serialized }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[retry] failed to persist queue", chrome.runtime.lastError);
    }
  });
}

function recordError(err) {
  const message =
    typeof err === "string" ? err : err?.message || "unknown error";
  state.lastError = { message, timestamp: new Date().toISOString() };
  console.error("[bridge] error", message);
  if (typeof pushLog === "function") {
    pushLog("error", `[bridge] error: ${message}`);
  }
}

function dispatchSyncCode(message) {
  const requestId = message?.requestId;
  const payload = message?.payload || {};
  console.log("[SYNC] dispatchSyncCode called", {
    requestId,
    hasPayload: !!payload,
    ideTabsCount: ideTabs.size,
    ideTabs: Array.from(ideTabs.keys()),
    lastActiveIdeTabId,
  });
  if (!requestId) {
    console.warn("[sync] received sync_code without requestId");
    return;
  }
  const targetTabId = selectIdeTabId();
  console.log("[SYNC] Selected target tab:", targetTabId);
  if (!targetTabId) {
    console.warn("[SYNC] No IDE tab available for sync", {
      requestId,
      ideTabsRegistered: ideTabs.size,
    });
    pushLog("warn", `[sync] failed:${requestId}:EDITOR_NOT_FOUND`);
    const failure = buildSyncStatusMessage({
      requestId,
      status: "failure",
      reason: "EDITOR_NOT_FOUND",
      details: "No CodinGame IDE tab has reported ready",
    });
    emitSyncStatus(failure);
    return;
  }
  const dispatchedAt = Date.now();
  const timeoutId = setTimeout(
    () => handleSyncTimeout(requestId),
    SYNC_RESPONSE_TIMEOUT_MS,
  );
  pendingSyncRequests.set(requestId, {
    requestId,
    tabId: targetTabId,
    dispatchedAt,
    timeoutId,
    language: payload?.language || null,
    codeLength: typeof payload?.code === "string" ? payload.code.length : 0,
  });
  state.lastSync = {
    requestId,
    tabId: targetTabId,
    dispatchedAt,
  };
  chrome.tabs.sendMessage(
    targetTabId,
    { type: "sync_code", requestId, payload },
    (response) => {
      const meta = consumePendingSyncRequest(requestId);
      if (!meta) {
        return;
      }
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        handleSyncFailure(
          requestId,
          "EDITOR_UNRESPONSIVE",
          lastErr.message || "Content script unreachable",
          meta,
        );
        return;
      }
      if (!response || response.type !== "sync_status") {
        handleSyncFailure(
          requestId,
          "INVALID_SYNC_RESPONSE",
          "Content script did not return sync_status",
          meta,
        );
        return;
      }
      handleTabSyncResponse(requestId, response, meta);
    },
  );
  pushLog("info", `[sync] dispatched:${requestId}`, { tabId: targetTabId });
}

function handleTabSyncResponse(requestId, response, meta) {
  const durationMs = meta?.dispatchedAt ? Date.now() - meta.dispatchedAt : null;
  const statusMessage = buildSyncStatusMessage({
    requestId,
    status: response.status || "success",
    changed: Boolean(response.changed),
    strategy: response.strategy || null,
    reason: response.reason || null,
    details: response.reason || null,
    tabId: meta?.tabId || null,
    durationMs,
    language: meta?.language || null,
    codeLength: meta?.codeLength ?? null,
  });
  emitSyncStatus(statusMessage);
  state.lastSync = null;
  state.lastSyncResult = { ...statusMessage.payload, requestId };
  const level = statusMessage.payload.status === "success" ? "info" : "warn";
  pushLog(level, `[sync] status:${requestId}:${statusMessage.payload.status}`, {
    tabId: meta?.tabId || null,
    durationMs,
  });
}

function handleSyncFailure(requestId, reason, details, metaOverride = null) {
  const meta = metaOverride || consumePendingSyncRequest(requestId) || {};
  const durationMs = meta.dispatchedAt ? Date.now() - meta.dispatchedAt : null;
  const statusMessage = buildSyncStatusMessage({
    requestId,
    status: "failure",
    reason,
    details: details || reason,
    tabId: meta.tabId || null,
    durationMs,
    language: meta.language || null,
    codeLength: meta.codeLength ?? null,
  });
  emitSyncStatus(statusMessage);
  state.lastSync = null;
  state.lastSyncResult = { ...statusMessage.payload, requestId };
  pushLog("warn", `[sync] failure:${requestId}:${reason}`, {
    tabId: meta.tabId || null,
    details: details || reason,
  });
}

function handleSyncTimeout(requestId) {
  const meta = consumePendingSyncRequest(requestId);
  if (!meta) {
    return;
  }
  handleSyncFailure(
    requestId,
    "EDITOR_TIMEOUT",
    "Content script response timed out",
    meta,
  );
}

function buildSyncStatusMessage({
  requestId,
  status,
  changed = false,
  strategy = null,
  reason = null,
  details = null,
  tabId = null,
  durationMs = null,
  language = null,
  codeLength = null,
}) {
  return {
    type: "sync_status",
    requestId,
    payload: {
      status,
      changed,
      strategy,
      details: details || reason || null,
      reason: reason || null,
      tabId,
      durationMs,
      language,
      codeLength,
      timestamp: new Date().toISOString(),
    },
  };
}

function emitSyncStatus(message) {
  const sent = sendBridgeMessage(message);
  if (sent) {
    return;
  }
  if (deferredSyncStatuses.length >= MAX_DEFERRED_SYNC_STATUSES) {
    deferredSyncStatuses.shift();
  }
  deferredSyncStatuses.push(message);
  pushLog("warn", `[sync] cached status:${message.requestId}`, {
    reason: "BRIDGE_OFFLINE",
  });
}

function flushDeferredSyncStatuses() {
  if (!state.connected || deferredSyncStatuses.length === 0) {
    return;
  }
  const pending = deferredSyncStatuses.splice(0);
  for (let i = 0; i < pending.length; i += 1) {
    const message = pending[i];
    const sent = sendBridgeMessage(message);
    if (!sent) {
      const remaining = pending.slice(i);
      deferredSyncStatuses.unshift(...remaining);
      break;
    }
  }
}

function consumePendingSyncRequest(requestId) {
  if (!pendingSyncRequests.has(requestId)) {
    return null;
  }
  const meta = pendingSyncRequests.get(requestId);
  pendingSyncRequests.delete(requestId);
  if (meta?.timeoutId) {
    clearTimeout(meta.timeoutId);
  }
  return meta;
}

function selectIdeTabId() {
  pruneIdeTabCache();
  if (lastActiveIdeTabId && ideTabs.has(lastActiveIdeTabId)) {
    return lastActiveIdeTabId;
  }
  let candidate = null;
  for (const entry of ideTabs.values()) {
    if (!candidate) {
      candidate = entry;
      continue;
    }
    const candidateScore = candidate.lastActiveTs || candidate.lastReadyTs || 0;
    const entryScore = entry.lastActiveTs || entry.lastReadyTs || 0;
    if (entryScore > candidateScore) {
      candidate = entry;
    }
  }
  return candidate?.tabId || null;
}

function registerIdeTab(tab, payload = {}) {
  if (!tab?.id || !isCodinGameUrl(tab.url)) {
    console.log(
      "[TAB] Skipping tab registration - invalid tab or non-CodinGame URL",
      {
        tabId: tab?.id,
        url: tab?.url,
      },
    );
    return;
  }
  const now = Date.now();
  const existing = ideTabs.get(tab.id) || {};
  ideTabs.set(tab.id, {
    tabId: tab.id,
    url: tab.url || existing.url || "",
    lastReadyTs: now,
    lastActiveTs: now,
    language: payload.language || existing.language || null,
  });
  lastActiveIdeTabId = tab.id;
  console.log("[TAB] IDE tab registered", {
    tabId: tab.id,
    url: tab.url,
    language: payload.language,
    totalIdeTabs: ideTabs.size,
  });
  pushLog("info", `[TAB] Registered IDE tab ${tab.id}`);
}

function markIdeTabActive(tabId) {
  if (!tabId) {
    return;
  }
  const entry = ideTabs.get(tabId);
  const now = Date.now();
  if (entry) {
    entry.lastActiveTs = now;
    ideTabs.set(tabId, entry);
  }
  lastActiveIdeTabId = tabId;
}

function unregisterIdeTab(tabId) {
  if (!ideTabs.has(tabId)) {
    return;
  }
  ideTabs.delete(tabId);
  if (lastActiveIdeTabId === tabId) {
    lastActiveIdeTabId = null;
  }
}

function pruneIdeTabCache() {
  const now = Date.now();
  for (const [tabId, entry] of ideTabs.entries()) {
    const age = now - (entry.lastReadyTs || now);
    if (age > IDE_TAB_IDLE_TTL_MS) {
      ideTabs.delete(tabId);
      if (lastActiveIdeTabId === tabId) {
        lastActiveIdeTabId = null;
      }
    }
  }
}

function isCodinGameUrl(url) {
  return typeof url === "string" && url.includes("codingame.com");
}

function initializeLogs() {
  if (!chrome?.storage?.local) {
    logsLoaded = true;
    return;
  }
  chrome.storage.local.get([LOG_STORAGE_KEY], (result) => {
    if (chrome.runtime.lastError) {
      console.warn("[logs] failed to load", chrome.runtime.lastError);
      logsLoaded = true;
      return;
    }
    const stored = result?.[LOG_STORAGE_KEY];
    logs = Array.isArray(stored) ? stored : [];
    logsLoaded = true;
  });
}

function pushLog(level, message, context = null) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level,
    message,
    context: context || null,
    timestamp: new Date().toISOString(),
  };
  logs.push(entry);
  if (logs.length > MAX_LOG_ENTRIES) {
    logs.splice(0, logs.length - MAX_LOG_ENTRIES);
  }
  persistLogs();
}

function persistLogs() {
  if (!chrome?.storage?.local) {
    return;
  }
  chrome.storage.local.set({ [LOG_STORAGE_KEY]: logs }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[logs] failed to persist", chrome.runtime.lastError);
    }
  });
}

function clearLogs() {
  logs = [];
  persistLogs();
}

function getPopupStatus() {
  return {
    ...state,
    lastHeartbeatAck,
    pendingDeliveries: retryQueue.size,
    ideTabs: Array.from(ideTabs.values()).map((entry) => ({
      tabId: entry.tabId,
      url: entry.url,
      lastReadyTs: entry.lastReadyTs,
      lastActiveTs: entry.lastActiveTs,
    })),
    logs: logs.slice(-50),
  };
}

// Initialize subsystems after all functions are defined
setupBattleCapture();
initializeRetryQueue();
initializeLogs();

// Debug helper for console access (since module scope variables aren't accessible from DevTools console)
self.debugCG = {
  getState: () => ({
    connected: state.connected,
    hasToken: !!state.token,
    ideTabsCount: ideTabs.size,
    ideTabs: Array.from(ideTabs.entries()),
    lastActiveTabId: lastActiveIdeTabId,
    pendingSyncRequests: Array.from(pendingSyncRequests.entries()),
    lastSync: state.lastSync,
    lastSyncResult: state.lastSyncResult,
    wsState: ws ? ws.readyState : null,
    wsStateText: ws
      ? ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][ws.readyState]
      : "NULL",
  }),

  showState: () => {
    const state = self.debugCG.getState();
    console.log("=== CodinGame Extension State ===");
    console.log("Connected:", state.connected);
    console.log("Has Token:", state.hasToken);
    console.log("WebSocket:", state.wsStateText);
    console.log("IDE Tabs Count:", state.ideTabsCount);
    console.log("Last Active Tab:", state.lastActiveTabId);
    console.log("Last Sync:", state.lastSync);
    console.log("Last Sync Result:", state.lastSyncResult);
    console.log("Pending Sync Requests:", state.pendingSyncRequests.length);
    console.log("================================");
    return state;
  },

  listTabs: () => {
    console.log("=== IDE Tabs ===");
    console.log("Count:", ideTabs.size);
    ideTabs.forEach((tab, id) => {
      console.log(`Tab ${id}:`, tab);
    });
    console.log("================");
  },

  testSync: () => {
    const testRequestId = "console_test_" + Date.now();
    console.log("=== Testing Manual Sync ===");
    console.log("Request ID:", testRequestId);
    dispatchSyncCode({
      type: "sync_code",
      requestId: testRequestId,
      payload: {
        language: "Python3",
        code: 'print("Console test from debugCG.testSync()")',
        stripComments: false,
        fileName: "test.py",
      },
    });
    console.log("Test dispatched - watch for [sync] logs above");
  },

  forceRegister: async () => {
    console.log("=== Manually Registering Current Tab ===");
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) {
      console.error("✗ No active tab found");
      return false;
    }
    console.log("Active tab:", tab.id, tab.url);
    if (!tab.url.includes("codingame.com")) {
      console.warn("✗ Current tab is not CodinGame!");
      return false;
    }
    registerIdeTab(tab, { language: "Python3", strategy: "manual" });
    console.log("✓ Tab registered:", tab.id);
    self.debugCG.showState();
    return true;
  },

  clearState: () => {
    console.log("=== Clearing State ===");
    ideTabs.clear();
    lastActiveIdeTabId = null;
    pendingSyncRequests.clear();
    state.lastSync = null;
    state.lastSyncResult = null;
    console.log("State cleared");
    self.debugCG.showState();
  },

  checkContentScript: async () => {
    console.log("=== Checking Content Script Status ===");
    const tabs = await chrome.tabs.query({
      url: "https://www.codingame.com/*",
    });
    console.log("Found", tabs.length, "CodinGame tabs");

    for (const tab of tabs) {
      console.log(`\nChecking tab ${tab.id}:`, tab.url);
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "ping_editor",
        });
        console.log("  ✓ Content script response:", response);
        console.log("  Registered in ideTabs:", ideTabs.has(tab.id));
      } catch (err) {
        console.error("  ✗ Content script error:", err.message);
      }
    }
  },

  checkBattleQueue: () => {
    console.log("=== Battle Queue Status ===");
    console.log(
      "WebSocket State:",
      ws ? ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][ws.readyState] : "NULL",
    );
    console.log(
      "WebSocket Connected:",
      ws && ws.readyState === WebSocket.OPEN ? "YES ✓" : "NO ✗",
    );
    console.log("Queue Size:", retryQueue.size);
    console.log("Queue Loaded:", queueLoaded);
    console.log("");

    if (retryQueue.size === 0) {
      console.log("No battles in queue");
    } else {
      console.log("Queued Battles:");
      let ready = 0;
      let pending = 0;
      const now = Date.now();

      retryQueue.forEach((entry, id) => {
        const waitTime = entry.nextAttemptTs - now;
        const isReady = waitTime <= 0;
        if (isReady) ready++;
        else pending++;

        console.log(`  ${id}:`);
        console.log(`    Attempts: ${entry.attempts}/${MAX_RETRY_ATTEMPTS}`);
        console.log(
          `    Status: ${isReady ? "READY" : `WAITING ${Math.ceil(waitTime / 1000)}s`}`,
        );
        console.log(`    Last Error: ${entry.lastError || "none"}`);
        console.log(`    Match ID: ${entry.payload?.match_id || "unknown"}`);
      });

      console.log("");
      console.log(`Summary: ${ready} ready, ${pending} pending`);

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log("");
        console.log("⚠️  WARNING: WebSocket is NOT connected!");
        console.log(
          "   Battles cannot be sent to VS Code until WebSocket connects.",
        );
        console.log("   1. Make sure VS Code extension is running");
        console.log("   2. Check auth token is configured");
        console.log("   3. Check VS Code extension logs for connection errors");
      }
    }
    console.log("==========================");
  },

  checkSeenMatches: () => {
    console.log("=== Duplicate Detection Status ===");
    console.log("Seen matches count:", seenMatches.size);
    console.log("Dedupe window:", DEDUPE_WINDOW_MS, "ms");
    console.log("");

    if (seenMatches.size === 0) {
      console.log("No matches in seen cache");
    } else {
      console.log("Recent matches (last 10):");
      const now = Date.now();
      const entries = Array.from(seenMatches.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      entries.forEach(([matchId, timestamp]) => {
        const ageSeconds = Math.floor((now - timestamp) / 1000);
        console.log(`  ${matchId}: ${ageSeconds}s ago`);
      });
    }
    console.log("==================================");
  },

  clearSeenMatches: () => {
    const count = seenMatches.size;
    seenMatches.clear();
    console.log("=== Cleared Seen Matches ===");
    console.log(`Removed ${count} matches from duplicate detection cache`);
    console.log("You can now re-capture battles that were previously seen");
    console.log("============================");
    return count;
  },

  testSendBattle: () => {
    console.log("=== Test Send Battle ===");

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error("✗ WebSocket is NOT connected - cannot send test battle");
      console.log("WebSocket state:", ws ? ws.readyState : "null");
      return false;
    }

    console.log("✓ WebSocket is OPEN");

    // Create a minimal test battle payload
    const testPayload = {
      match_id: "test_" + Date.now(),
      result: "WIN",
      order: 0,
      timestamp: new Date().toISOString(),
      stdout: "Test battle from debugCG.testSendBattle()",
      stderr: "",
      metadata: {
        arena: true,
        opponent: "TestBot",
        league: "Wood 1",
        language: "Python3",
        duration_ms: 100,
        timestamp: new Date().toISOString(),
      },
    };

    const deliveryId = crypto?.randomUUID
      ? crypto.randomUUID()
      : `test_${Date.now()}`;

    const message = {
      type: "match_data",
      payload: testPayload,
      deliveryId: deliveryId,
      version: BRIDGE_VERSION,
    };

    console.log("Sending test battle with deliveryId:", deliveryId);
    console.log("Payload:", testPayload);

    try {
      const sent = sendBridgeMessage(message);
      if (sent) {
        console.log("✓ Test battle sent successfully!");
        console.log(
          "Check VS Code Output panel (select 'CodinGame' channel) for:",
        );
        console.log("  [BRIDGE] ← Received match_data");
        console.log("  [MATCH] Processing match data");
        console.log("  [MATCH] Match stored and acknowledged");
        return true;
      } else {
        console.error("✗ sendBridgeMessage returned false");
        return false;
      }
    } catch (error) {
      console.error("✗ Error sending test battle:", error);
      return false;
    }
  },
};

console.log("%c[DEBUG] Debug helper loaded", "color: green; font-weight: bold");
console.log("Available commands:");
console.log(
  "  self.debugCG.showState()          - Show current extension state",
);
console.log(
  "  self.debugCG.listTabs()           - List all registered IDE tabs",
);
console.log("  self.debugCG.testSync()           - Send test sync command");
console.log(
  "  self.debugCG.forceRegister()      - Manually register current tab",
);
console.log("  self.debugCG.clearState()         - Clear all state");
console.log(
  "  self.debugCG.checkContentScript() - Check content script status",
);
console.log(
  "  self.debugCG.checkBattleQueue()   - Check battle queue & WebSocket",
);
console.log(
  "  self.debugCG.checkSeenMatches()   - Check duplicate detection cache",
);
console.log(
  "  self.debugCG.clearSeenMatches()   - Clear duplicate detection (re-capture)",
);
console.log(
  "  self.debugCG.testSendBattle()     - Send test battle to VS Code",
);
console.log("");
console.log("Quick start: self.debugCG.showState()");
console.log("Battle debugging: self.debugCG.checkBattleQueue()");
console.log("Test connection: self.debugCG.testSendBattle()");

// Load auth token from storage and connect to bridge
chrome.storage.local.get(["cg_auth_token"], (result) => {
  if (result.cg_auth_token) {
    state.token = result.cg_auth_token;
    console.info("[bridge] loaded auth token from storage");
    pushLog("info", "Auth token loaded from storage");
    // Automatically connect after loading token
    connectToBridge();
  } else {
    console.warn(
      "[bridge] no auth token found in storage - connection will fail",
    );
    console.warn(
      "[bridge] please configure the auth token in extension options",
    );
    pushLog(
      "warn",
      "No auth token configured - please set token in extension options",
    );
  }
});
