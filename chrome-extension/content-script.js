(() => {
  const EDITOR_POLL_INTERVAL_MS = 500;
  const EDITOR_POLL_TIMEOUT_MS = 20000;
  const STATUS_FADE_TIMEOUT_MS = 2500;
  const BATTLE_ENDPOINTS = [
    '/services/TestSession/run',
    '/services/TestSession/start',
    '/services/TestSession/submit',
    '/services/TestSession/play',
    '/services/gameResult/',
    '/services/Arena/',
    '/services/Challenge/',
  ];

  let editorCache = null;
  let overlayEl = null;
  let overlayTimer = null;

  console.log('[CodinGame Content Script] Loading...');

  // Inject page script as external file (CSP-compliant)
  // This runs in page context where window.angular is accessible
  function injectPageScript() {
    console.log('[CodinGame Content Script] Injecting page script (CSP-compliant)...');
    const script = document.createElement('script');
    script.id = '__cg_page_script';
    script.src = chrome.runtime.getURL('page-script.js');
    script.onload = function () {
      console.log('[CodinGame Content Script] ✅ Page script loaded successfully');
      this.remove();
    };
    script.onerror = function () {
      console.error('[CodinGame Content Script] ❌ Failed to load page script');
      this.remove();
    };

    const target = document.head || document.documentElement;
    if (target) {
      target.appendChild(script);
      console.log('[CodinGame Content Script] Script element added to DOM');
    } else {
      console.error('[CodinGame Content Script] ❌ Cannot inject: no head or documentElement');
    }
  }

  // Inject immediately if document is ready, otherwise wait
  if (document.readyState === 'loading') {
    console.log('[CodinGame Content Script] Document loading, waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', injectPageScript);
  } else {
    console.log('[CodinGame Content Script] Document ready, injecting now...');
    injectPageScript();
  }

  // Listen for the custom event from page context (test function)
  window.addEventListener('__cgTestSync', (event) => {
    console.log('[CodinGame Content Script] Received test sync event');
    const testMessage = {
      type: 'sync_code',
      requestId: 'console-test-' + Date.now(),
      payload: {
        code: event.detail.code,
        language: event.detail.language
      }
    };

    // Call the message listener directly
    if (window.__cgMessageListener) {
      console.log('[CodinGame Content Script] Calling message listener...');
      const mockSender = { tab: { id: -1 } };
      const mockSendResponse = (response) => {
        console.log('[TEST] Response:', response);
      };
      const result = window.__cgMessageListener(testMessage, mockSender, mockSendResponse);
      console.log('[TEST] Message listener returned:', result);
    } else {
      console.error('[TEST] Message listener not found! Wait for init() to complete.');
    }
  });

  // Listen for battle response events from page script
  window.addEventListener('__cgBattleResponseCaptured', (event) => {
    console.log('[CodinGame Content Script] Received battle response event from page script');
    const { url, body, userId, gameId } = event.detail;

    console.log('[CodinGame Content Script] Battle URL:', url);
    console.log('[CodinGame Content Script] Body length:', body?.length);
    if (userId) console.log('[CodinGame Content Script] User ID:', userId);
    if (gameId) console.log('[CodinGame Content Script] Game ID:', gameId);
    console.log('[CodinGame Content Script] Forwarding to background script...');

    // Forward to background script
    chrome.runtime.sendMessage({
      type: 'battle_response_captured',
      payload: { url, body, userId, gameId }
    }).then(() => {
      console.log('[CodinGame Content Script] Battle response message sent successfully to background');
    }).catch((err) => {
      console.error('[CodinGame Content Script] Failed to notify background:', err);
      console.error('[CodinGame Content Script] Error details:', err.message, err.stack);
    });
  });

  // Listen for sync responses from page script
  const pendingSyncRequests = new Map();

  window.addEventListener('__cgSyncCodeResponse', (event) => {
    console.log('[CodinGame Content Script] Received sync response from page script');
    const { requestId, result } = event.detail;

    const resolver = pendingSyncRequests.get(requestId);
    if (resolver) {
      resolver(result);
      pendingSyncRequests.delete(requestId);
    } else {
      console.warn('[CodinGame Content Script] No pending request found for:', requestId);
    }
  });

  // Function to sync code via page script (uses Angular)
  function syncViaPageScript(code, requestId) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingSyncRequests.delete(requestId);
        reject(new Error('Page script sync timeout'));
      }, 5000);

      pendingSyncRequests.set(requestId, (result) => {
        clearTimeout(timeoutId);
        resolve(result);
      });

      // Send request to page script
      const event = new CustomEvent('__cgSyncCodeRequest', {
        detail: { code, requestId }
      });
      window.dispatchEvent(event);
      console.log('[CodinGame Content Script] Sent sync request to page script');
    });
  }

  console.log('[CodinGame Content Script] Test function listener registered');

  // Helper function to normalize language for comparison
  function normalizeLanguageForComparison(lang) {
    if (!lang) return '';

    // Convert to lowercase and remove spaces, hyphens, dots
    return lang.toLowerCase().replace(/[\s\-\.]/g, '');
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
      'python3': ['python', 'python3', 'py3', 'py'],
      'javascript': ['js', 'javascript'],
      'typescript': ['ts', 'typescript'],
      'cpp': ['c++', 'cpp', 'cplusplus'],
      'csharp': ['c#', 'csharp', 'cs'],
      'fsharp': ['f#', 'fsharp', 'fs'],
      'vbnet': ['vb', 'vbnet', 'vb.net', 'visualbasic'],
      'objectivec': ['objc', 'objectivec', 'objective-c'],
      'rust': ['rust', 'rs'],
      'kotlin': ['kotlin', 'kt'],
      'swift': ['swift']
    };

    for (const [key, values] of Object.entries(variations)) {
      if ((values.includes(normalized1) && values.includes(normalized2)) ||
        (key === normalized1 && values.includes(normalized2)) ||
        (key === normalized2 && values.includes(normalized1))) {
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
        window.removeEventListener('__cgLanguageDetected', listener);
        resolve(event.detail.language);
      };

      window.addEventListener('__cgLanguageDetected', listener);

      // Request language detection from page script
      const event = new CustomEvent('__cgDetectLanguage');
      window.dispatchEvent(event);
    });
  }

  init();

  function init() {
    console.log('[CodinGame Content Script] Initializing...');

    // Retry editor detection with longer intervals to wait for Angular
    const attemptEditorDetection = (attempt = 1, maxAttempts = 5) => {
      console.log(`[CodinGame Content Script] Detection attempt ${attempt}/${maxAttempts}...`);

      // Use longer timeout for Angular to initialize (up to 20 seconds)
      waitForEditor(20000)
        .then((ctx) => {
          console.log('[CodinGame Content Script] Editor detected:', ctx.strategy);
          editorCache = ctx;
          notifyBackground({ type: 'editor_ready', payload: { strategy: ctx.strategy } });
          showStatus(`Editor ready (${ctx.strategy})`, 'ready');
          console.log('[CodinGame Content Script] Sent editor_ready to background');
        })
        .catch((err) => {
          console.warn(`[CodinGame Content Script] Attempt ${attempt} failed:`, err.message);

          if (attempt < maxAttempts) {
            console.log(`[CodinGame Content Script] Retrying in 5 seconds...`);
            showStatus(`Waiting for editor (attempt ${attempt}/${maxAttempts})...`, 'pending');
            setTimeout(() => attemptEditorDetection(attempt + 1, maxAttempts), 5000);
          } else {
            console.error('[CodinGame Content Script] Editor not found after', maxAttempts, 'attempts');
            showStatus('Editor not found - please reload page', 'error');
          }
        });
    };

    attemptEditorDetection();

    // Intercept fetch/XHR for battle response capture (MV3 compatible)
    interceptBattleRequests();

    const messageListener = (message, _sender, sendResponse) => {
      console.log('[CodinGame Content Script] Message listener called with type:', message?.type);

      if (!message?.type) {
        console.log('[CodinGame Content Script] Message has no type, ignoring');
        return false;
      }

      if (message.type === 'ping_editor') {
        console.log('[CodinGame Content Script] Responding to ping_editor');
        sendResponse({ status: editorCache ? 'ready' : 'pending' });
        return true;
      }

      if (message.type === 'sync_code') {
        console.log('[CodinGame Content Script] ======================================');
        console.log('[CodinGame Content Script] SYNC MESSAGE RECEIVED!');
        console.log('[CodinGame Content Script] ======================================');
        console.log('[CodinGame Content Script] Message:', {
          requestId: message.requestId,
          codeLength: message.payload?.code?.length,
          language: message.payload?.language
        });
        console.log('[CodinGame Content Script] Current editor cache:', editorCache?.strategy || 'none');
        console.log('[CodinGame Content Script] About to call handleSyncRequest...');
        console.log('[CodinGame Content Script] sendResponse available:', typeof sendResponse);

        // Handle async operation properly
        handleSyncRequest(message, sendResponse).then(() => {
          console.log('[CodinGame Content Script] handleSyncRequest completed successfully');
        }).catch((err) => {
          console.error('[CodinGame Content Script] Unhandled error in handleSyncRequest:', err);
          console.error('[CodinGame Content Script] Error stack:', err.stack);
        });
        return true; // keep sendResponse async
      }

      if (message.type === 'capture_battle_response') {
        console.log('[CodinGame Content Script] Responding to capture_battle_response');
        // Background notified us of a battle request, but we're already intercepting
        sendResponse({ ok: true });
        return true;
      }

      console.log('[CodinGame Content Script] Unknown message type:', message.type);
      return false;
    };

    chrome.runtime.onMessage.addListener(messageListener);
    console.log('[CodinGame Content Script] Message listener registered');

    // Store reference for testing
    window.__cgMessageListener = messageListener;
  }



  function interceptBattleRequests() {
    // NOTE: Battle interception moved to page-script.js
    // Content scripts run in an isolated world and cannot intercept
    // fetch/XHR calls made by the page's JavaScript.
    // The page script will intercept requests and send events to this content script.
    console.log('[CodinGame Content Script] Battle interception delegated to page script');
  }

  function isBattleEndpoint(url) {
    if (!url) return false;
    return BATTLE_ENDPOINTS.some(endpoint => url.includes(endpoint));
  }

  // NOTE: This function is no longer called from content script
  // Battle responses are captured in page-script.js and sent via custom events
  // The event listener above (for '__cgBattleResponseCaptured') handles forwarding to background

  async function handleSyncRequest(message, sendResponse) {
    console.log('[CodinGame Content Script] ========================================');
    console.log('[CodinGame Content Script] handleSyncRequest ENTERED');
    console.log('[CodinGame Content Script] ========================================');
    console.log('[CodinGame Content Script] Message object:', message);
    console.log('[CodinGame Content Script] sendResponse type:', typeof sendResponse);
    const { requestId, payload } = message;
    console.log('[CodinGame Content Script] Request ID:', requestId);
    console.log('[CodinGame Content Script] Payload code length:', payload?.code?.length);

    const responseBase = {
      type: 'sync_status',
      requestId,
      timestamp: new Date().toISOString(),
    };

    try {
      console.log('[CodinGame Content Script] Getting editor context...');
      console.log('[CodinGame Content Script] Current cache:', editorCache?.strategy || 'none');

      // IMPORTANT: First try to use page script (Angular method)
      // This is the most reliable method when Angular is available
      console.log('[CodinGame Content Script] Attempting sync via page script (Angular)...');

      // First, detect and validate language
      const detectedLanguage = await detectPageLanguage();
      const requestedLanguage = payload?.language;

      console.log('[CodinGame Content Script] Language check:', {
        detected: detectedLanguage,
        requested: requestedLanguage,
        match: languagesMatch(detectedLanguage, requestedLanguage)
      });

      if (detectedLanguage && requestedLanguage && !languagesMatch(detectedLanguage, requestedLanguage)) {
        console.warn('[CodinGame Content Script] ⚠️ Language mismatch!');
        console.warn('[CodinGame Content Script] CodinGame language:', detectedLanguage);
        console.warn('[CodinGame Content Script] VS Code language:', requestedLanguage);

        showStatus(`Language mismatch: ${requestedLanguage} → ${detectedLanguage}`, 'error');

        const response = {
          ...responseBase,
          status: 'failure',
          reason: `Language mismatch: VS Code has ${requestedLanguage} but CodinGame is using ${detectedLanguage}. Please ensure you're syncing the correct language file.`,
          details: {
            detectedLanguage,
            requestedLanguage
          }
        };

        try {
          sendResponse(response);
        } catch (sendErr) {
          console.error('[CodinGame Content Script] Error calling sendResponse:', sendErr);
        }

        console.log('[CodinGame Content Script] handleSyncRequest aborted due to language mismatch');
        return;
      }

      try {
        const pageScriptResult = await syncViaPageScript(payload?.code ?? '', requestId);
        console.log('[CodinGame Content Script] Page script result:', pageScriptResult);

        if (pageScriptResult.success) {
          console.log('[CodinGame Content Script] ✅ Successfully synced via page script (Angular)!');
          showStatus('Code synced via Angular', 'success');

          const response = {
            ...responseBase,
            status: 'success',
            changed: true,
            strategy: 'angular-ngmodel-page-context',
            language: detectedLanguage || requestedLanguage,
          };
          console.log('[CodinGame Content Script] Sending success response:', response);

          try {
            sendResponse(response);
            console.log('[CodinGame Content Script] ✓ Response sent successfully');
          } catch (sendErr) {
            console.error('[CodinGame Content Script] Error calling sendResponse:', sendErr);
            chrome.runtime.sendMessage(response).catch(() => {
              console.error('[CodinGame Content Script] Fallback message send also failed');
            });
          }

          console.log('[CodinGame Content Script] handleSyncRequest completed successfully');
          return;
        } else {
          console.warn('[CodinGame Content Script] Page script sync failed, falling back to content script method');
          console.warn('[CodinGame Content Script] Error:', pageScriptResult.error);
        }
      } catch (pageScriptError) {
        console.warn('[CodinGame Content Script] Page script sync error, falling back:', pageScriptError.message);
      }

      // Fallback: Use content script method
      console.log('[CodinGame Content Script] Using content script fallback method...');

      // Try to upgrade strategy if we have a fallback
      // Angular might be loaded now even if it wasn't during initial detection
      if (!editorCache || editorCache.strategy === 'monaco-textarea' || editorCache.strategy === 'cg-textarea') {
        console.log('[CodinGame Content Script] Attempting to upgrade editor strategy...');
        const betterCtx = locateEditor();
        if (betterCtx && betterCtx.strategy === 'angular-ngmodel') {
          console.log('[CodinGame Content Script] ✓ Upgraded to angular-ngmodel strategy!');
          editorCache = betterCtx;
        } else {
          console.log('[CodinGame Content Script] No upgrade available, using cached strategy');
        }
      }

      const ctx = editorCache || (await waitForEditor(EDITOR_POLL_TIMEOUT_MS));
      editorCache = ctx;
      console.log('[CodinGame Content Script] Final editor context:', ctx.strategy);

      console.log('[CodinGame Content Script] Applying code...');
      const changed = await applyCode(ctx, payload?.code ?? '');
      console.log('[CodinGame Content Script] Code applied, changed:', changed);

      showStatus(changed ? 'Code injected' : 'Code already up to date', 'success');

      const response = {
        ...responseBase,
        status: 'success',
        changed,
        strategy: ctx.strategy,
      };
      console.log('[CodinGame Content Script] Sending success response:', response);

      // Use try-catch to ensure sendResponse is called even if it throws
      try {
        sendResponse(response);
        console.log('[CodinGame Content Script] ✓ Response sent successfully');
      } catch (sendErr) {
        console.error('[CodinGame Content Script] Error calling sendResponse:', sendErr);
        // Try to notify background directly as fallback
        chrome.runtime.sendMessage(response).catch(() => {
          console.error('[CodinGame Content Script] Fallback message send also failed');
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[CodinGame Content Script] Error during sync:', error);
      showStatus(`Sync failed: ${reason}`, 'error');

      const response = {
        ...responseBase,
        status: 'failure',
        reason,
      };
      console.log('[CodinGame Content Script] Sending failure response:', response);

      // Use try-catch to ensure sendResponse is called even if it throws
      try {
        sendResponse(response);
        console.log('[CodinGame Content Script] ✗ Failure response sent');
      } catch (sendErr) {
        console.error('[CodinGame Content Script] Error calling sendResponse:', sendErr);
        // Try to notify background directly as fallback
        chrome.runtime.sendMessage(response).catch(() => {
          console.error('[CodinGame Content Script] Fallback message send also failed');
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
          reject(new Error('EDITOR_NOT_FOUND'));
          return;
        }

        setTimeout(tick, EDITOR_POLL_INTERVAL_MS);
      };

      tick();
    });
  }

  function locateEditor() {
    // Enhanced diagnostics
    console.log('[CodinGame Content Script] Checking for Monaco editor...');

    // PRIORITY 1: Try Angular ng-model approach (CodinGame uses Angular.js)
    console.log('  Checking for Angular ng-model controller...');
    console.log('    .code-editor element exists:', !!document.querySelector('.code-editor'));
    console.log('    window.angular exists:', !!window.angular);
    console.log('    window.angular type:', typeof window.angular);

    const codeEditorElement = document.querySelector('.code-editor');
    if (codeEditorElement && window.angular) {
      try {
        const ngElement = window.angular.element(codeEditorElement);
        const data = ngElement.data();
        console.log('    Angular element created:', !!ngElement);
        console.log('    Angular data:', data ? 'exists' : 'null');
        console.log('    Angular data keys:', data ? Object.keys(data) : 'null');
        const ngModel = data?.$ngModelController;
        console.log('    $ngModelController exists:', !!ngModel);
        console.log('    $ngModelController type:', typeof ngModel);

        if (ngModel && typeof ngModel.$setViewValue === 'function') {
          console.log('[CodinGame Content Script] ✓ Found Angular ng-model controller');
          console.log('[CodinGame Content Script] ng-model has $modelValue:', !!ngModel.$modelValue);
          return {
            strategy: 'angular-ngmodel',
            ngElement: ngElement,
            ngModel: ngModel,
            element: codeEditorElement,
          };
        } else {
          console.log('    ✗ Angular data not yet initialized (will retry)');
        }
      } catch (err) {
        console.log('[CodinGame Content Script] Angular ng-model detection failed:', err.message);
        console.log('[CodinGame Content Script] Error stack:', err.stack);
      }
    } else if (codeEditorElement && !window.angular) {
      console.log('    ⚠️ .code-editor exists but Angular not loaded yet');
    }

    // PRIORITY 2: Try Monaco API
    console.log('  window.monaco exists:', !!window.monaco);
    console.log('  window.monaco.editor exists:', !!window.monaco?.editor);

    if (window.monaco?.editor) {
      const models = window.monaco.editor.getModels
        ? window.monaco.editor.getModels()
        : [];
      console.log('  Monaco models found:', models.length);
      if (models.length > 0) {
        console.log('[CodinGame Content Script] ✓ Found Monaco model');
        return {
          strategy: 'monaco-model',
          model: models[0],
        };
      }
    }

    // PRIORITY 3: Try Monaco editor instance from DOM
    const monacoTextArea = document.querySelector('.monaco-editor textarea');
    console.log('  .monaco-editor textarea exists:', !!monacoTextArea);
    if (monacoTextArea) {
      // Try to find Monaco editor instance from the DOM element
      const editorInstance = findMonacoEditorFromDOM(monacoTextArea);
      if (editorInstance) {
        console.log('[CodinGame Content Script] ✓ Found Monaco editor instance from DOM');
        return {
          strategy: 'monaco-instance',
          editor: editorInstance,
          element: monacoTextArea,
        };
      }

      console.log('[CodinGame Content Script] ✓ Found Monaco textarea (fallback)');
      return {
        strategy: 'monaco-textarea',
        element: monacoTextArea,
      };
    }

    // PRIORITY 4: Fallback to basic textarea
    const cgTextarea =
      document.querySelector('.cg-code-editor textarea') ||
      document.querySelector('textarea#code');
    console.log('  .cg-code-editor textarea or textarea#code exists:', !!cgTextarea);
    if (cgTextarea) {
      console.log('[CodinGame Content Script] ✓ Found CG textarea');
      return {
        strategy: 'cg-textarea',
        element: cgTextarea,
      };
    }

    console.log('[CodinGame Content Script] ✗ No editor found in this check');
    return null;
  }

  function findMonacoEditorFromDOM(textarea) {
    try {
      // First, try to find via React Fiber (CodinGame uses React)
      const editorFromFiber = findEditorViaReactFiber(textarea);
      if (editorFromFiber) {
        console.log('[CodinGame Content Script] Found editor via React Fiber');
        return editorFromFiber;
      }
    } catch (err) {
      console.warn('[CodinGame Content Script] React Fiber search failed:', err);
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
        const possibleKeys = Object.keys(element).filter(key =>
          key.includes('monaco') ||
          key.includes('editor') ||
          key.includes('__') ||
          key.startsWith('_')
        );

        for (const key of possibleKeys) {
          const value = element[key];
          if (value && typeof value === 'object') {
            // Check if this looks like a Monaco editor instance
            if (typeof value.getValue === 'function' && typeof value.setValue === 'function') {
              console.log('[CodinGame Content Script] Found editor instance via property:', key);
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
      const monacoContainers = document.querySelectorAll('.monaco-editor');
      for (const container of monacoContainers) {
        const keys = Object.keys(container);
        for (const key of keys) {
          const value = container[key];
          if (value && typeof value === 'object' &&
            typeof value.getValue === 'function' &&
            typeof value.setValue === 'function') {
            console.log('[CodinGame Content Script] Found editor via container search');
            return value;
          }
        }
      }

      return null;
    } catch (err) {
      console.warn('[CodinGame Content Script] Error finding Monaco editor:', err);
      return null;
    }
  }

  function findEditorViaReactFiber(element) {
    try {
      // React attaches fiber nodes to DOM elements
      const fiberKey = Object.keys(element).find(key =>
        key.startsWith('__reactInternalInstance') ||
        key.startsWith('__reactFiber')
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
          if (props.editor && typeof props.editor.getValue === 'function') {
            return props.editor;
          }
          if (props.monacoEditor && typeof props.monacoEditor.getValue === 'function') {
            return props.monacoEditor;
          }
        }

        // Check stateNode (component instance)
        if (fiber.stateNode) {
          const instance = fiber.stateNode;
          if (typeof instance === 'object') {
            // Check common property names
            if (instance.editor && typeof instance.editor.getValue === 'function') {
              return instance.editor;
            }
            if (instance._editor && typeof instance._editor.getValue === 'function') {
              return instance._editor;
            }
            if (instance.monacoEditor && typeof instance.monacoEditor.getValue === 'function') {
              return instance.monacoEditor;
            }
          }
        }

        // Move to parent fiber
        fiber = fiber.return;
      }

      return null;
    } catch (err) {
      console.warn('[CodinGame Content Script] React fiber search error:', err);
      return null;
    }
  }

  async function applyCode(ctx, code) {
    console.log('[CodinGame Content Script] applyCode called with strategy:', ctx.strategy);
    console.log('[CodinGame Content Script] Code to apply (first 100 chars):', code.substring(0, 100));

    // PRIORITY 1: Angular ng-model strategy (BEST for CodinGame)
    if (ctx.strategy === 'angular-ngmodel' && ctx.ngModel && ctx.ngElement) {
      console.log('[CodinGame Content Script] Using angular-ngmodel strategy');
      try {
        const currentValue = ctx.ngModel.$modelValue;
        console.log('[CodinGame Content Script] Current ng-model value length:', currentValue?.length);

        if (currentValue === code) {
          console.log('[CodinGame Content Script] Code unchanged, skipping');
          return false;
        }

        console.log('[CodinGame Content Script] Setting ng-model value via Angular...');

        // Update the model value using Angular's proper API
        ctx.ngModel.$setViewValue(code);
        ctx.ngModel.$setDirty();

        // Trigger the $render function to update the view
        if (typeof ctx.ngModel.$render === 'function') {
          ctx.ngModel.$render();
          console.log('[CodinGame Content Script] Called $render()');
        }

        // Trigger Angular digest cycle
        const scope = ctx.ngElement.scope();
        if (scope && typeof scope.$apply === 'function') {
          scope.$apply();
          console.log('[CodinGame Content Script] Called scope.$apply()');
        }

        // Verify it was set
        const newValue = ctx.ngModel.$modelValue;
        console.log('[CodinGame Content Script] New ng-model value length:', newValue?.length);
        console.log('[CodinGame Content Script] ✓ Angular ng-model value set successfully');
        return true;
      } catch (err) {
        console.error('[CodinGame Content Script] Error using Angular ng-model:', err);
        console.log('[CodinGame Content Script] Falling back to next strategy...');
        // Fall through to next method
      }
    }

    // PRIORITY 2: Monaco model strategy
    if (ctx.strategy === 'monaco-model' && ctx.model) {
      console.log('[CodinGame Content Script] Using monaco-model strategy');
      if (typeof ctx.model.getValue === 'function' && ctx.model.getValue() === code) {
        console.log('[CodinGame Content Script] Code unchanged, skipping');
        return false;
      }
      console.log('[CodinGame Content Script] Setting model value...');
      ctx.model.setValue(code);
      console.log('[CodinGame Content Script] ✓ Model value set');
      return true;
    }

    // PRIORITY 3: Monaco instance strategy
    if (ctx.strategy === 'monaco-instance' && ctx.editor) {
      console.log('[CodinGame Content Script] Using monaco-instance strategy');
      try {
        const currentValue = ctx.editor.getValue();
        console.log('[CodinGame Content Script] Current editor value length:', currentValue?.length);

        if (currentValue === code) {
          console.log('[CodinGame Content Script] Code unchanged, skipping');
          return false;
        }

        console.log('[CodinGame Content Script] Setting editor value via Monaco API...');
        ctx.editor.setValue(code);

        // Verify it was set
        const newValue = ctx.editor.getValue();
        console.log('[CodinGame Content Script] New editor value length:', newValue?.length);
        console.log('[CodinGame Content Script] ✓ Monaco editor value set successfully');
        return true;
      } catch (err) {
        console.error('[CodinGame Content Script] Error using Monaco instance:', err);
        // Fall through to textarea method
        console.log('[CodinGame Content Script] Falling back to textarea method...');
      }
    }

    // PRIORITY 4: Element/textarea fallback strategy
    if (ctx.element) {
      console.log('[CodinGame Content Script] Using element strategy');
      console.log('[CodinGame Content Script] Element type:', ctx.element.tagName);

      // First, try to select all existing content and replace it
      console.log('[CodinGame Content Script] Focusing element...');
      ctx.element.focus();

      console.log('[CodinGame Content Script] Selecting all content...');
      ctx.element.select();
      ctx.element.setSelectionRange(0, ctx.element.value.length);

      // Method 1: Use document.execCommand (legacy but works with Monaco)
      console.log('[CodinGame Content Script] Attempting execCommand delete...');
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      console.log('[CodinGame Content Script] Attempting execCommand insertText...');
      const inserted = document.execCommand('insertText', false, code);
      console.log('[CodinGame Content Script] execCommand insertText result:', inserted);

      if (!inserted) {
        // Method 2: Fallback to direct value setting + enhanced events
        console.log('[CodinGame Content Script] execCommand failed, using fallback method...');
        ctx.element.value = code;

        // Dispatch comprehensive input events
        console.log('[CodinGame Content Script] Dispatching comprehensive events...');

        // Input event with InputEvent constructor
        ctx.element.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: code
        }));

        // Change event
        ctx.element.dispatchEvent(new Event('change', { bubbles: true }));

        // Keyboard events to simulate typing
        ctx.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', ctrlKey: true }));
        ctx.element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a', ctrlKey: true }));

        // Blur and focus to force Monaco sync
        ctx.element.blur();
        setTimeout(() => ctx.element.focus(), 10);
      }

      console.log('[CodinGame Content Script] ✓ Element value set and events dispatched');
      console.log('[CodinGame Content Script] Final textarea value length:', ctx.element.value.length);

      return true;
    }

    console.error('[CodinGame Content Script] No valid editor context found!');
    throw new Error('EDITOR_WRITE_FAILED');
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
      overlayEl = document.createElement('div');
      overlayEl.style.position = 'fixed';
      overlayEl.style.zIndex = '2147483647';
      overlayEl.style.top = '16px';
      overlayEl.style.right = '16px';
      overlayEl.style.padding = '10px 14px';
      overlayEl.style.borderRadius = '8px';
      overlayEl.style.fontFamily =
        "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      overlayEl.style.fontSize = '0.9rem';
      overlayEl.style.boxShadow = '0 6px 18px rgba(15, 23, 42, 0.15)';
      overlayEl.style.transition = 'opacity 200ms ease';
      overlayEl.style.opacity = '0';
      document.body.appendChild(overlayEl);
    }

    const colors = {
      success: { bg: '#16a34a', fg: '#fff' },
      error: { bg: '#dc2626', fg: '#fff' },
      ready: { bg: '#0ea5e9', fg: '#fff' },
      pending: { bg: '#a855f7', fg: '#fff' },
    };

    const palette = colors[status] || colors.ready;
    overlayEl.style.background = palette.bg;
    overlayEl.style.color = palette.fg;
    overlayEl.textContent = text;
    overlayEl.style.opacity = '1';

    if (overlayTimer) {
      clearTimeout(overlayTimer);
    }

    overlayTimer = setTimeout(() => {
      if (overlayEl) {
        overlayEl.style.opacity = '0';
      }
    }, STATUS_FADE_TIMEOUT_MS);
  }

  // ========================================
  // Automatic Arena Battle Capture
  // ========================================

  let batchCaptureButton = null;
  let batchCaptureInProgress = false;
  let capturedBattleIds = new Set(); // Track already captured battles
  let continuousMonitoring = false;
  let monitoringInterval = null;

  function createBatchCaptureButton() {
    if (batchCaptureButton) return;

    batchCaptureButton = document.createElement('button');
    batchCaptureButton.textContent = '📊 Capture All Battles';
    batchCaptureButton.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      z-index: 10000;
      padding: 12px 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
      transition: all 0.3s ease;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    batchCaptureButton.onmouseenter = () => {
      if (!batchCaptureInProgress) {
        batchCaptureButton.style.transform = 'translateY(-2px)';
        batchCaptureButton.style.boxShadow = '0 6px 16px rgba(102, 126, 234, 0.5)';
      }
    };

    batchCaptureButton.onmouseleave = () => {
      batchCaptureButton.style.transform = 'translateY(0)';
      batchCaptureButton.style.boxShadow = '0 4px 12px rgba(102, 126, 234, 0.4)';
    };

    batchCaptureButton.onclick = async () => {
      if (batchCaptureInProgress) {
        // If monitoring is active, clicking stops it
        if (continuousMonitoring) {
          stopContinuousMonitoring();
        }
        return;
      }
      await captureBattlesAutomatically();
    };

    document.body.appendChild(batchCaptureButton);
    console.log('[CodinGame Content Script] Batch capture button created');
  }

  function updateBatchCaptureButton(text, inProgress = false) {
    if (!batchCaptureButton) return;

    batchCaptureInProgress = inProgress;
    batchCaptureButton.textContent = text;

    if (inProgress) {
      batchCaptureButton.style.cursor = 'not-allowed';
      batchCaptureButton.style.opacity = '0.7';
      batchCaptureButton.style.background = 'linear-gradient(135deg, #94a3b8 0%, #64748b 100%)';
    } else {
      batchCaptureButton.style.cursor = 'pointer';
      batchCaptureButton.style.opacity = '1';
      batchCaptureButton.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    }
  }

  async function captureBattlesAutomatically(startMonitoring = true) {
    console.log('[CodinGame Content Script] Starting automatic battle capture...');
    updateBatchCaptureButton('⏳ Fetching battles...', true);

    try {
      // Get current user ID (test session handle is optional)
      const { userId, testSessionHandle } = await getSessionInfo();

      if (!userId) {
        throw new Error('Could not find user ID. Please make sure you are logged in to CodinGame.');
      }

      console.log('[CodinGame Content Script] Session info:', { userId, testSessionHandle });

      // Fetch list of last battles
      showStatus('Fetching battle list...', 'pending');

      let battles = null;

      // ALWAYS try DOM extraction first since battles are already listed on the page
      // testSessionHandle is only needed for API-based fetching, but DOM is more reliable
      console.log('[CodinGame Content Script] Extracting battles from DOM...');
      battles = await extractBattlesFromDOM();

      // Only try API if DOM extraction fails AND we have a testSessionHandle
      if ((!battles || battles.length === 0) && testSessionHandle) {
        console.log('[CodinGame Content Script] DOM extraction failed, trying API with testSessionHandle...');
        try {
          battles = await fetchLastBattles(testSessionHandle);
        } catch (error) {
          console.warn('[CodinGame Content Script] API fetch also failed:', error.message);
        }
      }

      if (!battles || battles.length === 0) {
        let message = 'No battles found. ';

        if (testSessionHandle) {
          message += 'Try running your code to generate battles.';
        } else {
          message += 'Run your code in the IDE first to generate battles, or navigate to the arena leaderboard page.';
        }

        showStatus(message, 'error');
        updateBatchCaptureButton('📊 Capture All Battles', false);
        console.log('[CodinGame Content Script] 💡 Tip: To capture battles, either:');
        console.log('[CodinGame Content Script]    1. Click "LAST BATTLES" button on the page to show battle history');
        console.log('[CodinGame Content Script]    2. Click "Play" or "Submit" in the IDE to run your code');
        console.log('[CodinGame Content Script]    3. Navigate to the arena leaderboard page with battle history');
        return;
      }

      // Filter out battles that have already been captured
      const newBattles = battles.filter(b => !capturedBattleIds.has(b.gameId));

      if (newBattles.length === 0) {
        console.log(`[CodinGame Content Script] All ${battles.length} battles already captured`);
        showStatus(`All battles already captured (${capturedBattleIds.size} total)`, 'success');
        updateBatchCaptureButton(continuousMonitoring ? '🔄 Monitoring...' : '📊 Capture All Battles', false);
        return;
      }

      console.log(`[CodinGame Content Script] Found ${battles.length} battles (${newBattles.length} new)`);
      showStatus(`Found ${newBattles.length} new battles. Starting capture...`, 'success');

      // Capture each new battle
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < newBattles.length; i++) {
        const battle = newBattles[i];
        const progress = `${i + 1}/${newBattles.length}`;
        updateBatchCaptureButton(`⏳ ${progress}`, true);
        showStatus(`Capturing battle ${progress}...`, 'pending');

        try {
          await fetchAndProcessBattle(battle.gameId, userId);
          capturedBattleIds.add(battle.gameId); // Mark as captured
          successCount++;
          console.log(`[CodinGame Content Script] ✓ Captured battle ${battle.gameId} (${progress})`);

          // Small delay to avoid overwhelming the server and allow UI updates
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          console.error(`[CodinGame Content Script] ✗ Failed to capture battle ${battle.gameId}:`, error);
          failCount++;

          // Continue with other battles even if one fails
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      const message = `✓ Captured ${successCount}/${newBattles.length} new battles (${capturedBattleIds.size} total)` + (failCount > 0 ? ` (${failCount} failed)` : '');
      showStatus(message, successCount > 0 ? 'success' : 'error');

      if (startMonitoring && !continuousMonitoring) {
        startContinuousMonitoring();
      } else {
        updateBatchCaptureButton(continuousMonitoring ? '🔄 Monitoring...' : '📊 Capture All Battles', false);
      }

      console.log(`[CodinGame Content Script] Batch capture complete: ${successCount} success, ${failCount} failed, ${capturedBattleIds.size} total captured`);

    } catch (error) {
      console.error('[CodinGame Content Script] Batch capture error:', error);
      const errorMsg = error.message || 'Unknown error occurred';
      showStatus(`Error: ${errorMsg}`, 'error');
      updateBatchCaptureButton(continuousMonitoring ? '🔄 Monitoring...' : '📊 Capture All Battles', false);
    }
  }

  function startContinuousMonitoring() {
    if (continuousMonitoring) {
      console.log('[CodinGame Content Script] Monitoring already active');
      return;
    }

    console.log('[CodinGame Content Script] Starting continuous battle monitoring...');
    continuousMonitoring = true;
    updateBatchCaptureButton('🔄 Monitoring...', false);
    showStatus('Monitoring for new battles...', 'ready');

    // Check for new battles every 10 seconds
    monitoringInterval = setInterval(async () => {
      if (!batchCaptureInProgress) {
        console.log('[CodinGame Content Script] Checking for new battles...');
        await captureBattlesAutomatically(false);
      }
    }, 10000);
  }

  function stopContinuousMonitoring() {
    if (!continuousMonitoring) return;

    console.log('[CodinGame Content Script] Stopping continuous battle monitoring...');
    continuousMonitoring = false;

    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }

    updateBatchCaptureButton('📊 Capture All Battles', false);
    showStatus('Monitoring stopped', 'ready');
  }

  async function getSessionInfo() {
    // Try to extract from page context
    try {
      // Check if there's a test session handle in the URL or page
      const urlMatch = window.location.href.match(/\/ide\/(puzzle|challenge)\/([^\/]+)/);

      // Try to get from localStorage or cookies
      const userId = await getUserIdFromPage();
      const testSessionHandle = await getTestSessionHandleFromPage();

      return { userId, testSessionHandle };
    } catch (error) {
      console.error('[CodinGame Content Script] Error getting session info:', error);
      return {};
    }
  }

  async function getUserIdFromPage() {
    // Try multiple methods to get user ID
    try {
      // Method 1: Check if it's in the global scope via page script
      console.log('[CodinGame Content Script] Requesting userId from page script...');
      const result = await new Promise((resolve) => {
        let timeoutId;
        const handler = (event) => {
          console.log('[CodinGame Content Script] Received message:', event.data);
          if (event.data.type === '__cgUserIdResponse') {
            console.log('[CodinGame Content Script] Got userId response:', event.data.userId);
            window.removeEventListener('message', handler);
            clearTimeout(timeoutId);
            resolve(event.data.userId);
          }
        };
        window.addEventListener('message', handler);
        window.postMessage({ type: '__cgGetUserId' }, '*');
        timeoutId = setTimeout(() => {
          console.log('[CodinGame Content Script] Timeout waiting for userId response');
          window.removeEventListener('message', handler);
          resolve(null);
        }, 3000);
      });

      if (result) {
        console.log('[CodinGame Content Script] Successfully got userId from page script:', result);
        return result;
      }
      console.log('[CodinGame Content Script] No userId from page script, trying other methods...');

      // Method 2: Try to extract from any existing API response
      // This will be populated by battle responses
      const existingUserId = window.__cgUserId;
      if (existingUserId) return existingUserId;

      // Method 3: Make a simple API call to get user info
      const response = await fetch('https://www.codingame.com/services/CodinGamer/getCurrentCodinGamer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([])
      });

      if (!response.ok) {
        console.warn('[CodinGame Content Script] API returned error:', response.status, response.statusText);
        return null;
      }

      // Get response as text first to check content type
      const responseText = await response.text();

      // Try to parse as JSON
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error('[CodinGame Content Script] Failed to parse user info response as JSON:', responseText.substring(0, 200));
        return null;
      }

      if (data && data.userId) {
        window.__cgUserId = data.userId;
        return data.userId;
      }

      return null;
    } catch (error) {
      console.error('[CodinGame Content Script] Error getting user ID:', error);
      return null;
    }
  }

  async function getBattlesFromPageScript() {
    try {
      console.log('[CodinGame Content Script] Requesting battles from page script...');
      console.log('[CodinGame Content Script] Sending __cgGetBattles message...');

      const result = await new Promise((resolve) => {
        let timeoutId;
        const handler = (event) => {
          // Log all messages to debug
          if (event.data && event.data.type && event.data.type.startsWith('__cg')) {
            console.log('[CodinGame Content Script] Received message:', event.data.type, event.data);
          }

          if (event.data && event.data.type === '__cgBattlesResponse') {
            clearTimeout(timeoutId);
            window.removeEventListener('message', handler);
            console.log('[CodinGame Content Script] Got battles response:', event.data.battles);
            resolve(event.data.battles);
          }
        };

        window.addEventListener('message', handler);
        console.log('[CodinGame Content Script] Message listener added, posting __cgGetBattles...');
        window.postMessage({ type: '__cgGetBattles' }, '*');
        console.log('[CodinGame Content Script] __cgGetBattles message posted');

        timeoutId = setTimeout(() => {
          console.log('[CodinGame Content Script] ⚠️ Timeout waiting for battles response (3 seconds elapsed)');
          window.removeEventListener('message', handler);
          resolve(null);
        }, 3000);
      });

      console.log('[CodinGame Content Script] getBattlesFromPageScript promise resolved with:', result);
      return result;
    } catch (error) {
      console.error('[CodinGame Content Script] Error getting battles from page script:', error);
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
          if (event.data.type === '__cgTestSessionHandleResponse') {
            window.removeEventListener('message', handler);
            clearTimeout(timeoutId);
            resolve(event.data.handle);
          }
        };
        window.addEventListener('message', handler);
        window.postMessage({ type: '__cgGetTestSessionHandle' }, '*');
        timeoutId = setTimeout(() => {
          window.removeEventListener('message', handler);
          resolve(null);
        }, 3000);
      });

      return result;
    } catch (error) {
      console.error('[CodinGame Content Script] Error getting test session handle:', error);
      return null;
    }
  }

  async function waitForBattleContent(maxWaitTime = 3000, checkInterval = 200) {
    // Wait for battle content to appear in the DOM
    // This is useful when content loads dynamically (e.g., after clicking "LAST BATTLES")
    console.log('[CodinGame Content Script] Waiting for battle content to load...');

    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      // Check for common battle-related elements
      const hasReplayLinks = document.querySelectorAll('a[href*="/replay/"]').length > 0;
      const hasBattleData = document.querySelectorAll('[data-game-id], [data-battle-id]').length > 0;
      const hasBattleClasses = document.querySelectorAll('.battle-item, .game-item, .report-item').length > 0;

      if (hasReplayLinks || hasBattleData || hasBattleClasses) {
        console.log('[CodinGame Content Script] Battle content detected!');
        // Wait a bit more for all content to render
        await new Promise(resolve => setTimeout(resolve, 500));
        return true;
      }

      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    console.log('[CodinGame Content Script] Timeout waiting for battle content');
    return false;
  }

  async function fetchLastBattles(testSessionHandle) {
    try {
      const response = await fetch('https://www.codingame.com/services/gamesPlayersRanking/findLastBattlesByTestSessionHandle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([testSessionHandle])
      });

      if (!response.ok) {
        const errorText = response.statusText || 'Unknown error';
        throw new Error(`API returned ${response.status}: ${errorText}. The testSessionHandle may be invalid.`);
      }

      // Get response as text first to check content type
      const responseText = await response.text();

      // Try to parse as JSON
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error('[CodinGame Content Script] Failed to parse response as JSON:', responseText.substring(0, 200));
        throw new Error('Server returned invalid JSON response (possibly HTML error page)');
      }

      console.log('[CodinGame Content Script] Last battles response:', data);

      // The response should be an array of battle objects with gameId
      if (!Array.isArray(data)) {
        console.warn('[CodinGame Content Script] Unexpected response format:', data);
        return [];
      }

      // Filter out invalid battles
      const validBattles = data.filter(battle => battle && battle.gameId);
      console.log(`[CodinGame Content Script] Found ${validBattles.length} valid battles`);

      return validBattles;
    } catch (error) {
      console.error('[CodinGame Content Script] Error fetching last battles:', error);
      throw new Error(`Failed to fetch battle list: ${error.message}`);
    }
  }

  async function fetchAndProcessBattle(gameId, userId) {
    try {
      console.log(`[CodinGame Content Script] Fetching battle ${gameId}...`);

      const response = await fetch('https://www.codingame.com/services/gameResult/findByGameId', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([gameId, userId])
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const battleData = await response.text();

      // Validate response
      if (!battleData || battleData.length === 0) {
        throw new Error('Empty response from server');
      }

      // Try to parse to validate it's valid JSON
      try {
        JSON.parse(battleData);
      } catch (e) {
        throw new Error('Invalid JSON response from server');
      }

      console.log(`[CodinGame Content Script] Fetched battle ${gameId}, size: ${battleData.length} bytes`);

      // Send to background script for processing with userId context
      await chrome.runtime.sendMessage({
        type: 'battle_response_captured',
        payload: {
          url: '/services/gameResult/findByGameId',
          body: battleData,
          userId: userId,
          gameId: gameId
        }
      });

      console.log(`[CodinGame Content Script] Battle ${gameId} sent to background script`);
    } catch (error) {
      console.error(`[CodinGame Content Script] Error processing battle ${gameId}:`, error);
      throw new Error(`Battle ${gameId}: ${error.message}`);
    }
  }

  async function extractBattlesFromDOM() {
    // Try to extract battle game IDs from the DOM
    // This is used when testSessionHandle is not available (e.g., on arena leaderboard)
    try {
      console.log('[CodinGame Content Script] Searching for battles in DOM...');

      // PRIORITY 0: Check if we need to open the battles panel first
      const lastBattlesButton = Array.from(document.querySelectorAll('button, a')).find(btn =>
        btn.textContent && (
          btn.textContent.trim().includes('LAST BATTLES') ||
          btn.textContent.trim().includes('Last Battles') ||
          btn.textContent.trim().toUpperCase() === 'LAST BATTLES'
        )
      );

      if (lastBattlesButton) {
        console.log('[CodinGame Content Script] Found LAST BATTLES button, clicking to open panel...');
        lastBattlesButton.click();

        // Wait for the panel to appear and battles to load
        await new Promise(resolve => setTimeout(resolve, 1500));
        console.log('[CodinGame Content Script] Waited for battles panel to load');
      }

      // PRIORITY 1: Try to extract from Angular scope via page script
      console.log('[CodinGame Content Script] Trying to extract battles from Angular scope via page script...');
      try {
        const angularBattles = await getBattlesFromPageScript();
        console.log('[CodinGame Content Script] getBattlesFromPageScript returned:', angularBattles);
        if (angularBattles && angularBattles.length > 0) {
          console.log(`[CodinGame Content Script] ✅ Successfully extracted ${angularBattles.length} battles from Angular scope`);
          return angularBattles;
        }
        console.log('[CodinGame Content Script] No battles found in Angular scope (returned empty or null), falling back to DOM methods...');
      } catch (e) {
        console.warn('[CodinGame Content Script] Error getting battles from page script:', e);
      }

      // First, try to dump all battle-related elements for debugging
      console.log('[CodinGame Content Script] Analyzing DOM structure...');
      const allButtons = document.querySelectorAll('button');
      console.log(`[CodinGame Content Script] Total buttons on page: ${allButtons.length}`);

      // Log sample of elements that might contain battle data
      const sampleElements = document.querySelectorAll('div[class*="battle"], div[class*="game"], tr, li');
      if (sampleElements.length > 0) {
        console.log(`[CodinGame Content Script] Found ${sampleElements.length} potential battle containers`);
        // Log first few for inspection
        for (let i = 0; i < Math.min(5, sampleElements.length); i++) {
          const el = sampleElements[i];
          console.log(`[CodinGame Content Script] Sample element ${i + 1}:`, {
            tag: el.tagName,
            classes: el.className,
            attributes: Array.from(el.attributes).map(a => `${a.name}="${a.value}"`),
            innerHTML: el.innerHTML.substring(0, 200),
            text: el.textContent.substring(0, 100)
          });
        }
      }

      // Wait for dynamic content to load (e.g., after clicking "LAST BATTLES")
      await waitForBattleContent();

      // Look for elements that might contain battle data
      // CodinGame typically has battle links or data attributes
      const selectors = [
        '[data-game-id]',
        'a[href*="/replay/"]',
        'a[href*="/cg/"]',
        'a[href*="/game/"]',
        '.battle-item',
        '.game-item',
        '[data-battle-id]',
        '[data-gameid]',
        '.report-item',
        'div[class*="battle"]',
        'div[class*="game"]',
        'div[class*="report"]',
        'tr[class*="battle"]',
        'tr[class*="game"]',
        'li[class*="battle"]',
        'li[class*="game"]'
      ];

      let battleElements = [];
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log(`[CodinGame Content Script] Found ${elements.length} elements with selector: ${selector}`);
          battleElements = [...battleElements, ...elements];
        }
      }

      // Remove duplicates
      battleElements = [...new Set(battleElements)];

      if (battleElements.length === 0) {
        console.log('[CodinGame Content Script] No battle elements found in DOM');
        console.log('[CodinGame Content Script] Tip: Click "LAST BATTLES" button first, or run your code in the IDE');
        return null;
      }

      console.log(`[CodinGame Content Script] Total unique battle elements found: ${battleElements.length}`);

      const battles = [];
      const seenGameIds = new Set();

      battleElements.forEach((el, index) => {
        let gameId = null;

        // Method 1: Check common data attributes
        gameId = el.getAttribute('data-game-id') ||
          el.getAttribute('data-battle-id') ||
          el.getAttribute('data-id') ||
          el.getAttribute('data-gameid') ||
          el.getAttribute('gameid');

        // Method 2: Check all data-* attributes for numbers
        if (!gameId) {
          const attrs = el.attributes;
          for (let i = 0; i < attrs.length; i++) {
            const attr = attrs[i];
            if (attr.name.startsWith('data-')) {
              const match = attr.value.match(/^\d{8,}$/);
              if (match) {
                gameId = match[0];
                console.log(`[CodinGame Content Script] Found gameId in attribute ${attr.name}: ${gameId}`);
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
          const onclick = el.getAttribute('onclick') || '';
          const onclickMatch = onclick.match(/(\d{7,})/);
          if (onclickMatch) {
            gameId = onclickMatch[1];
            console.log(`[CodinGame Content Script] Found gameId in onclick: ${gameId}`);
          }
        }

        // Method 5: Look for anchor tags with game IDs in children
        if (!gameId) {
          const links = el.querySelectorAll('a[href*="/replay/"], a[href*="/cg/"], a[href*="/game/"]');
          for (const link of links) {
            const href = link.getAttribute('href') || '';
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
          const ngClick = el.getAttribute('ng-click') || el.getAttribute('ng-href');
          if (ngClick) {
            const match = ngClick.match(/(\d{8,})/);
            if (match) {
              gameId = match[1];
            }
          }
        }

        // Method 7: Check innerHTML for hidden game IDs (allow shorter IDs)
        if (!gameId) {
          const html = el.innerHTML;
          const htmlMatch = html.match(/gameId['":\s]+(\d{7,})/i) ||
            html.match(/game-id['":\s]+(\d{7,})/i) ||
            html.match(/battleId['":\s]+(\d{7,})/i) ||
            html.match(/battle-id['":\s]+(\d{7,})/i) ||
            html.match(/"id"['":\s]+(\d{7,})/i);
          if (htmlMatch) {
            gameId = htmlMatch[1];
            console.log(`[CodinGame Content Script] Found gameId in innerHTML: ${gameId}`);
          }
        }

        // Method 8: Look for any data attribute with numeric value
        if (!gameId) {
          const dataAttrs = Array.from(el.attributes).filter(a => a.name.startsWith('data-'));
          for (const attr of dataAttrs) {
            if (/^\d{7,}$/.test(attr.value)) {
              gameId = attr.value;
              console.log(`[CodinGame Content Script] Found gameId in ${attr.name}: ${gameId}`);
              break;
            }
          }
        }

        // Method 9: Check for any long numeric ID in text content
        if (!gameId) {
          const textMatch = el.textContent.match(/\b(\d{9,})\b/);
          if (textMatch) {
            gameId = textMatch[1];
            console.log(`[CodinGame Content Script] Found gameId in text content: ${gameId}`);
          }
        }

        if (gameId && !seenGameIds.has(gameId)) {
          seenGameIds.add(gameId);
          battles.push({ gameId });
          console.log(`[CodinGame Content Script] Found battle ${battles.length}: ${gameId}`);
        }
      });

      if (battles.length > 0) {
        console.log(`[CodinGame Content Script] Extracted ${battles.length} battles from DOM`);
        return battles;
      }



      console.log('[CodinGame Content Script] No battles found in DOM after checking all methods');
      console.log('[CodinGame Content Script] 💡 Tip: Make sure battles are visible on the page');
      console.log('[CodinGame Content Script] 💡 Try expanding/scrolling the battle list if needed');

      // Log some debug info to help diagnose
      console.log('[CodinGame Content Script] Debug info:');
      console.log('  - Battle elements found:', battleElements.length);
      console.log('  - Sample classes:', Array.from(new Set(
        Array.from(document.querySelectorAll('div[class*="battle"], div[class*="game"]'))
          .slice(0, 5)
          .map(el => el.className)
      )));

      return null;
    } catch (error) {
      console.error('[CodinGame Content Script] Error extracting battles from DOM:', error);
      throw error;
    }
  }

  // NOTE: Session info extraction (userId and testSessionHandle) is now handled
  // by page-script.js which has access to window.session and other page globals.
  // Content script just listens for responses.

  // Show button when on CodinGame arena/challenge/leaderboard pages
  function checkAndShowButton() {
    const isArenaPage = window.location.href.includes('/ide/challenge') ||
      window.location.href.includes('/ide/puzzle') ||
      window.location.href.includes('/leaderboard') ||
      window.location.href.includes('/hackathon/');

    if (isArenaPage && !batchCaptureButton) {
      createBatchCaptureButton();
    } else if (!isArenaPage && batchCaptureButton) {
      batchCaptureButton.remove();
      batchCaptureButton = null;
    }
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
      if (!currentUrl.includes('/ide/challenge') &&
        !currentUrl.includes('/ide/puzzle') &&
        !currentUrl.includes('/leaderboard') &&
        !currentUrl.includes('/hackathon/')) {
        stopContinuousMonitoring();
        capturedBattleIds.clear(); // Clear captured battles when leaving the page
      }

      checkAndShowButton();
    }
  }).observe(document.body, { childList: true, subtree: true });

})();
