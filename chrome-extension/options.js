/**
 * CodinGame Chrome Extension - Options Page
 * Handles authentication token configuration
 */

// DOM elements
const wsPortInput = document.getElementById('ws-port');
const authTokenInput = document.getElementById('auth-token');
const saveBtn = document.getElementById('save-btn');
const testBtn = document.getElementById('test-btn');
const clearBtn = document.getElementById('clear-btn');
const statusDiv = document.getElementById('status');

// Load saved settings on page load
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
});

// Save button handler
saveBtn.addEventListener('click', async () => {
  const token = authTokenInput.value.trim();

  if (!token) {
    showStatus('Please enter an authentication token', 'error');
    return;
  }

  // Validate token format (should be 64 hex characters)
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    showStatus('Invalid token format. Token should be 64 hexadecimal characters.', 'error');
    return;
  }

  try {
    await chrome.storage.local.set({
      cg_auth_token: token,
      cg_bridge_port: parseInt(wsPortInput.value) || 45123
    });

    showStatus('✓ Settings saved successfully! Please reload the extension or restart Chrome.', 'success');

    // Notify background script to reload
    try {
      await chrome.runtime.sendMessage({ type: 'reload_config' });
    } catch (err) {
      // Background might not be listening yet
      console.log('Background script reload notification failed (will reload on restart)');
    }

  } catch (error) {
    showStatus(`Failed to save settings: ${error.message}`, 'error');
  }
});

// Test connection button handler
testBtn.addEventListener('click', async () => {
  const token = authTokenInput.value.trim();

  if (!token) {
    showStatus('Please enter and save a token first', 'error');
    return;
  }

  showStatus('Testing connection...', 'success');

  try {
    // Try to connect to WebSocket
    const port = parseInt(wsPortInput.value) || 45123;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    const timeout = setTimeout(() => {
      ws.close();
      showStatus('Connection timeout. Make sure VS Code extension is running.', 'error');
    }, 5000);

    ws.onopen = () => {
      clearTimeout(timeout);

      // Send auth message
      const authMessage = {
        type: 'auth',
        requestId: `test_${Date.now()}`,
        payload: {
          token: token,
          version: chrome.runtime.getManifest().version,
          clientType: 'chrome-extension',
          timestamp: new Date().toISOString()
        },
        version: '1.0.0'
      };

      ws.send(JSON.stringify(authMessage));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'auth_ack') {
          if (message.payload?.status === 'success') {
            showStatus('✓ Connection successful! Authentication verified.', 'success');
          } else {
            showStatus(`Authentication failed: ${message.payload?.reason || 'Invalid token'}`, 'error');
          }
          ws.close();
        }
      } catch (err) {
        console.error('Failed to parse message:', err);
      }
    };

    ws.onerror = (error) => {
      clearTimeout(timeout);
      showStatus('Connection failed. Make sure VS Code extension is running.', 'error');
    };

    ws.onclose = () => {
      clearTimeout(timeout);
    };

  } catch (error) {
    showStatus(`Test failed: ${error.message}`, 'error');
  }
});

// Clear button handler
clearBtn.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to clear the authentication token?')) {
    return;
  }

  try {
    await chrome.storage.local.remove(['cg_auth_token']);
    authTokenInput.value = '';
    showStatus('Token cleared successfully', 'success');

    // Notify background script
    try {
      await chrome.runtime.sendMessage({ type: 'reload_config' });
    } catch (err) {
      // Background might not be listening yet
      console.log('Background script reload notification failed');
    }

  } catch (error) {
    showStatus(`Failed to clear token: ${error.message}`, 'error');
  }
});

// Load settings from storage
async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(['cg_auth_token', 'cg_bridge_port']);

    if (result.cg_auth_token) {
      authTokenInput.value = result.cg_auth_token;
      showStatus('Settings loaded from storage', 'success');
    }

    if (result.cg_bridge_port) {
      wsPortInput.value = result.cg_bridge_port;
    }

  } catch (error) {
    showStatus(`Failed to load settings: ${error.message}`, 'error');
  }
}

// Show status message
function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  statusDiv.style.display = 'block';

  // Auto-hide success messages after 5 seconds
  if (type === 'success') {
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 5000);
  }
}

// Handle token input formatting
authTokenInput.addEventListener('input', (e) => {
  // Remove any non-hex characters
  let value = e.target.value.toLowerCase().replace(/[^a-f0-9]/g, '');

  // Limit to 64 characters
  if (value.length > 64) {
    value = value.substring(0, 64);
  }

  e.target.value = value;
});

// Handle paste event
authTokenInput.addEventListener('paste', (e) => {
  e.preventDefault();

  const pastedText = (e.clipboardData || window.clipboardData).getData('text');
  const cleanedText = pastedText.toLowerCase().replace(/[^a-f0-9]/g, '').substring(0, 64);

  authTokenInput.value = cleanedText;

  // Auto-save if valid token is pasted
  if (/^[a-f0-9]{64}$/i.test(cleanedText)) {
    saveBtn.click();
  }
});
