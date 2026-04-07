'use strict';

const DEFAULTS = {
  serverUrl:      'http://localhost:17070',
  sourceLang:     '',
  targetLang:     'ja',
  audioSource:    'mic-only',   // 'both' | 'mic-only' | 'tab-only'
  chatEnabled:    false,        // チャットへの自動投稿（デフォルト無効）
  chatFormat:     'both',       // 'both' | 'translation' | 'transcription'
  overlayEnabled: true,         // Meet 画面オーバーレイ表示（デフォルト有効）
  overlayFormat:  'both',       // 'both' | 'translation' | 'transcription'
  overlayScroll:  false,        // true=ニコニコ風スクロール / false=固定字幕（デフォルト）
  bidirectional:  false,        // 双方向翻訳（発話言語を検出して翻訳方向を動的に決定）
};

let msgs = getMessages('');

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Load saved settings into the form
// ---------------------------------------------------------------------------
chrome.storage.local.get(Object.keys(DEFAULTS), (stored) => {
  const cfg = { ...DEFAULTS, ...stored };
  $('server-url').value    = cfg.serverUrl;
  $('source-lang').value   = cfg.sourceLang;
  $('target-lang').value   = cfg.targetLang;
  $('audio-source').value   = cfg.audioSource;
  $('chat-enabled').checked = cfg.chatEnabled;
  $('chat-format').value    = cfg.chatFormat;
  $('overlay-enabled').checked = cfg.overlayEnabled;
  $('overlay-format').value    = cfg.overlayFormat;
  $('overlay-scroll').checked  = cfg.overlayScroll;
  $('bidirectional').checked   = cfg.bidirectional;
  updateChatFormatField(cfg.chatEnabled);
  updateOverlayOptionsField(cfg.overlayEnabled);

  msgs = getMessages(cfg.sourceLang);
  applyI18n(msgs);
});

// ---------------------------------------------------------------------------
// Re-apply i18n when source language changes
// ---------------------------------------------------------------------------
$('source-lang').addEventListener('change', () => {
  msgs = getMessages($('source-lang').value);
  applyI18n(msgs);
});

$('chat-enabled').addEventListener('change', () => {
  updateChatFormatField($('chat-enabled').checked);
});

$('overlay-enabled').addEventListener('change', () => {
  updateOverlayOptionsField($('overlay-enabled').checked);
});

function updateChatFormatField(enabled) {
  $('chat-format-field').style.display = enabled ? '' : 'none';
}

function updateOverlayOptionsField(enabled) {
  $('overlay-options-field').style.display = enabled ? '' : 'none';
}
// ---------------------------------------------------------------------------
// Save button
// ---------------------------------------------------------------------------
$('save-btn').addEventListener('click', () => {
  const cfg = {
    serverUrl:      $('server-url').value.trim().replace(/\/$/, ''),
    sourceLang:     $('source-lang').value,
    targetLang:     $('target-lang').value,
    audioSource:    $('audio-source').value,
    chatEnabled:    $('chat-enabled').checked,
    chatFormat:     $('chat-format').value,
    overlayEnabled: $('overlay-enabled').checked,
    overlayFormat:  $('overlay-format').value,
    overlayScroll:  $('overlay-scroll').checked,
    bidirectional:  $('bidirectional').checked,
  };
  chrome.storage.local.set(cfg, () => {
    showStatus(msgs.msgSaved, 'ok');
  });
});

// ---------------------------------------------------------------------------
// Health check button
// ---------------------------------------------------------------------------
$('health-btn').addEventListener('click', async () => {
  const url = $('server-url').value.trim().replace(/\/$/, '');
  showStatus(msgs.msgChecking, '');
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
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
