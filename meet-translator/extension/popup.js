/**
 * popup.js  –  Popup Script
 *
 * Manages the Start / Stop button and communicates with the background
 * service worker to control the capture / translation lifecycle.
 */

'use strict';

const toggleBtn    = document.getElementById('toggle-btn');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const errorMsg     = document.getElementById('error-msg');
const serverInfo   = document.getElementById('server-info');
const serverUnavailable = document.getElementById('server-unavailable');
const overlayEnabledToggle = document.getElementById('overlay-enabled-toggle');
const migrationNotice = document.getElementById('migration-notice');
const openCaptionShareButton = document.getElementById('open-caption-share');
const openCorrectionPanelButton = document.getElementById('open-correction-panel');

let isActive = false;
// Initialised to English; overwritten after settings load.
let msgs = getMessages('');

function openExtensionPage(fileName) {
  const url = chrome.runtime.getURL(fileName);
  chrome.tabs.query({ url }, (tabs) => {
    const existing = tabs?.[0];
    if (existing?.id != null) {
      chrome.tabs.update(existing.id, { active: true });
      return;
    }
    chrome.tabs.create({ url });
  });
}

function isMeetPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'meet.google.com' &&
      !parsed.username && !parsed.password;
  } catch (_) {
    return false;
  }
}

openCaptionShareButton.addEventListener('click', () => openExtensionPage('caption-presenter.html'));

async function openPrivateCorrections() {
  if (!chrome.sidePanel?.open) {
    openExtensionPage('sidepanel.html');
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) throw new Error(msgs.errorOpenCorrectionPanel);
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    showError(error.message || msgs.errorOpenCorrectionPanel);
  }
}

openCorrectionPanelButton.addEventListener('click', () => openPrivateCorrections());

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setUI(active) {
  isActive = active;

  if (active) {
    toggleBtn.textContent = msgs.btnStop;
    toggleBtn.classList.add('stop');
    statusDot.classList.add('active');
    statusText.textContent = msgs.statusRunning;
  } else {
    toggleBtn.textContent = msgs.btnStart;
    toggleBtn.classList.remove('stop');
    statusDot.classList.remove('active');
    statusText.textContent = msgs.statusStopped;
  }
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.style.display = msg ? 'block' : 'none';
}

function setLoading(loading) {
  toggleBtn.disabled = loading;
}

/** サーバーから取得したモデル情報を表示する。null を渡すと「未接続」表示。 */
function updateServerInfo(info) {
  if (info) {
    document.getElementById('whisper-model-label').textContent = info.whisperModel || '—';
    document.getElementById('llama-model-label').textContent   = info.llamaModel   || '—';
    serverInfo.style.display       = 'block';
    serverUnavailable.style.display = 'none';
  } else {
    serverInfo.style.display        = 'none';
    serverUnavailable.style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// Quick toggle: current in-Meet overlay
// ---------------------------------------------------------------------------
chrome.storage.local.get({ overlayEnabled: true }, (cfg) => {
  overlayEnabledToggle.checked = cfg.overlayEnabled;
});

overlayEnabledToggle.addEventListener('change', () => {
  chrome.storage.local.set({ overlayEnabled: overlayEnabledToggle.checked });
});

// ---------------------------------------------------------------------------
// Initialise: load settings (for i18n), then read state from background worker
// ---------------------------------------------------------------------------
chrome.storage.local.get({ sourceLang: '' }, ({ sourceLang }) => {
  msgs = getMessages(sourceLang);
  applyI18n(msgs);
  MeetTranslatorShared.migrateLegacyChatSetting(chrome.storage.local).then((showNotice) => {
    if (!showNotice) return;
    migrationNotice.textContent = msgs.chatMigrationNotice;
    migrationNotice.style.display = 'block';
  });
  // Re-render the button / status with the correct language after i18n is applied.
  setUI(isActive);
});

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (chrome.runtime.lastError) return;
  if (!response) return;
  setUI(response.isActive);
  if (response.lastError) showError(response.lastError);
  if (response.serverInfo) updateServerInfo(response.serverInfo);
});

// サーバーの最新モデル情報を取得（キャプチャ中かどうかに関わらず）
chrome.runtime.sendMessage({ type: 'GET_SERVER_INFO' }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response?.ok) {
    updateServerInfo({ whisperModel: response.whisperModel, llamaModel: response.llamaModel });
  } else {
    updateServerInfo(null);
  }
});

// サーバー切断をバックグラウンドからブロードキャストされたとき
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SERVER_UNREACHABLE') {
    setUI(false);
    updateServerInfo(null);
    showError(msgs.errorServerDisconnected);
  }
});

// Settings link
document.getElementById('settings-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------
// Microphone permission helper
// ---------------------------------------------------------------------------
/**
 * Checks microphone permission and prompts via getUserMedia if not yet granted.
 * @returns {Promise<boolean>} true if available
 */
async function ensureMicPermission() {
  let state = 'prompt';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    state = status.state; // 'granted' | 'denied' | 'prompt'
  } catch (_) {
    // permissions API not supported → fall through to getUserMedia
  }

  if (state === 'granted') return true;

  if (state === 'denied') {
    showError(msgs.errorMicDenied);
    return false;
  }

  // 'prompt' → show dialog via getUserMedia
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (err) {
    showError(msgs.errorMicRejected);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Button handler
// ---------------------------------------------------------------------------
toggleBtn.addEventListener('click', async () => {
  showError('');
  setLoading(true);

  try {
    if (!isActive) {
      // --- START ---
      // Make sure we are on a Meet tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !isMeetPage(tab.url)) {
        showError(msgs.errorMeetTab);
        setLoading(false);
        return;
      }

      // Check microphone permission when mic capture is needed
      const cfg = await new Promise((resolve) =>
        chrome.storage.local.get({ audioSource: 'mic-only' }, resolve));
      const needsMic = cfg.audioSource !== 'tab-only';

      if (needsMic) {
        const micOk = await ensureMicPermission();
        if (!micOk && cfg.audioSource === 'mic-only') {
          // mic-only but mic unavailable → abort
          setLoading(false);
          return;
        }
      }

      chrome.runtime.sendMessage(
        { type: 'START_CAPTURE', tabId: tab.id },
        (response) => {          setLoading(false);
          if (chrome.runtime.lastError || !response?.success) {
            showError(response?.error || msgs.errorStartFailed);
            updateServerInfo(null);
            return;
          }
          setUI(true);
          chrome.runtime.sendMessage({ type: 'GET_STATE' }, (r) => {
            if (r?.serverInfo) updateServerInfo(r.serverInfo);
          });
        }
      );
    } else {
      // --- STOP ---
      chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }, (response) => {
        setLoading(false);
        if (chrome.runtime.lastError || !response?.success) {
          showError(msgs.errorStopFailed);
          return;
        }
        setUI(false);
      });
    }
  } catch (err) {
    showError(err.message);
    setLoading(false);
  }
});
