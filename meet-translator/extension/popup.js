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

let isActive = false;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setUI(active) {
  isActive = active;

  if (active) {
    toggleBtn.textContent = '自動翻訳チャット停止';
    toggleBtn.classList.add('stop');
    statusDot.classList.add('active');
    statusText.textContent = '実行中 …';
  } else {
    toggleBtn.textContent = '自動翻訳チャット開始';
    toggleBtn.classList.remove('stop');
    statusDot.classList.remove('active');
    statusText.textContent = '停止中';
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
// Initialise: read current state from the background worker
// ---------------------------------------------------------------------------
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
    showError('サーバーへの接続が切断されました。自動翻訳を停止しました。');
  }
});

// Settings link
document.getElementById('settings-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

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

      if (!tab || !tab.url?.startsWith('https://meet.google.com/')) {
        showError('Google Meet タブで拡張機能を起動してください。');
        setLoading(false);
        return;
      }

      // マイク権限を事前取得 (offscreen document での getUserMedia に必要)
      // 取得したストリームはすぐ停止 — 実際の録音は offscreen.js で行う
      try {
        const tmpMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        tmpMicStream.getTracks().forEach((t) => t.stop());
      } catch (micErr) {
        // 許可を得られなかった場合は警告表示のみ（他参加者の音声のみ翻訳）
        showError('マイクへのアクセスを拒否しました。他の参加者の音声のみ翻訳されます。');
      }

      chrome.runtime.sendMessage(
        { type: 'START_CAPTURE', tabId: tab.id },
        (response) => {          setLoading(false);
          if (chrome.runtime.lastError || !response?.success) {
            showError(response?.error || '開始に失敗しました。サーバーが起動しているか確認してください。');
            updateServerInfo(null);
            return;
          }
          setUI(true);
          // キャプチャ開始後にモデル情報を更新
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
          showError('停止に失敗しました。');
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
