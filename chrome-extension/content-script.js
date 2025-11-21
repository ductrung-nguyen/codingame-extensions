(() => {
  // Guard against multiple injections
  if (window.__cgContentScriptLoaded) {
    console.log("[CodinGame Content Script] Already loaded, skipping");
    return;
  }
  window.__cgContentScriptLoaded = true;

  const EDITOR_POLL_INTERVAL_MS = 500;
  const EDITOR_POLL_TIMEOUT_MS = 20000;
  const STATUS_FADE_TIMEOUT_MS = 2500;
  const BATTLE_ENDPOINTS = [
    "/services/TestSession/run",
    "/services/TestSession/start",
    "/services/TestSession/submit",
    "/services/TestSession/play",
    "/services/gameResult/",
    "/services/Arena/",
    "/services/Challenge/",
    "/services/gameResult/findByGameId",
    "/services/gamesPlayersRanking/findLastBattlesByAgentId",
  ];

  let editorCache = null;
  let overlayEl = null;
  let overlayTimer = null;

  // Battle capture variables (must be declared before init() call)
  let captureButton = null;
  let capturePanel = null;
  let pauseResumeButton = null;
  let stopButton = null;
  let categoryInput = null;
  let captureStatusText = null;
  let availableBattles = []; // Store battles from findLastBattlesByAgentId
  let capturedBattleIds = new Set();
  let continuousMonitoring = false;
  let monitoringInterval = null;
  let capturePaused = false;
  let captureInProgress = false;
  let captureShouldStop = false;
  let captureCategory = "";
  let currentTeamName = "";
  let panelCaptureButton = null;
  let lastBattlesPanelObserver = null;
  let currentAgentId = null; // Track the agentId when viewing battles

  console.log("[CodinGame Content Script] Loading...");

  // Check if extension context is valid
  function isExtensionContextValid() {
    try {
      // Try to access chrome.runtime
      if (!chrome || !chrome.runtime || !chrome.runtime.id) {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // Early validation
  if (!isExtensionContextValid()) {
    console.error(
      "[CodinGame Content Script] Extension context is invalid. Please reload the page.",
    );
    // Show notification to user
    const warning = document.createElement("div");
    warning.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 99999;
      padding: 16px 20px;
      background: #fee;
      border: 2px solid #f88;
      border-radius: 8px;
      color: #c00;
      font-family: -apple-system, sans-serif;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    `;
    warning.textContent = "⚠️ CodinGame extension needs page reload";
    document.body?.appendChild(warning);
    setTimeout(() => warning.remove(), 10000);
    return;
  }

  // Inject page script as external file (CSP-compliant)
  // This runs in page context where window.angular is accessible
  function injectPageScript() {
    console.log(
      "[CodinGame Content Script] Injecting page script (CSP-compliant)...",
    );
    const script = document.createElement("script");
    script.id = "__cg_page_script";
    script.src = chrome.runtime.getURL("page-script.js");
    script.onload = function () {
      console.log(
        "[CodinGame Content Script] ✅ Page script loaded successfully",
      );
      this.remove();
    };
    script.onerror = function () {
      console.error("[CodinGame Content Script] ❌ Failed to load page script");
      this.remove();
    };

    const target = document.head || document.documentElement;
    if (target) {
      target.appendChild(script);
      console.log("[CodinGame Content Script] Script element added to DOM");
    } else {
      console.error(
        "[CodinGame Content Script] ❌ Cannot inject: no head or documentElement",
      );
    }
  }

  // Inject immediately if document is ready, otherwise wait
  if (document.readyState === "loading") {
    console.log(
      "[CodinGame Content Script] Document loading, waiting for DOMContentLoaded...",
    );
    document.addEventListener("DOMContentLoaded", injectPageScript);
  } else {
    console.log("[CodinGame Content Script] Document ready, injecting now...");
    injectPageScript();
  }

  // Listen for the custom event from page context (test function)
  window.addEventListener("__cgTestSync", (event) => {
    console.log("[CodinGame Content Script] Received test sync event");
    const testMessage = {
      type: "sync_code",
      requestId: "console-test-" + Date.now(),
      payload: {
        code: event.detail.code,
        language: event.detail.language,
      },
    };

    // Call the message listener directly
    if (window.__cgMessageListener) {
      console.log("[CodinGame Content Script] Calling message listener...");
      const mockSender = { tab: { id: -1 } };
      const mockSendResponse = (response) => {
        console.log("[TEST] Response:", response);
      };
      const result = window.__cgMessageListener(
        testMessage,
        mockSender,
        mockSendResponse,
      );
      console.log("[TEST] Message listener returned:", result);
    } else {
      console.error(
        "[TEST] Message listener not found! Wait for init() to complete.",
      );
    }
  });

  // Listen for battle list from page script
  window.addEventListener("__cgBattleListCaptured", (event) => {
    console.log(
      "[CodinGame Content Script] Received battle list from page script",
    );
    const { battles, teamName } = event.detail;
    if (battles && battles.length > 0) {
      availableBattles = battles;
      console.log(
        `[CodinGame Content Script] Stored ${battles.length} battles from leaderboard`,
      );

      // Use team name from the API response (most reliable source)
      if (teamName) {
        console.log(
          `[CodinGame Content Script] Auto-detected team name from API: "${teamName}"`,
        );
        setDefaultCategory(teamName, true); // Force update from API
      } else {
        console.log(
          "[CodinGame Content Script] No team name in API response, trying DOM extraction...",
        );

        // Fallback: try to extract from DOM
        const domTeamName = extractTeamName();
        if (domTeamName) {
          console.log(
            `[CodinGame Content Script] Extracted team name from DOM: "${domTeamName}"`,
          );
          currentTeamName = domTeamName;
          setDefaultCategory(domTeamName);
        }
      }

      showStatus(
        `${battles.length} battles loaded. Click capture button to save them.`,
        "success",
      );
    }
  });

  // Listen for battle response capture events from page-script.js
  window.addEventListener("__cgBattleResponseCaptured", (event) => {
    console.log(
      "[CodinGame Content Script] Received battle response from page script",
    );
    const { url, body } = event.detail;

    console.log("[CodinGame Content Script] Battle URL:", url);
    console.log("[CodinGame Content Script] Body length:", body?.length);
    console.log(
      "[CodinGame Content Script] Forwarding to background script...",
    );

    // Forward to background script
    // Note: userId and gameId will be extracted by background script from the response body
    chrome.runtime
      .sendMessage({
        type: "battle_response_captured",
        payload: { url, body },
      })
      .then(() => {
        console.log(
          "[CodinGame Content Script] Battle response message sent successfully to background",
        );
      })
      .catch((err) => {
        console.error(
          "[CodinGame Content Script] Failed to notify background:",
          err,
        );
        console.error(
          "[CodinGame Content Script] Error details:",
          err.message,
          err.stack,
        );
      });
  });

  // Listen for sync responses from page script
  const pendingSyncRequests = new Map();

  window.addEventListener("__cgSyncCodeResponse", (event) => {
    console.log(
      "[CodinGame Content Script] Received sync response from page script",
    );
    const { requestId, result } = event.detail;

    const resolver = pendingSyncRequests.get(requestId);
    if (resolver) {
      resolver(result);
      pendingSyncRequests.delete(requestId);
    } else {
      console.warn(
        "[CodinGame Content Script] No pending request found for:",
        requestId,
      );
    }
  });

  // Function to sync code via page script (uses Angular)
  function syncViaPageScript(code, requestId) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingSyncRequests.delete(requestId);
        reject(new Error("Page script sync timeout"));
      }, 5000);

      pendingSyncRequests.set(requestId, (result) => {
        clearTimeout(timeoutId);
        resolve(result);
      });

      // Send request to page script
      const event = new CustomEvent("__cgSyncCodeRequest", {
        detail: { code, requestId },
      });
      window.dispatchEvent(event);
      console.log(
        "[CodinGame Content Script] Sent sync request to page script",
      );
    });
  }

  console.log("[CodinGame Content Script] Test function listener registered");

  // Helper function to normalize language for comparison
  function normalizeLanguageForComparison(lang) {
    if (!lang) return "";

    // Convert to lowercase and remove spaces, hyphens, dots
    return lang.toLowerCase().replace(/[\s\-\.]/g, "");
  }

  // Function to check if two languages match (with fuzzy matching)
  function languagesMatch(lang1, lang2) {
    if (!lang1 || !lang2) return false;

    const normalized1 = normalizeLanguageForComparison(lang1);
    const normalized2 = normalizeLanguageForComparison(lang2);

    // Exact match after normalization
    if (normalized1 === normalized2) return true;

    // Check common variations
    const variations = {
      python3: ["python", "python3", "py3", "py"],
      javascript: ["js", "javascript"],
      typescript: ["ts", "typescript"],
      cpp: ["c++", "cpp", "cplusplus"],
      csharp: ["c#", "csharp", "cs"],
      fsharp: ["f#", "fsharp", "fs"],
      vbnet: ["vb", "vbnet", "vb.net", "visualbasic"],
      objectivec: ["objc", "objectivec", "objective-c"],
      rust: ["rust", "rs"],
      kotlin: ["kotlin", "kt"],
      swift: ["swift"],
    };

    for (const [key, values] of Object.entries(variations)) {
      if (
        (values.includes(normalized1) && values.includes(normalized2)) ||
        (key === normalized1 && values.includes(normalized2)) ||
        (key === normalized2 && values.includes(normalized1))
      ) {
        return true;
      }
    }

    return false;
  }

  // Function to detect current language from page
  function detectPageLanguage() {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve(null);
      }, 1000);

      const listener = (event) => {
        clearTimeout(timeoutId);
        window.removeEventListener("__cgLanguageDetected", listener);
        resolve(event.detail.language);
      };

      window.addEventListener("__cgLanguageDetected", listener);

      // Request language detection from page script
      const event = new CustomEvent("__cgDetectLanguage");
      window.dispatchEvent(event);
    });
  }

  init();

  function init() {
    console.log("[CodinGame Content Script] Initializing...");

    // Retry editor detection with longer intervals to wait for Angular
    const attemptEditorDetection = (attempt = 1, maxAttempts = 5) => {
      console.log(
        `[CodinGame Content Script] Detection attempt ${attempt}/${maxAttempts}...`,
      );

      // Use longer timeout for Angular to initialize (up to 20 seconds)
      waitForEditor(20000)
        .then((ctx) => {
          console.log(
            "[CodinGame Content Script] Editor detected:",
            ctx.strategy,
          );
          editorCache = ctx;
          notifyBackground({
            type: "editor_ready",
            payload: { strategy: ctx.strategy },
          });
          showStatus(`Editor ready (${ctx.strategy})`, "ready");
          console.log(
            "[CodinGame Content Script] Sent editor_ready to background",
          );
        })
        .catch((err) => {
          console.warn(
            `[CodinGame Content Script] Attempt ${attempt} failed:`,
            err.message,
          );

          if (attempt < maxAttempts) {
            console.log(`[CodinGame Content Script] Retrying in 5 seconds...`);
            showStatus(
              `Waiting for editor (attempt ${attempt}/${maxAttempts})...`,
              "pending",
            );
            setTimeout(
              () => attemptEditorDetection(attempt + 1, maxAttempts),
              5000,
            );
          } else {
            console.error(
              "[CodinGame Content Script] Editor not found after",
              maxAttempts,
              "attempts",
            );
            showStatus("Editor not found - please reload page", "error");
          }
        });
    };

    attemptEditorDetection();

    // Intercept fetch/XHR for battle response capture (MV3 compatible)
    interceptBattleRequests();

    // Auto-injection disabled - was causing UI bugs by injecting into leaderboard rows
    // Users should use the floating "📊 Capture All Battles" button

    const messageListener = (message, _sender, sendResponse) => {
      console.log(
        "[CodinGame Content Script] Message listener called with type:",
        message?.type,
      );

      if (!message?.type) {
        console.log("[CodinGame Content Script] Message has no type, ignoring");
        return false;
      }

      if (message.type === "ping_editor") {
        console.log("[CodinGame Content Script] Responding to ping_editor");
        sendResponse({ status: editorCache ? "ready" : "pending" });
        return true;
      }

      if (message.type === "sync_code") {
        console.log(
          "[CodinGame Content Script] ======================================",
        );
        console.log("[CodinGame Content Script] SYNC MESSAGE RECEIVED!");
        console.log(
          "[CodinGame Content Script] ======================================",
        );
        console.log("[CodinGame Content Script] Message:", {
          requestId: message.requestId,
          codeLength: message.payload?.code?.length,
          language: message.payload?.language,
        });
        console.log(
          "[CodinGame Content Script] Current editor cache:",
          editorCache?.strategy || "none",
        );
        console.log(
          "[CodinGame Content Script] About to call handleSyncRequest...",
        );
        console.log(
          "[CodinGame Content Script] sendResponse available:",
          typeof sendResponse,
        );

        // Handle async operation properly
        handleSyncRequest(message, sendResponse)
          .then(() => {
            console.log(
              "[CodinGame Content Script] handleSyncRequest completed successfully",
            );
          })
          .catch((err) => {
            console.error(
              "[CodinGame Content Script] Unhandled error in handleSyncRequest:",
              err,
            );
            console.error("[CodinGame Content Script] Error stack:", err.stack);
          });
        return true; // keep sendResponse async
      }

      if (message.type === "capture_battle_response") {
        console.log(
          "[CodinGame Content Script] Responding to capture_battle_response",
        );
        // Background notified us of a battle request, but we're already intercepting
        sendResponse({ ok: true });
        return true;
      }

      console.log(
        "[CodinGame Content Script] Unknown message type:",
        message.type,
      );
      return false;
    };

    chrome.runtime.onMessage.addListener(messageListener);
    console.log("[CodinGame Content Script] Message listener registered");

    // Store reference for testing
    window.__cgMessageListener = messageListener;
  }

  function interceptBattleRequests() {
    // NOTE: Battle interception moved to page-script.js
    // Content scripts run in an isolated world and cannot intercept
    // fetch/XHR calls made by the page's JavaScript.
    // The page script will intercept requests and send events to this content script.
    console.log(
      "[CodinGame Content Script] Battle interception delegated to page script",
    );
  }

  function isBattleEndpoint(url) {
    if (!url) return false;
    return BATTLE_ENDPOINTS.some((endpoint) => url.includes(endpoint));
  }

  // NOTE: This function is no longer called from content script
  // Battle responses are captured in page-script.js and sent via custom events
  // The event listener above (for '__cgBattleResponseCaptured') handles forwarding to background

  async function handleSyncRequest(message, sendResponse) {
    console.log(
      "[CodinGame Content Script] ========================================",
    );
    console.log("[CodinGame Content Script] handleSyncRequest ENTERED");
    console.log(
      "[CodinGame Content Script] ========================================",
    );
    console.log("[CodinGame Content Script] Message object:", message);
    console.log(
      "[CodinGame Content Script] sendResponse type:",
      typeof sendResponse,
    );
    const { requestId, payload } = message;
    console.log("[CodinGame Content Script] Request ID:", requestId);
    console.log(
      "[CodinGame Content Script] Payload code length:",
      payload?.code?.length,
    );

    const responseBase = {
      type: "sync_status",
      requestId,
      timestamp: new Date().toISOString(),
    };

    try {
      console.log("[CodinGame Content Script] Getting editor context...");
      console.log(
        "[CodinGame Content Script] Current cache:",
        editorCache?.strategy || "none",
      );

      // IMPORTANT: First try to use page script (Angular method)
      // This is the most reliable method when Angular is available
      console.log(
        "[CodinGame Content Script] Attempting sync via page script (Angular)...",
      );

      // First, detect and validate language
      const detectedLanguage = await detectPageLanguage();
      const requestedLanguage = payload?.language;

      console.log("[CodinGame Content Script] Language check:", {
        detected: detectedLanguage,
        requested: requestedLanguage,
        match: languagesMatch(detectedLanguage, requestedLanguage),
      });

      if (
        detectedLanguage &&
        requestedLanguage &&
        !languagesMatch(detectedLanguage, requestedLanguage)
      ) {
        console.warn("[CodinGame Content Script] ⚠️ Language mismatch!");
        console.warn(
          "[CodinGame Content Script] CodinGame language:",
          detectedLanguage,
        );
        console.warn(
          "[CodinGame Content Script] VS Code language:",
          requestedLanguage,
        );

        showStatus(
          `Language mismatch: ${requestedLanguage} → ${detectedLanguage}`,
          "error",
        );

        const response = {
          ...responseBase,
          status: "failure",
          reason: `Language mismatch: VS Code has ${requestedLanguage} but CodinGame is using ${detectedLanguage}. Please ensure you're syncing the correct language file.`,
          details: {
            detectedLanguage,
            requestedLanguage,
          },
        };

        try {
          sendResponse(response);
        } catch (sendErr) {
          console.error(
            "[CodinGame Content Script] Error calling sendResponse:",
            sendErr,
          );
        }

        console.log(
          "[CodinGame Content Script] handleSyncRequest aborted due to language mismatch",
        );
        return;
      }

      try {
        const pageScriptResult = await syncViaPageScript(
          payload?.code ?? "",
          requestId,
        );
        console.log(
          "[CodinGame Content Script] Page script result:",
          pageScriptResult,
        );

        if (pageScriptResult.success) {
          console.log(
            "[CodinGame Content Script] ✅ Successfully synced via page script (Angular)!",
          );
          showStatus("Code synced via Angular", "success");

          const response = {
            ...responseBase,
            status: "success",
            changed: true,
            strategy: "angular-ngmodel-page-context",
            language: detectedLanguage || requestedLanguage,
          };
          console.log(
            "[CodinGame Content Script] Sending success response:",
            response,
          );

          try {
            sendResponse(response);
            console.log(
              "[CodinGame Content Script] ✓ Response sent successfully",
            );
          } catch (sendErr) {
            console.error(
              "[CodinGame Content Script] Error calling sendResponse:",
              sendErr,
            );
            chrome.runtime.sendMessage(response).catch(() => {
              console.error(
                "[CodinGame Content Script] Fallback message send also failed",
              );
            });
          }

          console.log(
            "[CodinGame Content Script] handleSyncRequest completed successfully",
          );
          return;
        } else {
          console.warn(
            "[CodinGame Content Script] Page script sync failed, falling back to content script method",
          );
          console.warn(
            "[CodinGame Content Script] Error:",
            pageScriptResult.error,
          );
        }
      } catch (pageScriptError) {
        console.warn(
          "[CodinGame Content Script] Page script sync error, falling back:",
          pageScriptError.message,
        );
      }

      // Fallback: Use content script method
      console.log(
        "[CodinGame Content Script] Using content script fallback method...",
      );

      // Try to upgrade strategy if we have a fallback
      // Angular might be loaded now even if it wasn't during initial detection
      if (
        !editorCache ||
        editorCache.strategy === "monaco-textarea" ||
        editorCache.strategy === "cg-textarea"
      ) {
        console.log(
          "[CodinGame Content Script] Attempting to upgrade editor strategy...",
        );
        const betterCtx = locateEditor();
        if (betterCtx && betterCtx.strategy === "angular-ngmodel") {
          console.log(
            "[CodinGame Content Script] ✓ Upgraded to angular-ngmodel strategy!",
          );
          editorCache = betterCtx;
        } else {
          console.log(
            "[CodinGame Content Script] No upgrade available, using cached strategy",
          );
        }
      }

      const ctx = editorCache || (await waitForEditor(EDITOR_POLL_TIMEOUT_MS));
      editorCache = ctx;
      console.log(
        "[CodinGame Content Script] Final editor context:",
        ctx.strategy,
      );

      console.log("[CodinGame Content Script] Applying code...");
      const changed = await applyCode(ctx, payload?.code ?? "");
      console.log("[CodinGame Content Script] Code applied, changed:", changed);

      showStatus(
        changed ? "Code injected" : "Code already up to date",
        "success",
      );

      const response = {
        ...responseBase,
        status: "success",
        changed,
        strategy: ctx.strategy,
      };
      console.log(
        "[CodinGame Content Script] Sending success response:",
        response,
      );

      // Use try-catch to ensure sendResponse is called even if it throws
      try {
        sendResponse(response);
        console.log("[CodinGame Content Script] ✓ Response sent successfully");
      } catch (sendErr) {
        console.error(
          "[CodinGame Content Script] Error calling sendResponse:",
          sendErr,
        );
        // Try to notify background directly as fallback
        chrome.runtime.sendMessage(response).catch(() => {
          console.error(
            "[CodinGame Content Script] Fallback message send also failed",
          );
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error("[CodinGame Content Script] Error during sync:", error);
      showStatus(`Sync failed: ${reason}`, "error");

      const response = {
        ...responseBase,
        status: "failure",
        reason,
      };
      console.log(
        "[CodinGame Content Script] Sending failure response:",
        response,
      );

      // Use try-catch to ensure sendResponse is called even if it throws
      try {
        sendResponse(response);
        console.log("[CodinGame Content Script] ✗ Failure response sent");
      } catch (sendErr) {
        console.error(
          "[CodinGame Content Script] Error calling sendResponse:",
          sendErr,
        );
        // Try to notify background directly as fallback
        chrome.runtime.sendMessage(response).catch(() => {
          console.error(
            "[CodinGame Content Script] Fallback message send also failed",
          );
        });
      }
    }
  }

  function waitForEditor(timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();

      const tick = () => {
        const ctx = locateEditor();
        if (ctx) {
          resolve(ctx);
          return;
        }

        if (Date.now() - started > timeoutMs) {
          reject(new Error("EDITOR_NOT_FOUND"));
          return;
        }

        setTimeout(tick, EDITOR_POLL_INTERVAL_MS);
      };

      tick();
    });
  }

  function locateEditor() {
    // Enhanced diagnostics
    console.log("[CodinGame Content Script] Checking for Monaco editor...");

    // PRIORITY 1: Try Angular ng-model approach (CodinGame uses Angular.js)
    console.log("  Checking for Angular ng-model controller...");
    console.log(
      "    .code-editor element exists:",
      !!document.querySelector(".code-editor"),
    );
    console.log("    window.angular exists:", !!window.angular);
    console.log("    window.angular type:", typeof window.angular);

    const codeEditorElement = document.querySelector(".code-editor");
    if (codeEditorElement && window.angular) {
      try {
        const ngElement = window.angular.element(codeEditorElement);
        const data = ngElement.data();
        console.log("    Angular element created:", !!ngElement);
        console.log("    Angular data:", data ? "exists" : "null");
        console.log(
          "    Angular data keys:",
          data ? Object.keys(data) : "null",
        );
        const ngModel = data?.$ngModelController;
        console.log("    $ngModelController exists:", !!ngModel);
        console.log("    $ngModelController type:", typeof ngModel);

        if (ngModel && typeof ngModel.$setViewValue === "function") {
          console.log(
            "[CodinGame Content Script] ✓ Found Angular ng-model controller",
          );
          console.log(
            "[CodinGame Content Script] ng-model has $modelValue:",
            !!ngModel.$modelValue,
          );
          return {
            strategy: "angular-ngmodel",
            ngElement: ngElement,
            ngModel: ngModel,
            element: codeEditorElement,
          };
        } else {
          console.log("    ✗ Angular data not yet initialized (will retry)");
        }
      } catch (err) {
        console.log(
          "[CodinGame Content Script] Angular ng-model detection failed:",
          err.message,
        );
        console.log("[CodinGame Content Script] Error stack:", err.stack);
      }
    } else if (codeEditorElement && !window.angular) {
      console.log("    ⚠️ .code-editor exists but Angular not loaded yet");
    }

    // PRIORITY 2: Try Monaco API
    console.log("  window.monaco exists:", !!window.monaco);
    console.log("  window.monaco.editor exists:", !!window.monaco?.editor);

    if (window.monaco?.editor) {
      const models = window.monaco.editor.getModels
        ? window.monaco.editor.getModels()
        : [];
      console.log("  Monaco models found:", models.length);
      if (models.length > 0) {
        console.log("[CodinGame Content Script] ✓ Found Monaco model");
        return {
          strategy: "monaco-model",
          model: models[0],
        };
      }
    }

    // PRIORITY 3: Try Monaco editor instance from DOM
    const monacoTextArea = document.querySelector(".monaco-editor textarea");
    console.log("  .monaco-editor textarea exists:", !!monacoTextArea);
    if (monacoTextArea) {
      // Try to find Monaco editor instance from the DOM element
      const editorInstance = findMonacoEditorFromDOM(monacoTextArea);
      if (editorInstance) {
        console.log(
          "[CodinGame Content Script] ✓ Found Monaco editor instance from DOM",
        );
        return {
          strategy: "monaco-instance",
          editor: editorInstance,
          element: monacoTextArea,
        };
      }

      console.log(
        "[CodinGame Content Script] ✓ Found Monaco textarea (fallback)",
      );
      return {
        strategy: "monaco-textarea",
        element: monacoTextArea,
      };
    }

    // PRIORITY 4: Fallback to basic textarea
    const cgTextarea =
      document.querySelector(".cg-code-editor textarea") ||
      document.querySelector("textarea#code");
    console.log(
      "  .cg-code-editor textarea or textarea#code exists:",
      !!cgTextarea,
    );
    if (cgTextarea) {
      console.log("[CodinGame Content Script] ✓ Found CG textarea");
      return {
        strategy: "cg-textarea",
        element: cgTextarea,
      };
    }

    console.log("[CodinGame Content Script] ✗ No editor found in this check");
    return null;
  }

  function findMonacoEditorFromDOM(textarea) {
    try {
      // First, try to find via React Fiber (CodinGame uses React)
      const editorFromFiber = findEditorViaReactFiber(textarea);
      if (editorFromFiber) {
        console.log("[CodinGame Content Script] Found editor via React Fiber");
        return editorFromFiber;
      }
    } catch (err) {
      console.warn(
        "[CodinGame Content Script] React Fiber search failed:",
        err,
      );
    }

    try {
      // Monaco attaches editor instances to DOM elements with specific properties
      // Try to find the editor container (parent of textarea)
      let element = textarea;
      let maxDepth = 10;

      while (element && maxDepth-- > 0) {
        element = element.parentElement;
        if (!element) break;

        // Check for Monaco editor instance attached to element
        // Common property names Monaco uses
        const possibleKeys = Object.keys(element).filter(
          (key) =>
            key.includes("monaco") ||
            key.includes("editor") ||
            key.includes("__") ||
            key.startsWith("_"),
        );

        for (const key of possibleKeys) {
          const value = element[key];
          if (value && typeof value === "object") {
            // Check if this looks like a Monaco editor instance
            if (
              typeof value.getValue === "function" &&
              typeof value.setValue === "function"
            ) {
              console.log(
                "[CodinGame Content Script] Found editor instance via property:",
                key,
              );
              return value;
            }
          }
        }

        // Also check if element has a data attribute or property that references the editor
        if (element.monacoEditor) return element.monacoEditor;
        if (element._editor) return element._editor;
        if (element.__editor) return element.__editor;
      }

      // Try searching all elements with monaco-editor class
      const monacoContainers = document.querySelectorAll(".monaco-editor");
      for (const container of monacoContainers) {
        const keys = Object.keys(container);
        for (const key of keys) {
          const value = container[key];
          if (
            value &&
            typeof value === "object" &&
            typeof value.getValue === "function" &&
            typeof value.setValue === "function"
          ) {
            console.log(
              "[CodinGame Content Script] Found editor via container search",
            );
            return value;
          }
        }
      }

      return null;
    } catch (err) {
      console.warn(
        "[CodinGame Content Script] Error finding Monaco editor:",
        err,
      );
      return null;
    }
  }

  function findEditorViaReactFiber(element) {
    try {
      // React attaches fiber nodes to DOM elements
      const fiberKey = Object.keys(element).find(
        (key) =>
          key.startsWith("__reactInternalInstance") ||
          key.startsWith("__reactFiber"),
      );

      if (!fiberKey) return null;

      let fiber = element[fiberKey];
      let depth = 0;
      const maxDepth = 50;

      // Walk up the React fiber tree
      while (fiber && depth++ < maxDepth) {
        // Check memoizedProps
        if (fiber.memoizedProps) {
          const props = fiber.memoizedProps;
          if (props.editor && typeof props.editor.getValue === "function") {
            return props.editor;
          }
          if (
            props.monacoEditor &&
            typeof props.monacoEditor.getValue === "function"
          ) {
            return props.monacoEditor;
          }
        }

        // Check stateNode (component instance)
        if (fiber.stateNode) {
          const instance = fiber.stateNode;
          if (typeof instance === "object") {
            // Check common property names
            if (
              instance.editor &&
              typeof instance.editor.getValue === "function"
            ) {
              return instance.editor;
            }
            if (
              instance._editor &&
              typeof instance._editor.getValue === "function"
            ) {
              return instance._editor;
            }
            if (
              instance.monacoEditor &&
              typeof instance.monacoEditor.getValue === "function"
            ) {
              return instance.monacoEditor;
            }
          }
        }

        // Move to parent fiber
        fiber = fiber.return;
      }

      return null;
    } catch (err) {
      console.warn("[CodinGame Content Script] React fiber search error:", err);
      return null;
    }
  }

  async function applyCode(ctx, code) {
    console.log(
      "[CodinGame Content Script] applyCode called with strategy:",
      ctx.strategy,
    );
    console.log(
      "[CodinGame Content Script] Code to apply (first 100 chars):",
      code.substring(0, 100),
    );

    // PRIORITY 1: Angular ng-model strategy (BEST for CodinGame)
    if (ctx.strategy === "angular-ngmodel" && ctx.ngModel && ctx.ngElement) {
      console.log("[CodinGame Content Script] Using angular-ngmodel strategy");
      try {
        const currentValue = ctx.ngModel.$modelValue;
        console.log(
          "[CodinGame Content Script] Current ng-model value length:",
          currentValue?.length,
        );

        if (currentValue === code) {
          console.log("[CodinGame Content Script] Code unchanged, skipping");
          return false;
        }

        console.log(
          "[CodinGame Content Script] Setting ng-model value via Angular...",
        );

        // Update the model value using Angular's proper API
        ctx.ngModel.$setViewValue(code);
        ctx.ngModel.$setDirty();

        // Trigger the $render function to update the view
        if (typeof ctx.ngModel.$render === "function") {
          ctx.ngModel.$render();
          console.log("[CodinGame Content Script] Called $render()");
        }

        // Trigger Angular digest cycle
        const scope = ctx.ngElement.scope();
        if (scope && typeof scope.$apply === "function") {
          scope.$apply();
          console.log("[CodinGame Content Script] Called scope.$apply()");
        }

        // Verify it was set
        const newValue = ctx.ngModel.$modelValue;
        console.log(
          "[CodinGame Content Script] New ng-model value length:",
          newValue?.length,
        );
        console.log(
          "[CodinGame Content Script] ✓ Angular ng-model value set successfully",
        );
        return true;
      } catch (err) {
        console.error(
          "[CodinGame Content Script] Error using Angular ng-model:",
          err,
        );
        console.log(
          "[CodinGame Content Script] Falling back to next strategy...",
        );
        // Fall through to next method
      }
    }

    // PRIORITY 2: Monaco model strategy
    if (ctx.strategy === "monaco-model" && ctx.model) {
      console.log("[CodinGame Content Script] Using monaco-model strategy");
      if (
        typeof ctx.model.getValue === "function" &&
        ctx.model.getValue() === code
      ) {
        console.log("[CodinGame Content Script] Code unchanged, skipping");
        return false;
      }
      console.log("[CodinGame Content Script] Setting model value...");
      ctx.model.setValue(code);
      console.log("[CodinGame Content Script] ✓ Model value set");
      return true;
    }

    // PRIORITY 3: Monaco instance strategy
    if (ctx.strategy === "monaco-instance" && ctx.editor) {
      console.log("[CodinGame Content Script] Using monaco-instance strategy");
      try {
        const currentValue = ctx.editor.getValue();
        console.log(
          "[CodinGame Content Script] Current editor value length:",
          currentValue?.length,
        );

        if (currentValue === code) {
          console.log("[CodinGame Content Script] Code unchanged, skipping");
          return false;
        }

        console.log(
          "[CodinGame Content Script] Setting editor value via Monaco API...",
        );
        ctx.editor.setValue(code);

        // Verify it was set
        const newValue = ctx.editor.getValue();
        console.log(
          "[CodinGame Content Script] New editor value length:",
          newValue?.length,
        );
        console.log(
          "[CodinGame Content Script] ✓ Monaco editor value set successfully",
        );
        return true;
      } catch (err) {
        console.error(
          "[CodinGame Content Script] Error using Monaco instance:",
          err,
        );
        // Fall through to textarea method
        console.log(
          "[CodinGame Content Script] Falling back to textarea method...",
        );
      }
    }

    // PRIORITY 4: Element/textarea fallback strategy
    if (ctx.element) {
      console.log("[CodinGame Content Script] Using element strategy");
      console.log(
        "[CodinGame Content Script] Element type:",
        ctx.element.tagName,
      );

      // First, try to select all existing content and replace it
      console.log("[CodinGame Content Script] Focusing element...");
      ctx.element.focus();

      console.log("[CodinGame Content Script] Selecting all content...");
      ctx.element.select();
      ctx.element.setSelectionRange(0, ctx.element.value.length);

      // Method 1: Use document.execCommand (legacy but works with Monaco)
      console.log(
        "[CodinGame Content Script] Attempting execCommand delete...",
      );
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);

      console.log(
        "[CodinGame Content Script] Attempting execCommand insertText...",
      );
      const inserted = document.execCommand("insertText", false, code);
      console.log(
        "[CodinGame Content Script] execCommand insertText result:",
        inserted,
      );

      if (!inserted) {
        // Method 2: Fallback to direct value setting + enhanced events
        console.log(
          "[CodinGame Content Script] execCommand failed, using fallback method...",
        );
        ctx.element.value = code;

        // Dispatch comprehensive input events
        console.log(
          "[CodinGame Content Script] Dispatching comprehensive events...",
        );

        // Input event with InputEvent constructor
        ctx.element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: code,
          }),
        );

        // Change event
        ctx.element.dispatchEvent(new Event("change", { bubbles: true }));

        // Keyboard events to simulate typing
        ctx.element.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            key: "a",
            ctrlKey: true,
          }),
        );
        ctx.element.dispatchEvent(
          new KeyboardEvent("keyup", {
            bubbles: true,
            key: "a",
            ctrlKey: true,
          }),
        );

        // Blur and focus to force Monaco sync
        ctx.element.blur();
        setTimeout(() => ctx.element.focus(), 10);
      }

      console.log(
        "[CodinGame Content Script] ✓ Element value set and events dispatched",
      );
      console.log(
        "[CodinGame Content Script] Final textarea value length:",
        ctx.element.value.length,
      );

      return true;
    }

    console.error("[CodinGame Content Script] No valid editor context found!");
    throw new Error("EDITOR_WRITE_FAILED");
  }

  function notifyBackground(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch (_) {
      // Background may not be listening yet; ignore.
    }
  }

  function showStatus(text, status) {
    if (!overlayEl) {
      overlayEl = document.createElement("div");
      overlayEl.style.position = "fixed";
      overlayEl.style.zIndex = "2147483647";
      overlayEl.style.top = "16px";
      overlayEl.style.right = "16px";
      overlayEl.style.padding = "10px 14px";
      overlayEl.style.borderRadius = "8px";
      overlayEl.style.fontFamily =
        "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      overlayEl.style.fontSize = "0.9rem";
      overlayEl.style.boxShadow = "0 6px 18px rgba(15, 23, 42, 0.15)";
      overlayEl.style.transition = "opacity 200ms ease";
      overlayEl.style.opacity = "0";
      document.body.appendChild(overlayEl);
    }

    const colors = {
      success: { bg: "#16a34a", fg: "#fff" },
      error: { bg: "#dc2626", fg: "#fff" },
      ready: { bg: "#0ea5e9", fg: "#fff" },
      pending: { bg: "#a855f7", fg: "#fff" },
    };

    const palette = colors[status] || colors.ready;
    overlayEl.style.background = palette.bg;
    overlayEl.style.color = palette.fg;
    overlayEl.textContent = text;
    overlayEl.style.opacity = "1";

    if (overlayTimer) {
      clearTimeout(overlayTimer);
    }

    overlayTimer = setTimeout(() => {
      if (overlayEl) {
        overlayEl.style.opacity = "0";
      }
    }, STATUS_FADE_TIMEOUT_MS);
  }

  // ========================================
  // Automatic Arena Battle Capture
  // ========================================
  // (Variables declared at top of file to avoid initialization order issues)

  // Removed createPanelCaptureButton and setupLastBattlesPanelObserver
  // Auto-injection was causing UI bugs - button was appearing on leaderboard rows
  // Users should use the floating "📊 Capture All Battles" button instead

  function sanitizeCategory(name) {
    if (!name) return "";
    return name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function setDefaultCategory(teamName, forceUpdate = false) {
    if (!teamName) return;

    const sanitized = sanitizeCategory(teamName);
    const previousTeamName = currentTeamName;
    currentTeamName = teamName;

    // Update if:
    // 1. No category is set yet, OR
    // 2. Force update (from API), OR
    // 3. Category matches the previous team name (user hasn't manually changed it)
    const shouldUpdate =
      !captureCategory ||
      forceUpdate ||
      captureCategory === sanitizeCategory(previousTeamName);

    if (shouldUpdate) {
      captureCategory = sanitized;

      // Update input field if it exists
      if (categoryInput) {
        categoryInput.value = captureCategory;
        // Provide visual feedback that category was auto-set
        categoryInput.style.borderColor = "#10b981";
        categoryInput.style.background = "#f0fdf4";
        setTimeout(() => {
          categoryInput.style.borderColor = "#e2e8f0";
          categoryInput.style.background = "white";
        }, 2000);
      }

      // Show status message
      updateCaptureStatus(
        `📋 Category auto-set to: ${captureCategory}`,
        "success",
      );

      console.log(
        "[CodinGame Content Script] Auto-set category:",
        captureCategory,
      );
    }
  }

  function extractTeamName() {
    // Try to extract team name from the page when viewing last battles

    // Strategy 1: Find the team name from a clicked/visible last battles panel
    // Look for all .last-battles buttons and find which one's parent row might be active
    const lastBattlesButtons = document.querySelectorAll(
      '.last-battles, a[href*="last-battle"]',
    );

    for (const button of lastBattlesButtons) {
      // Get the parent table row
      const row = button.closest("tr");
      if (row) {
        // Find the pseudo link in the same row (but exclude rank numbers)
        const links = row.querySelectorAll("a.pseudo");
        for (const link of links) {
          const text = link.textContent.trim();
          // Make sure it's not just a number (rank)
          if (text && !text.match(/^\d+$/)) {
            console.log(
              `[CodinGame Content Script] Extracted team name "${text}" from .pseudo link in leaderboard row`,
            );
            return text;
          }
        }
      }
    }

    // Strategy 2: Try standard selectors for selected/active rows
    const selectors = [
      "tr.selected a.pseudo",
      "tr.active a.pseudo",
      ".leaderboard-row.selected .pseudo",
      ".leaderboard-item.selected .team-name",
      ".leaderboard-item.selected .player-name",
      '[class*="selected"] .pseudo',
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent.trim()) {
        const teamName = element.textContent.trim();
        // Exclude if it's just a number or common UI text
        if (
          !teamName.match(/^\d+$/) &&
          !teamName.toLowerCase().includes("last battle") &&
          !teamName.toLowerCase().includes("view last")
        ) {
          console.log(
            `[CodinGame Content Script] Extracted team name "${teamName}" from selector: ${selector}`,
          );
          return teamName;
        }
      }
    }

    console.log(
      "[CodinGame Content Script] Could not extract team name from page",
    );
    return "";
  }

  function createBatchCaptureButton() {
    if (capturePanel) return;

    // Create main panel container
    capturePanel = document.createElement("div");
    capturePanel.id = "cg-capture-panel";
    capturePanel.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      z-index: 10000;
      padding: 16px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-width: 280px;
    `;

    // Category input
    const categoryLabel = document.createElement("label");
    categoryLabel.textContent = "Category:";
    categoryLabel.style.cssText = `
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
      margin-bottom: 6px;
    `;

    categoryInput = document.createElement("input");
    categoryInput.id = "cg-capture-category";
    categoryInput.type = "text";
    categoryInput.placeholder = "e.g., team-name";
    categoryInput.value = captureCategory;
    categoryInput.style.cssText = `
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 12px;
      box-sizing: border-box;
    `;
    categoryInput.oninput = (e) => {
      captureCategory = sanitizeCategory(e.target.value);
      e.target.value = captureCategory;
    };

    // Set default value if we already have team name
    if (currentTeamName && !captureCategory) {
      setDefaultCategory(currentTeamName);
    }

    // Status text
    captureStatusText = document.createElement("div");
    captureStatusText.style.cssText = `
      font-size: 12px;
      color: #64748b;
      margin-bottom: 12px;
      min-height: 18px;
    `;

    // Button container
    const buttonContainer = document.createElement("div");
    buttonContainer.style.cssText = `
      display: flex;
      gap: 8px;
    `;

    // Capture button
    captureButton = document.createElement("button");
    captureButton.textContent = "📊 Capture";
    captureButton.style.cssText = `
      flex: 1;
      padding: 10px 16px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    `;

    captureButton.onmouseenter = () => {
      if (!captureInProgress) {
        captureButton.style.transform = "translateY(-1px)";
        captureButton.style.boxShadow = "0 4px 12px rgba(102, 126, 234, 0.4)";
      }
    };

    captureButton.onmouseleave = () => {
      captureButton.style.transform = "translateY(0)";
      captureButton.style.boxShadow = "none";
    };

    captureButton.onclick = async () => {
      if (captureInProgress) return;

      // If monitoring is active, stop it
      if (continuousMonitoring) {
        stopContinuousMonitoring();
        return;
      }

      // Extract team name if not already set
      if (!currentTeamName) {
        currentTeamName = extractTeamName();
        if (currentTeamName && !captureCategory) {
          captureCategory = sanitizeCategory(currentTeamName);
          categoryInput.value = captureCategory;
        }
      }

      await captureBattlesAutomatically();
    };

    // Pause/Resume button
    pauseResumeButton = document.createElement("button");
    pauseResumeButton.textContent = "⏸️";
    pauseResumeButton.style.cssText = `
      padding: 10px 16px;
      background: #f1f5f9;
      color: #475569;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      display: none;
    `;

    pauseResumeButton.onmouseenter = () => {
      pauseResumeButton.style.background = "#e2e8f0";
    };

    pauseResumeButton.onmouseleave = () => {
      pauseResumeButton.style.background = "#f1f5f9";
    };

    pauseResumeButton.onclick = () => {
      capturePaused = !capturePaused;
      pauseResumeButton.textContent = capturePaused ? "▶️" : "⏸️";
      pauseResumeButton.style.background = capturePaused
        ? "#fef3c7"
        : "#f1f5f9";
      updateCaptureStatus(
        capturePaused ? "⏸️ Paused" : "▶️ Resuming...",
        capturePaused ? "warning" : "pending",
      );
    };

    // Stop button
    stopButton = document.createElement("button");
    stopButton.textContent = "⏹️";
    stopButton.style.cssText = `
      padding: 10px 16px;
      background: #fee2e2;
      color: #dc2626;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      display: none;
    `;

    stopButton.onmouseenter = () => {
      stopButton.style.background = "#fecaca";
    };

    stopButton.onmouseleave = () => {
      stopButton.style.background = "#fee2e2";
    };

    stopButton.onclick = () => {
      captureShouldStop = true;
      updateCaptureStatus("⏹️ Stopping...", "warning");
      console.log("[CodinGame Content Script] User requested to stop capture");
    };

    // Assemble panel
    buttonContainer.appendChild(captureButton);
    buttonContainer.appendChild(pauseResumeButton);
    buttonContainer.appendChild(stopButton);

    capturePanel.appendChild(categoryLabel);
    capturePanel.appendChild(categoryInput);
    capturePanel.appendChild(captureStatusText);
    capturePanel.appendChild(buttonContainer);

    document.body.appendChild(capturePanel);
    console.log("[CodinGame Content Script] Capture panel created");
  }

  function updateBatchCaptureButton(text, inProgress = false) {
    captureInProgress = inProgress;

    if (captureButton) {
      captureButton.textContent = text;
      captureButton.style.cursor = inProgress ? "not-allowed" : "pointer";
      captureButton.style.opacity = inProgress ? "0.7" : "1";
      captureButton.style.background = inProgress
        ? "linear-gradient(135deg, #94a3b8 0%, #64748b 100%)"
        : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
    }

    // Show/hide pause and stop buttons based on capture state
    if (pauseResumeButton) {
      pauseResumeButton.style.display = inProgress ? "block" : "none";
      if (!inProgress) {
        capturePaused = false;
        pauseResumeButton.textContent = "⏸️";
        pauseResumeButton.style.background = "#f1f5f9";
      }
    }
    if (stopButton) {
      stopButton.style.display = inProgress ? "block" : "none";
    }

    if (!inProgress && captureStatusText) {
      captureStatusText.textContent = "";
    }
  }

  function updateCaptureStatus(message, type = "info") {
    if (!captureStatusText) return;

    const colors = {
      success: "#10b981",
      error: "#ef4444",
      warning: "#f59e0b",
      pending: "#667eea",
      info: "#64748b",
    };

    captureStatusText.textContent = message;
    captureStatusText.style.color = colors[type] || colors.info;
  }

  function isBattlesPanelOpen() {
    // Check if the "Last Battles" panel/modal is currently open
    // Look for common patterns in the CodinGame UI

    // Check for "Last battles" heading
    const headings = document.querySelectorAll("h3");
    const hasLastBattlesHeading = Array.from(headings).some(
      (h) =>
        h.textContent.includes("Last battles") ||
        h.textContent.includes("last battles"),
    );

    // Check for battle-related elements
    const hasLastBattleElements =
      document.querySelector('[class*="last-battle"]') !== null ||
      document.querySelector('[class*="battles-panel"]') !== null;

    // Check for visible modal/overlay
    const modal = document.querySelector(".modal");
    const overlay = document.querySelector('[class*="overlay"]');
    const hasVisibleModal =
      (modal && !modal.style.display?.includes("none")) ||
      (overlay && !overlay.style.display?.includes("none"));

    // Check if we can see battle SHOW/CLOSE buttons
    const battleButtons = document.querySelectorAll("button");
    const hasBattleButtons = Array.from(battleButtons).some((btn) => {
      const text = btn.textContent.toUpperCase();
      const isVisible =
        !btn.style.display?.includes("none") && btn.offsetParent !== null;
      return isVisible && (text.includes("SHOW") || text.includes("CLOSE"));
    });

    return (
      hasLastBattlesHeading ||
      hasLastBattleElements ||
      hasVisibleModal ||
      hasBattleButtons
    );
  }

  async function captureBattlesAutomatically(startMonitoring = true) {
    console.log(
      "[CodinGame Content Script] Starting automatic battle capture...",
    );
    updateBatchCaptureButton("⏳ Fetching battles...", true);

    // Reset pause and stop states
    capturePaused = false;
    captureShouldStop = false;

    // Team name should already be set by the __cgBattleListCaptured event handler
    // which receives the correct team name from the API
    // Only use DOM extraction as a last resort fallback
    if (!currentTeamName) {
      const extractedTeamName = extractTeamName();
      if (extractedTeamName) {
        console.log(
          `[CodinGame Content Script] Fallback: extracted team name from DOM: "${extractedTeamName}"`,
        );
        currentTeamName = extractedTeamName;
        setDefaultCategory(currentTeamName);
      }
    }

    try {
      // Get current user ID (test session handle is optional)
      const { userId, testSessionHandle } = await getSessionInfo();

      if (!userId) {
        throw new Error(
          "Could not find user ID. Please make sure you are logged in to CodinGame.",
        );
      }

      console.log("[CodinGame Content Script] Session info:", {
        userId,
        testSessionHandle,
        category: captureCategory,
      });

      // Fetch list of last battles
      showStatus("Fetching battle list...", "pending");

      let battles = null;

      // PRIORITY 1: Use battles from the API if available (from leaderboard "VIEW LAST BATTLES")
      if (availableBattles && availableBattles.length > 0) {
        console.log(
          `[CodinGame Content Script] Using ${availableBattles.length} battles from leaderboard API`,
        );
        battles = availableBattles.map((b) => ({ gameId: b.gameId }));
      }
      // PRIORITY 2: Try DOM extraction (works in IDE)
      else {
        console.log(
          "[CodinGame Content Script] Extracting battles from DOM...",
        );
        battles = await extractBattlesFromDOM();

        // PRIORITY 3: Try API if DOM extraction fails AND we have a testSessionHandle
        if ((!battles || battles.length === 0) && testSessionHandle) {
          console.log(
            "[CodinGame Content Script] DOM extraction failed, trying API with testSessionHandle...",
          );
          try {
            battles = await fetchLastBattles(testSessionHandle);
          } catch (error) {
            console.warn(
              "[CodinGame Content Script] API fetch also failed:",
              error.message,
            );
          }
        }
      }

      if (!battles || battles.length === 0) {
        let message = "No battles found. ";

        if (availableBattles.length > 0) {
          message +=
            "Battles are visible but couldn't be extracted. Try clicking SHOW on a battle first.";
        } else if (testSessionHandle) {
          message += "Try running your code to generate battles.";
        } else {
          message +=
            'Open "VIEW LAST BATTLES" on any team, then click this button to capture all battles.';
        }

        showStatus(message, "error");
        updateBatchCaptureButton("📊 Capture", false);
        updateCaptureStatus(message, "error");
        console.log(
          "[CodinGame Content Script] 💡 Tip: On the leaderboard page:",
        );
        console.log(
          '[CodinGame Content Script]    1. Click "VIEW LAST BATTLES" on any team',
        );
        console.log(
          "[CodinGame Content Script]    2. Click the extension's capture button",
        );
        console.log(
          "[CodinGame Content Script]    3. Battles will be captured automatically",
        );
        return;
      }

      // Filter out battles that have already been captured
      let newBattles = battles.filter((b) => !capturedBattleIds.has(b.gameId));

      if (newBattles.length === 0) {
        console.log(
          `[CodinGame Content Script] All ${battles.length} battles already captured`,
        );

        // Ask user if they want to re-capture
        const reCapture = confirm(
          `All ${battles.length} battles have already been captured.\n\n` +
            `Do you want to capture them again?`,
        );

        if (reCapture) {
          // Clear the captured IDs for this team's battles to allow re-capture
          battles.forEach((b) => capturedBattleIds.delete(b.gameId));
          console.log(
            `[CodinGame Content Script] User chose to re-capture ${battles.length} battles`,
          );
          showStatus(`Re-capturing ${battles.length} battles...`, "pending");
          // Re-evaluate newBattles after clearing the cache
          newBattles = battles.filter((b) => !capturedBattleIds.has(b.gameId));
        } else {
          showStatus(
            `All battles already captured (${capturedBattleIds.size} total)`,
            "success",
          );
          updateBatchCaptureButton(
            continuousMonitoring ? "🔄 Monitoring..." : "📊 Capture",
            false,
          );
          updateCaptureStatus(
            `All ${battles.length} battles captured`,
            "success",
          );

          // If we were monitoring, keep the monitoring button state
          if (continuousMonitoring) {
            updateBatchCaptureButton("🔄 Monitoring... (click to stop)", false);
          }
          return;
        }
      }

      console.log(
        `[CodinGame Content Script] Found ${battles.length} battles (${newBattles.length} new)`,
      );
      showStatus(
        `Found ${newBattles.length} new battles. Starting capture...`,
        "success",
      );
      updateCaptureStatus(
        `Capturing ${newBattles.length} battles...`,
        "pending",
      );

      // Capture each new battle
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < newBattles.length; i++) {
        // Check if user requested to stop
        if (captureShouldStop) {
          console.log(
            `[CodinGame Content Script] Capture stopped by user at ${i}/${newBattles.length}`,
          );
          updateCaptureStatus(
            `⏹️ Stopped (captured ${successCount}/${newBattles.length})`,
            "warning",
          );
          break;
        }

        const battle = newBattles[i];
        const progress = `${i + 1}/${newBattles.length}`;
        updateBatchCaptureButton(`⏳ ${progress}`, true);
        showStatus(`Capturing battle ${progress}...`, "pending");
        updateCaptureStatus(`Capturing ${progress}...`, "pending");

        try {
          // Wait if paused
          while (capturePaused && !captureShouldStop) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          // Check again after waiting in case stop was requested
          if (captureShouldStop) {
            break;
          }

          // Fetch and send battle to background script with category
          console.log(
            `[CodinGame Content Script] About to fetch battle ${battle.gameId} with category:`,
            captureCategory || "(empty)",
          );
          await fetchAndProcessBattle(battle.gameId, userId, captureCategory);

          capturedBattleIds.add(battle.gameId); // Mark as captured
          successCount++;
          console.log(
            `[CodinGame Content Script] ✓ Captured battle ${battle.gameId} (${progress})`,
          );

          // Small delay to avoid overwhelming the server and allow UI updates
          await new Promise((resolve) => setTimeout(resolve, 300));
        } catch (error) {
          console.error(
            `[CodinGame Content Script] ✗ Failed to capture battle ${battle.gameId}:`,
            error,
          );
          failCount++;

          // Continue with other battles even if one fails
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      const message = captureShouldStop
        ? `⏹️ Stopped: ${successCount}/${newBattles.length} battles captured` +
          (failCount > 0 ? ` (${failCount} failed)` : "")
        : `✓ Captured ${successCount}/${newBattles.length} new battles (${capturedBattleIds.size} total)` +
          (failCount > 0 ? ` (${failCount} failed)` : "");
      showStatus(
        message,
        captureShouldStop ? "warning" : successCount > 0 ? "success" : "error",
      );

      // Only start/continue monitoring if battles panel is still open
      if (startMonitoring && !continuousMonitoring) {
        if (isBattlesPanelOpen()) {
          console.log(
            "[CodinGame Content Script] All battles captured, starting monitoring (panel is open)",
          );
          startContinuousMonitoring();
        } else {
          console.log(
            "[CodinGame Content Script] All battles captured but panel is closed, stopping monitoring",
          );
          updateBatchCaptureButton("📊 Capture", false);
          updateCaptureStatus(
            "✓ All battles captured (panel closed, monitoring stopped)",
            "success",
          );
        }
      } else if (continuousMonitoring && !isBattlesPanelOpen()) {
        // If we're monitoring but panel was closed, stop monitoring
        console.log(
          "[CodinGame Content Script] Panel closed during monitoring, stopping",
        );
        stopContinuousMonitoring();
        updateBatchCaptureButton("📊 Capture", false);
        updateCaptureStatus(
          "✓ All battles captured (panel closed, monitoring stopped)",
          "success",
        );
      } else {
        updateBatchCaptureButton(
          continuousMonitoring
            ? "🔄 Monitoring... (click to stop)"
            : "📊 Capture",
          false,
        );
      }

      console.log(
        captureShouldStop
          ? `[CodinGame Content Script] Batch capture stopped: ${successCount} success, ${failCount} failed, ${capturedBattleIds.size} total captured`
          : `[CodinGame Content Script] Batch capture complete: ${successCount} success, ${failCount} failed, ${capturedBattleIds.size} total captured`,
      );
    } catch (error) {
      console.error("[CodinGame Content Script] Batch capture error:", error);
      const errorMsg = error.message || "Unknown error occurred";
      showStatus(`Error: ${errorMsg}`, "error");
      updateBatchCaptureButton(
        continuousMonitoring
          ? "🔄 Monitoring... (click to stop)"
          : "📊 Capture",
        false,
      );
      captureInProgress = false;
      captureShouldStop = false;
    } finally {
    }
  }

  function startContinuousMonitoring() {
    if (continuousMonitoring) {
      console.log("[CodinGame Content Script] Monitoring already active");
      return;
    }

    console.log(
      "[CodinGame Content Script] Starting continuous battle monitoring...",
    );
    continuousMonitoring = true;
    updateBatchCaptureButton("🔄 Monitoring... (click to stop)", false);
    showStatus("Monitoring for new battles...", "ready");

    // Check for new battles every 10 seconds
    monitoringInterval = setInterval(async () => {
      // First check if panel is still open
      if (!isBattlesPanelOpen()) {
        console.log(
          "[CodinGame Content Script] Panel closed during monitoring, stopping automatically",
        );
        stopContinuousMonitoring();
        updateBatchCaptureButton("📊 Capture", false);
        updateCaptureStatus("Panel closed - monitoring stopped", "info");
        return;
      }

      if (!captureInProgress) {
        console.log("[CodinGame Content Script] Checking for new battles...");
        await captureBattlesAutomatically(false);
      }
    }, 10000);
  }

  function stopContinuousMonitoring() {
    if (!continuousMonitoring) return;

    console.log(
      "[CodinGame Content Script] Stopping continuous battle monitoring...",
    );
    continuousMonitoring = false;
    captureInProgress = false;

    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }

    updateBatchCaptureButton("📊 Capture", false);
    showStatus("Monitoring stopped", "ready");
  }

  async function getSessionInfo() {
    // Try to extract from page context
    try {
      // Check if there's a test session handle in the URL or page
      const urlMatch = window.location.href.match(
        /\/ide\/(puzzle|challenge)\/([^\/]+)/,
      );

      // Try to get from localStorage or cookies
      const userId = await getUserIdFromPage();
      const testSessionHandle = await getTestSessionHandleFromPage();

      return { userId, testSessionHandle };
    } catch (error) {
      console.error(
        "[CodinGame Content Script] Error getting session info:",
        error,
      );
      return {};
    }
  }

  async function getUserIdFromPage() {
    // Try multiple methods to get user ID
    try {
      // Method 1: Check if it's in the global scope via page script
      console.log(
        "[CodinGame Content Script] Requesting userId from page script...",
      );
      const result = await new Promise((resolve) => {
        let timeoutId;
        const handler = (event) => {
          console.log(
            "[CodinGame Content Script] Received message:",
            event.data,
          );
          if (event.data.type === "__cgUserIdResponse") {
            console.log(
              "[CodinGame Content Script] Got userId response:",
              event.data.userId,
            );
            window.removeEventListener("message", handler);
            clearTimeout(timeoutId);
            resolve(event.data.userId);
          }
        };
        window.addEventListener("message", handler);
        window.postMessage({ type: "__cgGetUserId" }, "*");
        timeoutId = setTimeout(() => {
          console.log(
            "[CodinGame Content Script] Timeout waiting for userId response",
          );
          window.removeEventListener("message", handler);
          resolve(null);
        }, 3000);
      });

      if (result) {
        console.log(
          "[CodinGame Content Script] Successfully got userId from page script:",
          result,
        );
        return result;
      }
      console.log(
        "[CodinGame Content Script] No userId from page script, trying other methods...",
      );

      // Method 2: Try to extract from any existing API response
      // This will be populated by battle responses
      const existingUserId = window.__cgUserId;
      if (existingUserId) return existingUserId;

      // Method 3: Make a simple API call to get user info
      const response = await fetch(
        "https://www.codingame.com/services/CodinGamer/getCurrentCodinGamer",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([]),
        },
      );

      if (!response.ok) {
        console.warn(
          "[CodinGame Content Script] API returned error:",
          response.status,
          response.statusText,
        );
        return null;
      }

      // Get response as text first to check content type
      const responseText = await response.text();

      // Try to parse as JSON
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(
          "[CodinGame Content Script] Failed to parse user info response as JSON:",
          responseText.substring(0, 200),
        );
        return null;
      }

      if (data && data.userId) {
        window.__cgUserId = data.userId;
        return data.userId;
      }

      return null;
    } catch (error) {
      console.error("[CodinGame Content Script] Error getting user ID:", error);
      return null;
    }
  }

  async function getBattlesFromPageScript() {
    try {
      console.log(
        "[CodinGame Content Script] Requesting battles from page script...",
      );
      console.log(
        "[CodinGame Content Script] Sending __cgGetBattles message...",
      );

      const result = await new Promise((resolve) => {
        let timeoutId;
        const handler = (event) => {
          // Log all messages to debug
          if (
            event.data &&
            event.data.type &&
            event.data.type.startsWith("__cg")
          ) {
            console.log(
              "[CodinGame Content Script] Received message:",
              event.data.type,
              event.data,
            );
          }

          if (event.data && event.data.type === "__cgBattlesResponse") {
            clearTimeout(timeoutId);
            window.removeEventListener("message", handler);
            console.log(
              "[CodinGame Content Script] Got battles response:",
              event.data.battles,
            );
            resolve(event.data.battles);
          }
        };

        window.addEventListener("message", handler);
        console.log(
          "[CodinGame Content Script] Message listener added, posting __cgGetBattles...",
        );
        window.postMessage({ type: "__cgGetBattles" }, "*");
        console.log("[CodinGame Content Script] __cgGetBattles message posted");

        timeoutId = setTimeout(() => {
          console.log(
            "[CodinGame Content Script] ⚠️ Timeout waiting for battles response (3 seconds elapsed)",
          );
          window.removeEventListener("message", handler);
          resolve(null);
        }, 3000);
      });

      console.log(
        "[CodinGame Content Script] getBattlesFromPageScript promise resolved with:",
        result,
      );
      return result;
    } catch (error) {
      console.error(
        "[CodinGame Content Script] Error getting battles from page script:",
        error,
      );
      return null;
    }
  }

  async function getTestSessionHandleFromPage() {
    try {
      // Try to get from recent network requests
      // The test session handle is usually in the page context
      const result = await new Promise((resolve) => {
        let timeoutId;
        const handler = (event) => {
          if (event.data.type === "__cgTestSessionHandleResponse") {
            window.removeEventListener("message", handler);
            clearTimeout(timeoutId);
            resolve(event.data.handle);
          }
        };
        window.addEventListener("message", handler);
        window.postMessage({ type: "__cgGetTestSessionHandle" }, "*");
        timeoutId = setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(null);
        }, 3000);
      });

      return result;
    } catch (error) {
      console.error(
        "[CodinGame Content Script] Error getting test session handle:",
        error,
      );
      return null;
    }
  }

  async function waitForBattleContent(maxWaitTime = 3000, checkInterval = 200) {
    // Wait for battle content to appear in the DOM
    // This is useful when content loads dynamically (e.g., after clicking "LAST BATTLES")
    console.log(
      "[CodinGame Content Script] Waiting for battle content to load...",
    );

    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Check for common battle-related elements
      const hasReplayLinks =
        document.querySelectorAll('a[href*="/replay/"]').length > 0;
      const hasBattleData =
        document.querySelectorAll("[data-game-id], [data-battle-id]").length >
        0;
      const hasBattleClasses =
        document.querySelectorAll(".battle-item, .game-item, .report-item")
          .length > 0;

      if (hasReplayLinks || hasBattleData || hasBattleClasses) {
        console.log("[CodinGame Content Script] Battle content detected!");
        // Wait a bit more for all content to render
        await new Promise((resolve) => setTimeout(resolve, 500));
        return true;
      }

      // Wait before checking again
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    console.log(
      "[CodinGame Content Script] Timeout waiting for battle content",
    );
    return false;
  }

  async function fetchLastBattles(testSessionHandle) {
    try {
      const response = await fetch(
        "https://www.codingame.com/services/gamesPlayersRanking/findLastBattlesByTestSessionHandle",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([testSessionHandle]),
        },
      );

      if (!response.ok) {
        const errorText = response.statusText || "Unknown error";
        throw new Error(
          `API returned ${response.status}: ${errorText}. The testSessionHandle may be invalid.`,
        );
      }

      // Get response as text first to check content type
      const responseText = await response.text();

      // Try to parse as JSON
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(
          "[CodinGame Content Script] Failed to parse response as JSON:",
          responseText.substring(0, 200),
        );
        throw new Error(
          "Server returned invalid JSON response (possibly HTML error page)",
        );
      }

      console.log("[CodinGame Content Script] Last battles response:", data);

      // The response should be an array of battle objects with gameId
      if (!Array.isArray(data)) {
        console.warn(
          "[CodinGame Content Script] Unexpected response format:",
          data,
        );
        return [];
      }

      // Filter out invalid battles
      const validBattles = data.filter((battle) => battle && battle.gameId);
      console.log(
        `[CodinGame Content Script] Found ${validBattles.length} valid battles`,
      );

      return validBattles;
    } catch (error) {
      console.error(
        "[CodinGame Content Script] Error fetching last battles:",
        error,
      );
      throw new Error(`Failed to fetch battle list: ${error.message}`);
    }
  }

  async function fetchAndProcessBattle(gameId, userId, category = "") {
    try {
      console.log(`[CodinGame Content Script] Fetching battle ${gameId}...`);
      console.log(
        `[CodinGame Content Script] Category for battle ${gameId}:`,
        category || "(empty)",
      );

      // Fetch battle data from CodinGame API
      const response = await fetch(
        "https://www.codingame.com/services/gameResult/findByGameId",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
          },
          body: JSON.stringify([gameId, userId]),
          credentials: "include",
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const battleData = await response.text();

      // Validate response
      if (!battleData || battleData.length === 0) {
        throw new Error("Empty response from server");
      }

      // Try to parse to validate it's valid JSON
      try {
        JSON.parse(battleData);
      } catch (e) {
        throw new Error("Invalid JSON response from server");
      }

      console.log(
        `[CodinGame Content Script] Fetched battle ${gameId}, size: ${battleData.length} bytes`,
      );

      // Send to background script for processing with userId context and category
      try {
        // Check if extension context is still valid before sending
        if (!isExtensionContextValid()) {
          throw new Error(
            "Extension context invalidated - please refresh the page",
          );
        }

        const messagePayload = {
          type: "battle_response_captured",
          payload: {
            url: "/services/gameResult/findByGameId",
            body: battleData,
            userId: userId,
            gameId: gameId,
            category: category,
          },
        };

        console.log(
          `[CodinGame Content Script] Sending battle ${gameId} to background with category:`,
          category || "(empty)",
        );

        const response = await chrome.runtime.sendMessage(messagePayload);

        console.log(
          `[CodinGame Content Script] ✓ Battle ${gameId} sent to background script`,
        );
        console.log(
          `[CodinGame Content Script] Payload category sent:`,
          messagePayload.payload.category,
        );
        console.log(
          `[CodinGame Content Script] Background response:`,
          response,
        );
      } catch (sendError) {
        // Handle extension context invalidation gracefully
        if (
          sendError.message &&
          sendError.message.includes("Extension context invalidated")
        ) {
          console.error(
            `[CodinGame Content Script] Extension was reloaded. Please refresh the page to continue capturing.`,
          );
          throw new Error(
            `Extension context invalidated - please refresh the page`,
          );
        }

        console.error(
          `[CodinGame Content Script] ✗ Failed to send battle ${gameId} to background:`,
          sendError,
        );
        console.error(
          `[CodinGame Content Script] Error details:`,
          sendError.message,
          sendError.stack,
        );
        throw new Error(`Failed to send to background: ${sendError.message}`);
      }
    } catch (error) {
      console.error(
        `[CodinGame Content Script] Error processing battle ${gameId}:`,
        error,
      );
      throw new Error(`Battle ${gameId}: ${error.message}`);
    }
  }

  async function extractBattlesFromDOM() {
    // Try to extract battle game IDs from the DOM
    // This is used when testSessionHandle is not available (e.g., on arena leaderboard)
    try {
      console.log("[CodinGame Content Script] Searching for battles in DOM...");

      // PRIORITY 0: Check if last battles panel is open and scope search to it
      let searchRoot = document;
      const panelSelectors = [
        ".cg-last-battles",
        ".cg-ide-last-battles",
        '[class*="last-battle"]',
        '[class*="LastBattles"]',
        'div[ng-if*="lastBattles"]',
        'div[ng-if*="battles"]',
        '[role="dialog"]',
        ".modal",
        ".overlay",
        ".side-panel",
      ];

      for (const selector of panelSelectors) {
        const panel = document.querySelector(selector);
        if (panel && panel.offsetParent !== null) {
          // Panel is visible
          console.log(
            `[CodinGame Content Script] Found visible panel with selector: ${selector}`,
          );
          searchRoot = panel;
          break;
        }
      }

      if (searchRoot !== document) {
        console.log(
          "[CodinGame Content Script] Scoping battle search to panel element",
        );
      }

      // PRIORITY 1: Try to extract from Angular scope via page script
      console.log(
        "[CodinGame Content Script] Trying to extract battles from Angular scope via page script...",
      );
      try {
        const angularBattles = await getBattlesFromPageScript();
        console.log(
          "[CodinGame Content Script] getBattlesFromPageScript returned:",
          angularBattles,
        );
        if (angularBattles && angularBattles.length > 0) {
          console.log(
            `[CodinGame Content Script] ✅ Successfully extracted ${angularBattles.length} battles from Angular scope`,
          );
          return angularBattles;
        }
        console.log(
          "[CodinGame Content Script] No battles found in Angular scope (returned empty or null), falling back to DOM methods...",
        );
      } catch (e) {
        console.warn(
          "[CodinGame Content Script] Error getting battles from page script:",
          e,
        );
      }

      // First, try to dump all battle-related elements for debugging
      console.log("[CodinGame Content Script] Analyzing DOM structure...");
      const allButtons = document.querySelectorAll("button");
      console.log(
        `[CodinGame Content Script] Total buttons on page: ${allButtons.length}`,
      );

      // Log sample of elements that might contain battle data
      const sampleElements = searchRoot.querySelectorAll(
        'div[class*="battle"], div[class*="game"], tr, li',
      );
      if (sampleElements.length > 0) {
        console.log(
          `[CodinGame Content Script] Found ${sampleElements.length} potential battle containers`,
        );
        // Log first few for inspection
        for (let i = 0; i < Math.min(5, sampleElements.length); i++) {
          const el = sampleElements[i];
          console.log(`[CodinGame Content Script] Sample element ${i + 1}:`, {
            tag: el.tagName,
            classes: el.className,
            attributes: Array.from(el.attributes).map(
              (a) => `${a.name}="${a.value}"`,
            ),
            innerHTML: el.innerHTML.substring(0, 200),
            text: el.textContent.substring(0, 100),
          });
        }
      }

      // Wait for dynamic content to load (e.g., after clicking "LAST BATTLES")
      await waitForBattleContent();

      // Look for elements that might contain battle data
      // CodinGame typically has battle links or data attributes
      const selectors = [
        "[data-game-id]",
        'a[href*="/replay/"]',
        'a[href*="/cg/"]',
        'a[href*="/game/"]',
        ".battle-item",
        ".game-item",
        "[data-battle-id]",
        "[data-gameid]",
        ".report-item",
        'div[class*="battle"]',
        'div[class*="game"]',
        'div[class*="report"]',
        'tr[class*="battle"]',
        'tr[class*="game"]',
        'li[class*="battle"]',
        'li[class*="game"]',
        // Additional selectors for last battles panel
        'button[ng-click*="replay"]',
        'button[ng-click*="game"]',
        'button[class*="replay"]',
        ".cg-last-battles [ng-repeat]",
        ".cg-ide-last-battles [ng-repeat]",
        'div[ng-repeat*="battle"]',
        'div[ng-repeat*="game"]',
        'tr[ng-repeat*="battle"]',
        'tr[ng-repeat*="game"]',
      ];

      let battleElements = [];
      for (const selector of selectors) {
        const elements = searchRoot.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log(
            `[CodinGame Content Script] Found ${elements.length} elements with selector: ${selector}`,
          );
          battleElements = [...battleElements, ...elements];
        }
      }

      // If searching in panel and found nothing, also try excluding leaderboard rows
      if (searchRoot !== document && battleElements.length > 0) {
        // Filter out leaderboard rows (they contain "View last battles" but not actual battles)
        battleElements = battleElements.filter(
          (el) =>
            !el.classList.contains("codingamer") &&
            !el.closest(".leaderboard-table") &&
            !el.textContent?.includes("View last battles"),
        );
        console.log(
          `[CodinGame Content Script] After filtering leaderboard rows: ${battleElements.length} elements`,
        );
      }

      // Remove duplicates
      battleElements = [...new Set(battleElements)];

      if (battleElements.length === 0) {
        console.log(
          "[CodinGame Content Script] No battle elements found in DOM - will try API fallback",
        );
        console.log(
          '[CodinGame Content Script] Note: "VIEW LAST BATTLES" modal requires API access with testSessionHandle',
        );
        return null;
      }

      console.log(
        `[CodinGame Content Script] Total unique battle elements found: ${battleElements.length}`,
      );

      const battles = [];
      const seenGameIds = new Set();

      battleElements.forEach((el, index) => {
        let gameId = null;

        // Debug: Log first few elements to understand structure
        if (index < 3) {
          console.log(`[CodinGame Content Script] DEBUG Element ${index}:`, {
            tag: el.tagName,
            classes: el.className,
            id: el.id,
            attributes: Array.from(el.attributes).map(
              (a) => `${a.name}="${a.value}"`,
            ),
            textContent: el.textContent?.substring(0, 100),
            innerHTML: el.innerHTML?.substring(0, 200),
          });
        }

        // Method 1: Check common data attributes
        gameId =
          el.getAttribute("data-game-id") ||
          el.getAttribute("data-battle-id") ||
          el.getAttribute("data-id") ||
          el.getAttribute("data-gameid") ||
          el.getAttribute("gameid");

        // Method 1b: Check element.dataset (camelCase property access)
        if (!gameId && el.dataset) {
          gameId =
            el.dataset.gameId ||
            el.dataset.battleId ||
            el.dataset.id ||
            el.dataset.gameid ||
            el.dataset.battleid;
          if (gameId) {
            console.log(
              `[CodinGame Content Script] Found gameId in dataset: ${gameId}`,
            );
          }
        }

        // Method 2: Check all data-* attributes for numbers
        if (!gameId) {
          const attrs = el.attributes;
          for (let i = 0; i < attrs.length; i++) {
            const attr = attrs[i];
            if (attr.name.startsWith("data-")) {
              const match = attr.value.match(/^\d{8,}$/);
              if (match) {
                gameId = match[0];
                console.log(
                  `[CodinGame Content Script] Found gameId in attribute ${attr.name}: ${gameId}`,
                );
                break;
              }
            }
          }
        }

        // Method 3: Check href attributes
        if (!gameId && el.href) {
          const replayMatch = el.href.match(/\/replay\/(\d+)/);
          const cgMatch = el.href.match(/\/cg\/(\d+)/);
          const gameMatch = el.href.match(/\/game\/(\d+)/);
          if (replayMatch) {
            gameId = replayMatch[1];
          } else if (cgMatch) {
            gameId = cgMatch[1];
          } else if (gameMatch) {
            gameId = gameMatch[1];
          }
        }

        // Method 4: Check onclick attributes (allow shorter IDs)
        if (!gameId) {
          const onclick = el.getAttribute("onclick") || "";
          const onclickMatch = onclick.match(/(\d{7,})/);
          if (onclickMatch) {
            gameId = onclickMatch[1];
            console.log(
              `[CodinGame Content Script] Found gameId in onclick: ${gameId}`,
            );
          }
        }

        // Method 5: Look for anchor tags with game IDs in children
        if (!gameId) {
          const links = el.querySelectorAll(
            'a[href*="/replay/"], a[href*="/cg/"], a[href*="/game/"]',
          );
          for (const link of links) {
            const href = link.getAttribute("href") || "";
            const replayMatch = href.match(/\/replay\/(\d+)/);
            const cgMatch = href.match(/\/cg\/(\d+)/);
            const gameMatch = href.match(/\/game\/(\d+)/);
            if (replayMatch || cgMatch || gameMatch) {
              gameId = (replayMatch || cgMatch || gameMatch)[1];
              break;
            }
          }
        }

        // Method 6: Look for ng-* Angular attributes (CodinGame uses Angular)
        if (!gameId) {
          const ngClick =
            el.getAttribute("ng-click") ||
            el.getAttribute("ng-href") ||
            el.getAttribute("ng-repeat");
          if (ngClick) {
            // Try to extract from function calls like goToReplay(123456), viewGame({gameId:123456})
            const functionMatch = ngClick.match(/\(.*?(\d{8,}).*?\)/);
            if (functionMatch) {
              gameId = functionMatch[1];
              console.log(
                `[CodinGame Content Script] Found gameId in ng-click function call: ${gameId}`,
              );
            } else {
              // Fallback to any 8+ digit number
              const match = ngClick.match(/(\d{8,})/);
              if (match) {
                gameId = match[1];
              }
            }
          }
        }

        // Method 7: Check innerHTML for hidden game IDs (allow shorter IDs)
        if (!gameId) {
          const html = el.innerHTML;
          const htmlMatch =
            html.match(/gameId['":\s]+(\d{7,})/i) ||
            html.match(/game-id['":\s]+(\d{7,})/i) ||
            html.match(/battleId['":\s]+(\d{7,})/i) ||
            html.match(/battle-id['":\s]+(\d{7,})/i) ||
            html.match(/"id"['":\s]+(\d{7,})/i);
          if (htmlMatch) {
            gameId = htmlMatch[1];
            console.log(
              `[CodinGame Content Script] Found gameId in innerHTML: ${gameId}`,
            );
          }
        }

        // Method 8: Look for any data attribute with numeric value
        if (!gameId) {
          const dataAttrs = Array.from(el.attributes).filter((a) =>
            a.name.startsWith("data-"),
          );
          for (const attr of dataAttrs) {
            if (/^\d{7,}$/.test(attr.value)) {
              gameId = attr.value;
              console.log(
                `[CodinGame Content Script] Found gameId in ${attr.name}: ${gameId}`,
              );
              break;
            }
          }
        }

        // Method 9: Check for any long numeric ID in text content
        if (!gameId) {
          const textMatch = el.textContent.match(/\b(\d{9,})\b/);
          if (textMatch) {
            gameId = textMatch[1];
            console.log(
              `[CodinGame Content Script] Found gameId in text content: ${gameId}`,
            );
          }
        }

        if (gameId && !seenGameIds.has(gameId)) {
          seenGameIds.add(gameId);
          battles.push({ gameId });
          console.log(
            `[CodinGame Content Script] Found battle ${battles.length}: ${gameId}`,
          );
        } else if (!gameId && index < 5) {
          // Debug: Log why we couldn't find gameId for first few elements
          console.warn(
            `[CodinGame Content Script] Could not extract gameId from element ${index}:`,
            {
              tag: el.tagName,
              classes: el.className,
              allAttributes: Array.from(el.attributes).map(
                (a) => `${a.name}="${a.value.substring(0, 50)}"`,
              ),
              hasHref: !!el.href,
              hasOnclick: !!el.getAttribute("onclick"),
              hasNgClick: !!el.getAttribute("ng-click"),
              childLinks: el.querySelectorAll(
                'a[href*="/replay/"], a[href*="/cg/"], a[href*="/game/"]',
              ).length,
              textSample: el.textContent?.substring(0, 100),
            },
          );
        }
      });

      if (battles.length > 0) {
        console.log(
          `[CodinGame Content Script] Extracted ${battles.length} battles from DOM`,
        );
        return battles;
      }

      console.log(
        "[CodinGame Content Script] No battles found in DOM after checking all methods",
      );
      console.log(
        "[CodinGame Content Script] 💡 Tip: Make sure battles are visible on the page",
      );
      console.log(
        "[CodinGame Content Script] 💡 Try expanding/scrolling the battle list if needed",
      );

      // Log some debug info to help diagnose
      console.log("[CodinGame Content Script] Debug info:");
      console.log("  - Battle elements found:", battleElements.length);
      console.log(
        "  - Sample classes:",
        Array.from(
          new Set(
            Array.from(
              document.querySelectorAll(
                'div[class*="battle"], div[class*="game"]',
              ),
            )
              .slice(0, 5)
              .map((el) => el.className),
          ),
        ),
      );

      return null;
    } catch (error) {
      console.error(
        "[CodinGame Content Script] Error extracting battles from DOM:",
        error,
      );
      throw error;
    }
  }

  // NOTE: Session info extraction (userId and testSessionHandle) is now handled
  // by page-script.js which has access to window.session and other page globals.
  // Content script just listens for responses.

  // Show button when on CodinGame arena/challenge/leaderboard pages
  function checkAndShowButton() {
    const isArenaPage =
      window.location.href.includes("/ide/challenge") ||
      window.location.href.includes("/ide/puzzle") ||
      window.location.href.includes("/leaderboard") ||
      window.location.href.includes("/hackathon/");

    if (isArenaPage && !capturePanel) {
      createBatchCaptureButton();
      setupLastBattlesPanelDetection();
    } else if (!isArenaPage && capturePanel) {
      capturePanel.remove();
      capturePanel = null;
      captureButton = null;
      pauseResumeButton = null;
      stopButton = null;
      categoryInput = null;
      captureStatusText = null;
      if (lastBattlesPanelObserver) {
        lastBattlesPanelObserver.disconnect();
        lastBattlesPanelObserver = null;
      }
    }
  }

  function setupLastBattlesPanelDetection() {
    // Disconnect existing observer if any
    if (lastBattlesPanelObserver) {
      lastBattlesPanelObserver.disconnect();
    }

    // Observe DOM for last battles panel appearing or battles being loaded
    lastBattlesPanelObserver = new MutationObserver(() => {
      // Check if we have available battles (set by page script)
      // Note: Team name extraction is now handled by the API response in __cgBattleListCaptured event
      // The DOM extraction was causing issues by overwriting the correct API-extracted team name
      // So we no longer call extractTeamName() here
      if (availableBattles && availableBattles.length > 0) {
        console.log(
          `[CodinGame Content Script] Battles loaded (${availableBattles.length} available)`,
        );
        // Team name should already be set by the __cgBattleListCaptured event handler
        // which receives the correct team name from the API
      }
    });

    // Observe the entire document for changes
    lastBattlesPanelObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }

  // Check on load and on navigation
  checkAndShowButton();

  // Watch for URL changes (for SPAs)
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;

      // Stop monitoring when navigating away from arena/leaderboard pages
      if (
        !currentUrl.includes("/ide/challenge") &&
        !currentUrl.includes("/ide/puzzle") &&
        !currentUrl.includes("/leaderboard") &&
        !currentUrl.includes("/hackathon/")
      ) {
        stopContinuousMonitoring();
        capturedBattleIds.clear(); // Clear captured battles when leaving the page
      }

      checkAndShowButton();
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Debug helper for content script
  window.__cgDebug = {
    testBackgroundConnection: async () => {
      console.log("=== Testing Content → Background Connection ===");

      try {
        console.log("Sending test message to background...");
        const response = await chrome.runtime.sendMessage({
          type: "battle_response_captured",
          payload: {
            url: "/test/debug",
            body: JSON.stringify({ test: true, timestamp: Date.now() }),
            userId: 12345,
            gameId: 99999,
          },
        });

        console.log("✓ Background received message!");
        console.log("Response:", response);
        console.log("Check background console for [BATTLE] logs");
        return true;
      } catch (error) {
        console.error("✗ Failed to communicate with background:");
        console.error("Error:", error.message);
        console.error("Stack:", error.stack);
        console.error("");
        console.error("Possible causes:");
        console.error("1. Background script crashed or reloaded");
        console.error("2. Extension was disabled/reloaded");
        console.error("3. Message listener not registered");
        return false;
      }
    },

    getAvailableBattles: () => {
      console.log("=== Available Battles ===");
      console.log("Count:", availableBattles ? availableBattles.length : 0);
      if (availableBattles && availableBattles.length > 0) {
        console.log("First 5 battles:", availableBattles.slice(0, 5));
      }
      return availableBattles;
    },

    getCapturedBattles: () => {
      console.log("=== Captured Battles ===");
      console.log("Count:", capturedBattleIds.size);
      console.log("IDs:", Array.from(capturedBattleIds));
      return Array.from(capturedBattleIds);
    },

    setCategory: (category) => {
      captureCategory = sanitizeCategory(category);
      const categoryInput = document.getElementById("cg-capture-category");
      if (categoryInput) {
        categoryInput.value = captureCategory;
      }
      console.log("Category set to:", captureCategory);
      return captureCategory;
    },

    getCategory: () => {
      console.log("Current category:", captureCategory);
      return captureCategory;
    },
  };

  console.log(
    "%c[CodinGame Content Script] Debug helper loaded",
    "color: green; font-weight: bold",
  );
  console.log("Available commands:");
  console.log(
    "  window.__cgDebug.testBackgroundConnection() - Test if content can reach background",
  );
  console.log(
    "  window.__cgDebug.getAvailableBattles()      - Show battles from API",
  );
  console.log(
    "  window.__cgDebug.getCapturedBattles()       - Show already captured battle IDs",
  );
  console.log(
    "  window.__cgDebug.setCategory('name')        - Set capture category",
  );
  console.log(
    "  window.__cgDebug.getCategory()              - Get current category",
  );
})();
