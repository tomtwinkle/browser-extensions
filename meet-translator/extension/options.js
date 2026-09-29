'use strict';

const DEFAULTS = {
  serverUrl:      'http://127.0.0.1:17070',
  apiToken:       '',
  sourceLang:     '',
  targetLang:     'ja',
  audioSource:    'mic-only',   // 'both' | 'mic-only' | 'tab-only'
  overlayEnabled: true,         // Meet 画面オーバーレイ表示（デフォルト有効）
  overlayFormat:  'both',       // 'both' | 'translation' | 'transcription'
  overlayScroll:  false,        // true=ニコニコ風スクロール / false=固定字幕（デフォルト）
  bidirectional:  false,        // 双方向翻訳（発話言語を検出して翻訳方向を動的に決定）
  publishMicrophoneCaptions: false,
};

let msgs = getMessages('');

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Load saved settings into the form
// ---------------------------------------------------------------------------
chrome.storage.local.get(Object.keys(DEFAULTS), (stored) => {
  const cfg = { ...DEFAULTS, ...stored };
  $('server-url').value    = cfg.serverUrl;
  $('api-token').value     = cfg.apiToken;
  $('extension-origin').textContent = `chrome-extension://${chrome.runtime.id}`;
  $('source-lang').value   = cfg.sourceLang;
  $('target-lang').value   = cfg.targetLang;
  $('audio-source').value   = cfg.audioSource;
  $('overlay-enabled').checked = cfg.overlayEnabled;
  $('overlay-format').value    = cfg.overlayFormat;
  $('overlay-scroll').checked  = cfg.overlayScroll;
  $('bidirectional').checked   = cfg.bidirectional;
  $('publish-microphone-captions').checked = cfg.publishMicrophoneCaptions;
  updateOverlayOptionsField(cfg.overlayEnabled);

  msgs = getMessages(cfg.sourceLang);
  applyI18n(msgs);
  migrateLegacyChatSetting(chrome.storage.local).then((showNotice) => {
    if (showNotice) showStatus(msgs.chatMigrationNotice, '');
  });
});

// ---------------------------------------------------------------------------
// Re-apply i18n when source language changes
// ---------------------------------------------------------------------------
$('source-lang').addEventListener('change', () => {
  msgs = getMessages($('source-lang').value);
  applyI18n(msgs);
});

$('overlay-enabled').addEventListener('change', () => {
  updateOverlayOptionsField($('overlay-enabled').checked);
});

function updateOverlayOptionsField(enabled) {
  $('overlay-options-field').style.display = enabled ? '' : 'none';
}
// ---------------------------------------------------------------------------
// Save button
// ---------------------------------------------------------------------------
$('save-btn').addEventListener('click', () => {
  const cfg = {
    serverUrl:      normalizeLocalServerURL($('server-url').value.trim()),
    apiToken:       $('api-token').value.trim(),
    sourceLang:     $('source-lang').value,
    targetLang:     $('target-lang').value,
    audioSource:    $('audio-source').value,
    overlayEnabled: $('overlay-enabled').checked,
    overlayFormat:  $('overlay-format').value,
    overlayScroll:  $('overlay-scroll').checked,
    bidirectional:  $('bidirectional').checked,
    publishMicrophoneCaptions: $('publish-microphone-captions').checked,
  };
  if (!cfg.serverUrl) {
    showStatus(msgs.msgInvalidServerUrl, 'err');
    return;
  }
  chrome.storage.local.set(cfg, () => {
    showStatus(msgs.msgSaved, 'ok');
  });
});

// ---------------------------------------------------------------------------
// Health check button
// ---------------------------------------------------------------------------
$('health-btn').addEventListener('click', async () => {
  const url = normalizeLocalServerURL($('server-url').value.trim());
  if (!url) {
    showStatus(msgs.msgInvalidServerUrl, 'err');
    return;
  }
  const apiToken = $('api-token').value.trim();
  showStatus(msgs.msgChecking, '');
  try {
    const res = await fetch(`${url}/health`, {
      headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      showStatus(msgs.msgServerOk, 'ok');
    } else {
      showStatus(`${msgs.msgServerError}${res.status}`, 'err');
    }
  } catch (err) {
    showStatus(`${msgs.msgServerFailed}${err.message}`, 'err');
  }
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function showStatus(msg, cssClass) {
  const el = $('status-msg');
  el.textContent = msg;
  el.className = cssClass;
  if (cssClass === 'ok') {
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
  }
}
