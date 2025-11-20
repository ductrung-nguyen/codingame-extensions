// This script runs in the page context (not isolated like content scripts)
// It has access to window.angular and other page globals

(function () {
  console.log("[CodinGame Page Context] Script loaded");
  console.log(
    "[CodinGame Page Context] Angular available:",
    typeof window.angular,
  );
  console.log(
    "[CodinGame Page Context] Monaco available:",
    typeof window.monaco,
  );

  // Create test function that can access page globals
  window.__cgTestSync = function (code) {
    console.log("[CodinGame Page Context] __cgTestSync() called");
    console.log("[CodinGame Page Context] Angular:", typeof window.angular);
    console.log("[CodinGame Page Context] Monaco:", typeof window.monaco);

    // Dispatch custom event to communicate with content script
    const event = new CustomEvent("__cgTestSync", {
      detail: {
        code:
          code ||
          '// TEST CODE FROM CONSOLE\npackage main\n\nfunc main() {\n    println("Test from page context!")\n}\n',
        language: "Go",
      },
    });

    window.dispatchEvent(event);
    console.log("[CodinGame Page Context] Event dispatched to content script");

    return {
      success: true,
      angularAvailable: typeof window.angular === "object",
      monacoAvailable: typeof window.monaco === "object",
    };
  };

  // Main sync function that updates the editor using Angular
  window.__cgSyncCode = function (code) {
    console.log(
      "[CodinGame Page Context] __cgSyncCode() called with",
      code.length,
      "characters",
    );

    // Check if Angular is available
    if (typeof window.angular !== "object") {
      console.error("[CodinGame Page Context] Angular not available!");
      return {
        success: false,
        error: "Angular not available in page context",
      };
    }

    // Get the code editor element
    const codeEditorElement = document.querySelector(".code-editor");
    if (!codeEditorElement) {
      console.error("[CodinGame Page Context] .code-editor element not found");
      return {
        success: false,
        error: "code-editor element not found",
      };
    }

    try {
      // Get Angular element and ngModelController
      const ngElement = window.angular.element(codeEditorElement);
      const data = ngElement.data();
      const ngModel = data && data.$ngModelController;

      if (!ngModel) {
        console.error("[CodinGame Page Context] ngModelController not found");
        return {
          success: false,
          error: "ngModelController not found",
        };
      }

      console.log(
        "[CodinGame Page Context] Current value:",
        ngModel.$viewValue?.substring(0, 50) + "...",
      );
      console.log("[CodinGame Page Context] Setting new value...");

      // Update the model using Angular's API
      ngModel.$setViewValue(code);
      ngModel.$render();

      // Trigger Angular digest cycle - try multiple methods
      let digestTriggered = false;

      // Method 1: Try to get scope from element
      try {
        const scope = ngElement.scope();
        if (scope && scope.$apply) {
          scope.$apply();
          console.log(
            "[CodinGame Page Context] ✅ Angular $apply() called via element scope",
          );
          digestTriggered = true;
        }
      } catch (e) {
        console.log("[CodinGame Page Context] Method 1 failed:", e.message);
      }

      // Method 2: Try to get root scope
      if (!digestTriggered) {
        try {
          const injector = window.angular.element(document.body).injector();
          if (injector) {
            const $rootScope = injector.get("$rootScope");
            if ($rootScope && $rootScope.$apply) {
              $rootScope.$apply();
              console.log(
                "[CodinGame Page Context] ✅ Angular $apply() called via $rootScope",
              );
              digestTriggered = true;
            }
          }
        } catch (e) {
          console.log("[CodinGame Page Context] Method 2 failed:", e.message);
        }
      }

      // Method 3: Force render even without digest
      if (!digestTriggered) {
        console.warn(
          "[CodinGame Page Context] ⚠️ Could not trigger $apply, forcing $render only",
        );
      }

      console.log(
        "[CodinGame Page Context] ✅ Code updated successfully via Angular!",
      );
      console.log(
        "[CodinGame Page Context] New value:",
        ngModel.$viewValue?.substring(0, 50) + "...",
      );

      return {
        success: true,
        method: "angular-ngmodel",
        valueLength: ngModel.$viewValue?.length || 0,
      };
    } catch (error) {
      console.error("[CodinGame Page Context] Error updating code:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  };

  // Function to detect current language from CodinGame page
  window.__cgGetCurrentLanguage = function () {
    console.log("[CodinGame Page Context] Detecting current language...");

    // Helper to normalize language strings
    const normalizeLanguage = (lang) => {
      if (!lang) return null;

      // Trim whitespace
      lang = lang.trim();

      // Normalize common variations
      const normalizations = {
        "python 3": "Python3",
        python3: "Python3",
        python: "Python3",
        javascript: "JavaScript",
        typescript: "TypeScript",
        "c++": "C++",
        cpp: "C++",
        "c#": "C#",
        csharp: "C#",
        "f#": "F#",
        fsharp: "F#",
        "objective-c": "Objective-C",
        objectivec: "Objective-C",
        "vb.net": "VB.NET",
        vb: "VB.NET",
        rust: "Rust",
        kotlin: "Kotlin",
        swift: "Swift",
      };

      const lowerLang = lang.toLowerCase();
      if (normalizations[lowerLang]) {
        return normalizations[lowerLang];
      }

      // Capitalize first letter for other languages
      return lang.charAt(0).toUpperCase() + lang.slice(1);
    };

    // Method 1: Try to get from Angular scope
    try {
      const codeEditorElement = document.querySelector(".code-editor");
      if (codeEditorElement && typeof window.angular === "object") {
        const ngElement = window.angular.element(codeEditorElement);
        const scope = ngElement.scope();

        if (scope && scope.question && scope.question.programmingLanguageId) {
          const langId = normalizeLanguage(
            scope.question.programmingLanguageId,
          );
          console.log(
            "[CodinGame Page Context] Language from Angular scope:",
            langId,
          );
          return langId;
        }
      }
    } catch (e) {
      console.log(
        "[CodinGame Page Context] Could not get language from Angular:",
        e.message,
      );
    }

    // Method 2: Try to get from URL or other page elements
    try {
      const url = window.location.href;
      const langMatch = url.match(/language=([^&]+)/);
      if (langMatch) {
        const langId = normalizeLanguage(decodeURIComponent(langMatch[1]));
        console.log("[CodinGame Page Context] Language from URL:", langId);
        return langId;
      }
    } catch (e) {
      console.log(
        "[CodinGame Page Context] Could not get language from URL:",
        e.message,
      );
    }

    // Method 3: Try to get from language selector dropdown
    try {
      const langSelector = document.querySelector(
        ".language-select, [data-language], .cg-ide-language-selector",
      );
      if (langSelector) {
        const langText = langSelector.textContent || langSelector.value;
        const langId = normalizeLanguage(langText);
        console.log("[CodinGame Page Context] Language from selector:", langId);
        return langId;
      }
    } catch (e) {
      console.log(
        "[CodinGame Page Context] Could not get language from selector:",
        e.message,
      );
    }

    console.warn("[CodinGame Page Context] Could not detect current language");
    return null;
  };

  // Helper function to get Angular scope
  window.__cgGetAngularScope = function () {
    const codeEditorElement = document.querySelector(".code-editor");
    if (!codeEditorElement) {
      console.error("[CodinGame Page Context] .code-editor element not found");
      return null;
    }

    if (typeof window.angular !== "object") {
      console.error("[CodinGame Page Context] Angular not available");
      return null;
    }

    try {
      const ngElement = window.angular.element(codeEditorElement);
      const scope = ngElement.scope();
      console.log("[CodinGame Page Context] Angular scope:", scope);
      return scope;
    } catch (error) {
      console.error("[CodinGame Page Context] Error getting scope:", error);
      return null;
    }
  };

  // Helper to get ngModelController
  window.__cgGetNgModel = function () {
    const codeEditorElement = document.querySelector(".code-editor");
    if (!codeEditorElement) {
      console.error("[CodinGame Page Context] .code-editor element not found");
      return null;
    }

    if (typeof window.angular !== "object") {
      console.error("[CodinGame Page Context] Angular not available");
      return null;
    }

    try {
      const ngElement = window.angular.element(codeEditorElement);
      const data = ngElement.data();
      const ngModel = data && data.$ngModelController;
      console.log("[CodinGame Page Context] ngModelController:", ngModel);
      return ngModel;
    } catch (error) {
      console.error("[CodinGame Page Context] Error getting ngModel:", error);
      return null;
    }
  };

  // Listen for sync requests from content script
  window.addEventListener("__cgSyncCodeRequest", (event) => {
    console.log(
      "[CodinGame Page Context] Received sync request from content script",
    );
    const { code, requestId } = event.detail;

    const result = window.__cgSyncCode(code);

    // Send result back to content script
    const responseEvent = new CustomEvent("__cgSyncCodeResponse", {
      detail: {
        requestId: requestId,
        result: result,
      },
    });
    window.dispatchEvent(responseEvent);
    console.log(
      "[CodinGame Page Context] Sent sync response to content script",
    );
  });

  // Listen for language detection requests from content script
  window.addEventListener("__cgDetectLanguage", () => {
    console.log("[CodinGame Page Context] Received language detection request");
    const language = window.__cgGetCurrentLanguage();

    // Send result back to content script
    const responseEvent = new CustomEvent("__cgLanguageDetected", {
      detail: {
        language: language,
      },
    });
    window.dispatchEvent(responseEvent);
    console.log(
      "[CodinGame Page Context] Sent language detection response:",
      language,
    );
  });

  console.log("[CodinGame Page Context] ✅ Test functions ready:");
  console.log("[CodinGame Page Context]   - window.__cgTestSync(code?)");
  console.log("[CodinGame Page Context]   - window.__cgSyncCode(code)");
  console.log("[CodinGame Page Context]   - window.__cgGetAngularScope()");
  console.log("[CodinGame Page Context]   - window.__cgGetNgModel()");
  console.log("[CodinGame Page Context]   - window.__cgGetCurrentLanguage()");

  // ========================================
  // Battle Request Interception
  // ========================================

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

  function isBattleEndpoint(url) {
    if (!url) return false;
    return BATTLE_ENDPOINTS.some((endpoint) => url.includes(endpoint));
  }

  function notifyBattleCapture(url, body) {
    console.log("[CodinGame Page Context] Battle response captured!");
    console.log("[CodinGame Page Context] Battle URL:", url);
    console.log("[CodinGame Page Context] Body length:", body?.length);
    console.log(
      "[CodinGame Page Context] Body preview:",
      body?.substring(0, 200),
    );

    // Send to content script via custom event
    const event = new CustomEvent("__cgBattleResponseCaptured", {
      detail: {
        url: url,
        body: body,
      },
    });
    window.dispatchEvent(event);
    console.log(
      "[CodinGame Page Context] Battle response event dispatched to content script",
    );
  }

  // Intercept fetch API
  console.log("[CodinGame Page Context] Setting up fetch interception...");
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const [resource, config] = args;
    const url = typeof resource === "string" ? resource : resource.url;
    const method = config?.method?.toUpperCase() || "GET";

    // Intercept findLastBattlesByAgentId to capture battle list
    if (
      method === "POST" &&
      url &&
      url.includes("/services/gamesPlayersRanking/findLastBattlesByAgentId")
    ) {
      console.log(
        "[CodinGame Page Context] Intercepting findLastBattlesByAgentId...",
      );
      return originalFetch.apply(this, args).then(async (response) => {
        if (response.ok) {
          const clonedResponse = response.clone();
          try {
            const battles = await clonedResponse.json();
            console.log(
              "[CodinGame Page Context] Captured battle list:",
              battles.length,
              "battles",
            );
            // Notify content script about available battles
            const event = new CustomEvent("__cgBattleListCaptured", {
              detail: { battles },
            });
            window.dispatchEvent(event);
          } catch (err) {
            console.warn(
              "[CodinGame Page Context] Failed to parse battle list response:",
              err,
            );
          }
        }
        return response;
      });
    }

    // Intercept startTestSession to cache the testSessionHandle
    if (
      method === "POST" &&
      url &&
      url.includes("/services/TestSession/startTestSession")
    ) {
      console.log("[CodinGame Page Context] Intercepting startTestSession...");
      return originalFetch.apply(this, args).then(async (response) => {
        if (response.ok) {
          const clonedResponse = response.clone();
          try {
            const data = await clonedResponse.json();
            if (data && data.handle) {
              cachedTestSessionHandle = data.handle;
              console.log(
                "[CodinGame Page Context] Cached testSessionHandle from startTestSession:",
                cachedTestSessionHandle,
              );
            }
          } catch (err) {
            console.warn(
              "[CodinGame Page Context] Failed to parse startTestSession response:",
              err,
            );
          }
        }
        return response;
      });
    }

    if (method === "POST" && isBattleEndpoint(url)) {
      console.log("[CodinGame Page Context] Intercepting battle POST to:", url);
      return originalFetch.apply(this, args).then(async (response) => {
        console.log(
          "[CodinGame Page Context] Battle response received, ok:",
          response.ok,
        );
        if (response.ok) {
          const clonedResponse = response.clone();
          try {
            const body = await clonedResponse.text();
            console.log(
              "[CodinGame Page Context] Battle response body read, notifying...",
            );
            notifyBattleCapture(url, body);
          } catch (err) {
            console.error(
              "[CodinGame Page Context] Failed to read response:",
              err,
            );
          }
        }
        return response;
      });
    }
    return originalFetch.apply(this, args);
  };

  // Intercept XMLHttpRequest
  console.log("[CodinGame Page Context] Setting up XHR interception...");
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._method = method;
    this._url = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._method?.toUpperCase() === "POST" && isBattleEndpoint(this._url)) {
      console.log(
        "[CodinGame Page Context] Intercepting battle XHR POST to:",
        this._url,
      );

      const url = this._url;

      this.addEventListener("load", function () {
        console.log(
          "[CodinGame Page Context] XHR battle response received, status:",
          this.status,
        );
        if (this.status === 200) {
          try {
            const body = this.responseText;
            console.log(
              "[CodinGame Page Context] XHR response body read, notifying...",
            );

            // Special handling for battle list API
            if (
              url &&
              url.includes(
                "/services/gamesPlayersRanking/findLastBattlesByAgentId",
              )
            ) {
              try {
                const battles = JSON.parse(body);
                console.log(
                  "[CodinGame Page Context] Captured battle list via XHR:",
                  battles.length,
                  "battles",
                );
                // Notify content script about available battles
                const event = new CustomEvent("__cgBattleListCaptured", {
                  detail: { battles },
                });
                window.dispatchEvent(event);
                console.log(
                  "[CodinGame Page Context] Battle list event dispatched",
                );
              } catch (err) {
                console.warn(
                  "[CodinGame Page Context] Failed to parse battle list from XHR:",
                  err,
                );
              }
            }

            notifyBattleCapture(url, body);
          } catch (err) {
            console.error(
              "[CodinGame Page Context] Failed to read XHR response:",
              err,
            );
          }
        }
      });
    }
    return originalSend.apply(this, args);
  };

  console.log("[CodinGame Page Context] ✅ Battle interception setup complete");
  console.log("[CodinGame Page Context] Battle endpoints:", BATTLE_ENDPOINTS);

  // ========================================
  // Session Info Extraction for Batch Capture
  // ========================================

  // Cache for session info extracted from API responses
  let cachedUserId = null;
  let cachedTestSessionHandle = null;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    if (event.data.type === "__cgGetUserId") {
      console.log("[CodinGame Page Context] Received request for user ID");
      let userId = cachedUserId; // Try cached value first
      console.log("[CodinGame Page Context] Cached userId:", userId);

      // Method 1: Try to get from window.session.codinGamer.userId (most reliable)
      if (!userId) {
        try {
          if (
            window.session &&
            window.session.codinGamer &&
            window.session.codinGamer.userId
          ) {
            userId = window.session.codinGamer.userId;
            console.log(
              "[CodinGame Page Context] Found user ID from window.session.codinGamer:",
              userId,
            );
          }
        } catch (e) {
          console.warn(
            "[CodinGame Page Context] Could not get userId from window.session:",
            e,
          );
        }
      }

      // Method 2: Try to get from localStorage - cgAnalyticsUserProperties
      if (!userId) {
        try {
          const analyticsData = localStorage.getItem(
            "cgAnalyticsUserProperties.codingame",
          );
          if (analyticsData) {
            const parsed = JSON.parse(analyticsData);
            if (parsed && parsed["Handle ID"]) {
              userId = parsed["Handle ID"];
              console.log(
                "[CodinGame Page Context] Found user ID from localStorage analytics:",
                userId,
              );
            }
          }
        } catch (e) {
          console.warn(
            "[CodinGame Page Context] Could not get userId from localStorage:",
            e,
          );
        }
      }

      // Method 3: Try Angular scope
      if (!userId) {
        try {
          if (typeof window.angular !== "undefined") {
            const bodyElement = window.angular.element(document.body);
            const scope = bodyElement.scope();
            if (scope && scope.user && scope.user.id) {
              userId = scope.user.id;
              console.log(
                "[CodinGame Page Context] Found user ID from Angular scope:",
                userId,
              );
            }
          }
        } catch (e) {
          console.warn(
            "[CodinGame Page Context] Could not get userId from Angular:",
            e,
          );
        }
      }

      // Method 4: Try global variables
      if (!userId) {
        try {
          const globalUserVars = [
            "CodinGamer",
            "cgUser",
            "currentUser",
            "codinGamer",
          ];
          for (let varName of globalUserVars) {
            if (window[varName] && window[varName].userId) {
              userId = window[varName].userId;
              console.log(
                "[CodinGame Page Context] Found user ID from window." +
                  varName +
                  ".userId:",
                userId,
              );
              break;
            }
            if (window[varName] && window[varName].id) {
              userId = window[varName].id;
              console.log(
                "[CodinGame Page Context] Found user ID from window." +
                  varName +
                  ".id:",
                userId,
              );
              break;
            }
          }
        } catch (e) {
          console.warn(
            "[CodinGame Page Context] Could not get userId from global variables:",
            e,
          );
        }
      }

      // If still no userId, try API call as last resort
      if (!userId) {
        console.log(
          "[CodinGame Page Context] Attempting API call to get userId...",
        );

        // Try multiple API endpoints
        const tryAPIs = async () => {
          // Try getCurrentCodinGamer (most reliable)
          try {
            const response = await fetch(
              "https://www.codingame.com/services/CodinGamer/getCurrentCodinGamer",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
                body: JSON.stringify([]),
              },
            );

            if (response.ok) {
              const data = await response.json();
              if (data && data.userId) {
                userId = data.userId;
                cachedUserId = userId;
                console.log(
                  "[CodinGame Page Context] ✅ Found userId from getCurrentCodinGamer:",
                  userId,
                );
                window.postMessage({ type: "__cgUserIdResponse", userId }, "*");
                return;
              }
            }
          } catch (err) {
            console.warn(
              "[CodinGame Page Context] getCurrentCodinGamer failed:",
              err.message,
            );
          }

          // Fallback: try to get from session
          try {
            const response = await fetch(
              "https://www.codingame.com/services/session/findSession",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
                body: JSON.stringify([]),
              },
            );

            if (response.ok) {
              const data = await response.json();
              if (data && data.userId) {
                userId = data.userId;
                cachedUserId = userId;
                console.log(
                  "[CodinGame Page Context] ✅ Found userId from session:",
                  userId,
                );
                window.postMessage({ type: "__cgUserIdResponse", userId }, "*");
                return;
              }
            }
          } catch (err) {
            console.warn(
              "[CodinGame Page Context] findSession failed:",
              err.message,
            );
          }

          // All methods failed
          console.warn(
            "[CodinGame Page Context] Could not find userId from any source",
          );
          window.postMessage({ type: "__cgUserIdResponse", userId: null }, "*");
        };

        tryAPIs();
        return; // Exit early, response will be sent asynchronously
      }

      if (userId) {
        console.log("[CodinGame Page Context] Responding with userId:", userId);
        // Cache it for future use
        cachedUserId = userId;
      }

      window.postMessage({ type: "__cgUserIdResponse", userId }, "*");
    }

    if (event.data.type === "__cgGetTestSessionHandle") {
      console.log(
        "[CodinGame Page Context] Received request for test session handle",
      );
      let handle = cachedTestSessionHandle; // Try cached value first
      console.log("[CodinGame Page Context] Cached testSessionHandle:", handle);

      // Try to get test session handle from Angular scope
      if (!handle) {
        try {
          if (typeof window.angular !== "undefined") {
            const bodyElement = window.angular.element(document.body);
            const scope = bodyElement.scope();
            if (scope && scope.testSession && scope.testSession.handle) {
              handle = scope.testSession.handle;
              console.log(
                "[CodinGame Page Context] Found test session handle from Angular scope:",
                handle,
              );
            }
          }
        } catch (e) {
          console.warn(
            "[CodinGame Page Context] Could not get test session handle from Angular:",
            e,
          );
        }
      }

      // Try to get from any global object
      if (!handle && window.testSession && window.testSession.handle) {
        handle = window.testSession.handle;
        console.log(
          "[CodinGame Page Context] Found test session handle from global:",
          handle,
        );
      }

      // Note: Cannot construct a valid handle from URL - the API requires a real test session handle
      // If no handle is found, the content-script will fall back to DOM extraction

      if (handle) {
        console.log(
          "[CodinGame Page Context] Responding with testSessionHandle:",
          handle,
        );
        cachedTestSessionHandle = handle;
      } else {
        console.warn(
          "[CodinGame Page Context] Could not find testSessionHandle from any source",
        );
      }

      window.postMessage(
        { type: "__cgTestSessionHandleResponse", handle },
        "*",
      );
    }

    // Handle battle list extraction request
    if (event.data.type === "__cgGetBattles") {
      console.log("[CodinGame Page Context] Received request for battles");
      let battles = [];

      try {
        // Try to find battles in Angular scope
        if (typeof window.angular !== "undefined") {
          console.log(
            "[CodinGame Page Context] Angular is available, searching for battles...",
          );

          // Try multiple selectors for battle containers
          const selectors = [
            ".cg-last-battles",
            ".cg-ide-last-battles",
            "[battles]",
            '[ng-repeat*="battle"]',
            "cg-last-battles",
            'div[class*="last-battle"]',
            'div[class*="ranking"]',
          ];

          let foundBattles = false;

          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            console.log(
              `[CodinGame Page Context] Selector "${selector}" found ${elements.length} elements`,
            );

            for (const element of elements) {
              const ngElement = window.angular.element(element);
              const scope = ngElement.scope();

              if (scope) {
                console.log(
                  `[CodinGame Page Context] Scope found for ${selector}, inspecting...`,
                );

                // Traverse scope hierarchy to find battles
                let currentScope = scope;
                let depth = 0;
                const maxDepth = 10;

                while (currentScope && depth < maxDepth) {
                  // Check multiple property names for battles
                  const battlesData =
                    currentScope.battles ||
                    currentScope.lastBattles ||
                    currentScope.battle ||
                    currentScope.gameReports ||
                    currentScope.reports ||
                    currentScope.games;

                  if (Array.isArray(battlesData) && battlesData.length > 0) {
                    console.log(
                      `[CodinGame Page Context] Found battles array at depth ${depth}:`,
                      battlesData.length,
                    );

                    battlesData.forEach((battle, index) => {
                      const gameId =
                        battle.gameId ||
                        battle.id ||
                        battle.battleId ||
                        battle.gameResultId;
                      if (gameId) {
                        battles.push({ gameId: String(gameId) });
                        console.log(
                          `[CodinGame Page Context] Found battle ${battles.length}: ${gameId}`,
                        );
                        foundBattles = true;
                      } else {
                        // Log structure for debugging
                        if (index === 0) {
                          console.log(
                            "[CodinGame Page Context] Battle object keys:",
                            Object.keys(battle),
                          );
                        }
                      }
                    });

                    if (foundBattles) break;
                  }

                  // Move up the scope hierarchy
                  currentScope = currentScope.$parent;
                  depth++;
                }

                if (foundBattles) break;
              }
            }

            if (foundBattles) break;
          }

          // If still no battles, try looking in the entire body scope
          if (battles.length === 0) {
            console.log(
              "[CodinGame Page Context] Trying body scope as last resort...",
            );
            const bodyElement = window.angular.element(document.body);
            const bodyScope = bodyElement.scope();

            if (bodyScope) {
              // First, log all top-level properties for debugging
              console.log(
                "[CodinGame Page Context] Body scope top-level properties:",
                Object.keys(bodyScope).filter((k) => !k.startsWith("$")),
              );

              // Search all properties recursively (limited depth)
              const searchScope = (
                obj,
                depth = 0,
                maxDepth = 3,
                path = "root",
              ) => {
                if (depth > maxDepth || !obj || typeof obj !== "object") return;

                for (const key in obj) {
                  if (key.startsWith("$")) continue; // Skip Angular internal properties

                  const value = obj[key];
                  const currentPath = `${path}.${key}`;

                  if (Array.isArray(value) && value.length > 0) {
                    // Check if this looks like a battles array
                    const first = value[0];
                    console.log(
                      `[CodinGame Page Context] Found array at ${currentPath} with ${value.length} items, first item keys:`,
                      first ? Object.keys(first).slice(0, 10) : "null",
                    );

                    if (
                      first &&
                      (first.gameId ||
                        first.id ||
                        first.battleId ||
                        first.gameResultId)
                    ) {
                      console.log(
                        `[CodinGame Page Context] ✅ Found battles array in property: ${currentPath}`,
                      );
                      value.forEach((battle) => {
                        const gameId =
                          battle.gameId ||
                          battle.id ||
                          battle.battleId ||
                          battle.gameResultId;
                        if (gameId) {
                          battles.push({ gameId: String(gameId) });
                          console.log(
                            `[CodinGame Page Context] Added battle: ${gameId}`,
                          );
                        }
                      });
                      return true;
                    }
                  } else if (typeof value === "object" && value !== null) {
                    if (searchScope(value, depth + 1, maxDepth, currentPath))
                      return true;
                  }
                }
                return false;
              };

              searchScope(bodyScope);
            }
          }
        } else {
          console.log("[CodinGame Page Context] Angular not available");
        }

        console.log(
          `[CodinGame Page Context] Extracted ${battles.length} battles from Angular scope`,
        );
      } catch (e) {
        console.error("[CodinGame Page Context] Error extracting battles:", e);
      }

      window.postMessage({ type: "__cgBattlesResponse", battles }, "*");
    }
  });

  console.log(
    "[CodinGame Page Context] ✅ Session info extraction helpers ready",
  );
})();
