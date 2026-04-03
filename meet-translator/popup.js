/**
 * popup.js  –  Popup Script
 *
 * Manages the Start / Stop button and communicates with the background
 * service worker to control the capture / translation lifecycle.
 */

'use strict';

const toggleBtn = document.getElementById('toggle-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const errorMsg = document.getElementById('error-msg');

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

// ---------------------------------------------------------------------------
// Initialise: read current state from the background worker
// ---------------------------------------------------------------------------
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (chrome.runtime.lastError) return; // extension context invalidated
  if (response) setUI(response.isActive);
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

      chrome.runtime.sendMessage(
        { type: 'START_CAPTURE', tabId: tab.id },
        (response) => {
          setLoading(false);
          if (chrome.runtime.lastError || !response?.success) {
            showError('開始に失敗しました。ページを再読み込みして再試行してください。');
            return;
          }
          setUI(true);
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
