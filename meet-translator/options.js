'use strict';

const DEFAULTS = {
  serverUrl: 'http://localhost:7070',
  sourceLang: '',
  targetLang: 'ja',
  whisperModel: 'base',
  ollamaModel: 'qwen2.5:7b',
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Load saved settings into the form
// ---------------------------------------------------------------------------
chrome.storage.local.get(Object.keys(DEFAULTS), (stored) => {
  const cfg = { ...DEFAULTS, ...stored };
  $('server-url').value    = cfg.serverUrl;
  $('source-lang').value   = cfg.sourceLang;
  $('target-lang').value   = cfg.targetLang;
  $('whisper-model').value = cfg.whisperModel;
  $('ollama-model').value  = cfg.ollamaModel;
});

// ---------------------------------------------------------------------------
// Save button
// ---------------------------------------------------------------------------
$('save-btn').addEventListener('click', () => {
  const cfg = {
    serverUrl:    $('server-url').value.trim().replace(/\/$/, ''),
    sourceLang:   $('source-lang').value,
    targetLang:   $('target-lang').value,
    whisperModel: $('whisper-model').value,
    ollamaModel:  $('ollama-model').value.trim(),
  };
  chrome.storage.local.set(cfg, () => {
    showStatus('保存しました ✓', 'ok');
  });
});

// ---------------------------------------------------------------------------
// Health check button
// ---------------------------------------------------------------------------
$('health-btn').addEventListener('click', async () => {
  const url = $('server-url').value.trim().replace(/\/$/, '');
  showStatus('確認中…', '');
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      showStatus('サーバー接続 OK ✓', 'ok');
    } else {
      showStatus(`エラー: HTTP ${res.status}`, 'err');
    }
  } catch (err) {
    showStatus(`接続失敗: ${err.message}`, 'err');
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
