/**
 * CodinGame Chrome Extension - Popup UI Script
 * Task 1.5: Popup Status Rendering
 *
 * Responsibilities:
 * - Display real-time connection status, sync state, and retry queue metrics
 * - Provide manual controls for reconnection, resend, and log management
 * - Render activity logs with level-based styling
 * - Auto-refresh status every 2 seconds
 */

// DOM Elements
const connectionIndicator = document.getElementById('connection-indicator');
const connectionStatus = document.getElementById('connection-status');
const connectionDetail = document.getElementById('connection-detail');
const heartbeatValue = document.getElementById('heartbeat-value');
const syncValue = document.getElementById('sync-value');
const pendingCount = document.getElementById('pending-count');
const tabsCount = document.getElementById('tabs-count');
const reconnectBtn = document.getElementById('reconnect-btn');
const reconnectText = document.getElementById('reconnect-text');
const resendBtn = document.getElementById('resend-btn');
const resendCount = document.getElementById('resend-count');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const logsContainer = document.getElementById('logs-container');
const toast = document.getElementById('toast');

// Setup wizard elements
const setupWizard = document.getElementById('setup-wizard');
const setupTokenInput = document.getElementById('setup-token-input');
const setupSaveBtn = document.getElementById('setup-save-btn');
const setupOptionsBtn = document.getElementById('setup-options-btn');
const statusCard = document.getElementById('status-card');
const statsCard = document.getElementById('stats-card');
const mainTabs = document.getElementById('main-tabs');
const openOptionsBtn = document.getElementById('open-options-btn');

// Tab switching
const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const targetTab = tab.dataset.tab;

    tabs.forEach((t) => t.classList.remove('active'));
    tabContents.forEach((tc) => tc.classList.remove('active'));

    tab.classList.add('active');
    document.getElementById(`${targetTab}-tab`).classList.add('active');

    if (targetTab === 'logs') {
      refreshStatus();
    }
  });
});

// State
let refreshInterval = null;
let currentStatus = null;

/**
 * Initialize popup
 */
function init() {
  refreshStatus();
  startAutoRefresh();
  attachEventListeners();
}

/**
 * Attach button event listeners
 */
function attachEventListeners() {
  reconnectBtn.addEventListener('click', handleReconnect);
  resendBtn.addEventListener('click', handleResend);
  clearLogsBtn.addEventListener('click', handleClearLogs);
  setupSaveBtn.addEventListener('click', handleSetupSave);
  setupOptionsBtn.addEventListener('click', handleOpenOptions);
  openOptionsBtn.addEventListener('click', handleOpenOptions);
}

/**
 * Start auto-refresh interval
 */
function startAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  refreshInterval = setInterval(refreshStatus, 2000);
}

/**
 * Request status from background worker
 */
async function refreshStatus() {
  try {
    // Check if token is configured
    const { authToken } = await chrome.storage.local.get('authToken');

    if (!authToken || authToken.trim() === '') {
      showSetupWizard();
      return;
    }

    const status = await chrome.runtime.sendMessage({ type: 'popup_status_request' });
    currentStatus = status;
    renderStatus(status);
    hideSetupWizard();
  } catch (error) {
    console.error('[popup] failed to fetch status', error);
    renderError();
  }
}

/**
 * Show setup wizard and hide main UI
 */
function showSetupWizard() {
  setupWizard.style.display = 'block';
  statusCard.style.display = 'none';
  statsCard.style.display = 'none';
  mainTabs.style.display = 'none';
  document.getElementById('actions-tab').style.display = 'none';
  document.getElementById('logs-tab').style.display = 'none';
}

/**
 * Hide setup wizard and show main UI
 */
function hideSetupWizard() {
  setupWizard.style.display = 'none';
  statusCard.style.display = 'block';
  statsCard.style.display = 'block';
  mainTabs.style.display = 'flex';

  // Show active tab content
  const activeTab = document.querySelector('.tab.active');
  if (activeTab) {
    const targetTab = activeTab.dataset.tab;
    document.getElementById(`${targetTab}-tab`).style.display = 'block';
  }
}

/**
 * Render connection status
 */
function renderStatus(status) {
  if (!status) {
    renderError();
    return;
  }

  // Connection indicator
  connectionIndicator.className = 'indicator';
  if (status.connected) {
    connectionIndicator.classList.add('online');
    connectionStatus.textContent = 'Connected';
    connectionDetail.textContent = 'Bridge is healthy';
  } else if (status.retrying) {
    connectionIndicator.classList.add('retrying');
    connectionStatus.textContent = 'Retrying';
    connectionDetail.textContent = `Next attempt in ${Math.ceil(status.retryDelay / 1000)}s`;
  } else {
    connectionIndicator.classList.add('offline');
    connectionStatus.textContent = 'Disconnected';
    connectionDetail.textContent = status.lastError?.message || 'Bridge unavailable';
  }

  // Heartbeat
  if (status.lastHeartbeatAck && status.lastHeartbeatAck > 0) {
    const elapsed = Date.now() - status.lastHeartbeatAck;
    if (elapsed < 60000) {
      heartbeatValue.textContent = `${Math.floor(elapsed / 1000)}s ago`;
    } else {
      heartbeatValue.textContent = formatTimestamp(status.lastHeartbeatAck);
    }
  } else {
    heartbeatValue.textContent = '—';
  }

  // Last sync
  if (status.lastSync) {
    const syncTime = new Date(status.lastSync).getTime();
    const elapsed = Date.now() - syncTime;
    if (elapsed < 60000) {
      syncValue.textContent = `${Math.floor(elapsed / 1000)}s ago`;
    } else {
      syncValue.textContent = formatTimestamp(status.lastSync);
    }
  } else {
    syncValue.textContent = '—';
  }

  // Statistics
  pendingCount.textContent = status.pendingDeliveries || 0;
  tabsCount.textContent = status.ideTabs?.length || 0;

  // Resend button
  const hasPending = status.pendingDeliveries > 0;
  resendBtn.disabled = !hasPending;
  resendCount.textContent = status.pendingDeliveries || 0;

  // Reconnect button
  if (status.retrying) {
    reconnectBtn.disabled = true;
    reconnectText.innerHTML = '<span class="loading"></span> Connecting...';
  } else {
    reconnectBtn.disabled = false;
    reconnectText.textContent = status.connected ? 'Reconnect Bridge' : 'Connect Bridge';
  }

  // Render logs if on logs tab
  const logsTab = document.getElementById('logs-tab');
  if (logsTab.classList.contains('active')) {
    renderLogs(status.logs || []);
  }
}

/**
 * Render error state
 */
function renderError() {
  connectionIndicator.className = 'indicator offline';
  connectionStatus.textContent = 'Error';
  connectionDetail.textContent = 'Cannot communicate with background';
  heartbeatValue.textContent = '—';
  syncValue.textContent = '—';
  pendingCount.textContent = '?';
  tabsCount.textContent = '?';
  resendBtn.disabled = true;
  reconnectBtn.disabled = true;
}

/**
 * Render logs
 */
function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    logsContainer.innerHTML = '<div class="empty-state">No logs available</div>';
    return;
  }

  const reversed = [...logs].reverse();
  const html = reversed
    .map((entry) => {
      const time = formatTime(entry.timestamp);
      const level = entry.level || 'info';
      return `
        <div class="log-entry ${level}">
          <span class="log-time">${time}</span>
          <span class="log-message">${escapeHtml(entry.message)}</span>
        </div>
      `;
    })
    .join('');

  logsContainer.innerHTML = html;

  // Scroll to top (newest)
  logsContainer.scrollTop = 0;
}

/**
 * Handle reconnect button
 */
async function handleReconnect() {
  try {
    reconnectBtn.disabled = true;
    reconnectText.innerHTML = '<span class="loading"></span> Connecting...';

    await chrome.runtime.sendMessage({ type: 'bridge_connect' });
    showToast('Reconnection initiated');

    setTimeout(() => {
      refreshStatus();
    }, 500);
  } catch (error) {
    console.error('[popup] reconnect failed', error);
    showToast('Reconnect failed: ' + error.message, 'error');
    reconnectBtn.disabled = false;
    reconnectText.textContent = 'Connect Bridge';
  }
}

/**
 * Handle resend button
 */
async function handleResend() {
  try {
    resendBtn.disabled = true;
    const originalText = resendBtn.innerHTML;
    resendBtn.innerHTML = '<span class="loading"></span> Resending...';

    const response = await chrome.runtime.sendMessage({ type: 'retry_queue_resend_all' });

    if (response?.ok) {
      showToast(`Resent ${response.count || 0} payload(s)`);
    } else {
      showToast('Resend completed', 'info');
    }

    setTimeout(() => {
      refreshStatus();
    }, 500);
  } catch (error) {
    console.error('[popup] resend failed', error);
    showToast('Resend failed: ' + error.message, 'error');
  } finally {
    setTimeout(() => {
      resendBtn.disabled = currentStatus?.pendingDeliveries === 0;
    }, 1000);
  }
}

/**
 * Handle clear logs button
 */
async function handleClearLogs() {
  try {
    clearLogsBtn.disabled = true;
    const originalText = clearLogsBtn.textContent;
    clearLogsBtn.textContent = 'Clearing...';

    await chrome.runtime.sendMessage({ type: 'popup_clear_logs' });

    showToast('Logs cleared');

    setTimeout(() => {
      refreshStatus();
    }, 300);
  } catch (error) {
    console.error('[popup] clear logs failed', error);
    showToast('Failed to clear logs', 'error');
  } finally {
    setTimeout(() => {
      clearLogsBtn.disabled = false;
      clearLogsBtn.textContent = 'Clear Logs';
    }, 500);
  }
}

/**
 * Handle setup save button
 */
async function handleSetupSave() {
  try {
    const token = setupTokenInput.value.trim();

    if (!token) {
      showToast('Please enter a token', 'error');
      setupTokenInput.focus();
      return;
    }

    if (token.length !== 64 || !/^[a-f0-9]{64}$/i.test(token)) {
      showToast('Invalid token format (expected 64 hex characters)', 'error');
      setupTokenInput.focus();
      return;
    }

    setupSaveBtn.disabled = true;
    setupSaveBtn.textContent = 'Saving...';

    // Save token
    await chrome.storage.local.set({ authToken: token });

    showToast('Token saved! Connecting...');

    // Trigger reconnection
    await chrome.runtime.sendMessage({ type: 'bridge_connect' });

    // Clear input
    setupTokenInput.value = '';

    // Refresh status after a short delay
    setTimeout(() => {
      refreshStatus();
    }, 1000);

  } catch (error) {
    console.error('[popup] setup save failed', error);
    showToast('Failed to save token: ' + error.message, 'error');
  } finally {
    setupSaveBtn.disabled = false;
    setupSaveBtn.textContent = 'Save Token & Connect';
  }
}

/**
 * Handle open options button
 */
function handleOpenOptions() {
  chrome.runtime.openOptionsPage();
}

/**
 * Show toast notification
 */
function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = 'toast show';

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

/**
 * Format timestamp to HH:MM:SS
 */
function formatTimestamp(timestamp) {
  if (!timestamp) return '—';

  try {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  } catch {
    return '—';
  }
}

/**
 * Format time for logs (HH:MM:SS)
 */
function formatTime(timestamp) {
  if (!timestamp) return '??:??:??';

  try {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  } catch {
    return '??:??:??';
  }
}

/**
 * Escape HTML to prevent injection
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Cleanup on unload
 */
window.addEventListener('beforeunload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
