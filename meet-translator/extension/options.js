'use strict';

const DEFAULTS = {
  serverUrl:     'http://localhost:17070',
  sourceLang:    '',
  targetLang:    'ja',
  whisperModel:  'base',
  llamaModel:    '',
  llamaThinking: true,
  audioSource:   'mic-only',  // 'both' | 'mic-only' | 'tab-only'
  chatEnabled:   true,
  chatFormat:    'both',      // 'both' | 'translation' | 'transcription'
};

// モデル別オプション定義: どのモデルがどのオプションパネルを持つか
const MODEL_OPTIONS_MAP = {
  'qwen3:0.6b-q4_k_m':   'qwen3',
  'qwen3:1.7b-q4_k_m':   'qwen3',
  'qwen3:4b-q4_k_m':     'qwen3',
  'qwen3:8b-q4_k_m':     'qwen3',
  'qwen3.5:0.8b-q4_k_m': 'qwen3',
  'qwen3.5:2b-q4_k_m':   'qwen3',
  'qwen3.5:4b-q4_k_m':   'qwen3',
  'qwen3.5:9b-q4_k_m':   'qwen3',
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
  $('whisper-model').value = cfg.whisperModel;
  $('llama-model').value   = cfg.llamaModel;
  $('qwen3-thinking').checked = cfg.llamaThinking;
  $('audio-source').value   = cfg.audioSource;
  $('chat-enabled').checked = cfg.chatEnabled;
  $('chat-format').value    = cfg.chatFormat;
  updateChatFormatField(cfg.chatEnabled);
  updateModelOptions(cfg.llamaModel);

  // Apply i18n based on the saved source language.
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

// ---------------------------------------------------------------------------
// モデル選択変更時: モデル別オプションパネルの表示切り替え
// ---------------------------------------------------------------------------
$('llama-model').addEventListener('change', () => {
  updateModelOptions($('llama-model').value);
});

$('chat-enabled').addEventListener('change', () => {
  updateChatFormatField($('chat-enabled').checked);
});

function updateChatFormatField(enabled) {
  $('chat-format-field').style.display = enabled ? '' : 'none';
}

function updateModelOptions(modelName) {
  const group = MODEL_OPTIONS_MAP[modelName] || null;
  document.querySelectorAll('.model-options').forEach(el => {
    el.style.display = 'none';
  });
  if (group) {
    const panel = $(`model-options-${group}`);
    if (panel) panel.style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// Save button
// ---------------------------------------------------------------------------
$('save-btn').addEventListener('click', () => {
  const cfg = {
    serverUrl:     $('server-url').value.trim().replace(/\/$/, ''),
    sourceLang:    $('source-lang').value,
    targetLang:    $('target-lang').value,
    whisperModel:  $('whisper-model').value,
    llamaModel:    $('llama-model').value,
    llamaThinking: $('qwen3-thinking').checked,
    audioSource:   $('audio-source').value,
    chatEnabled:   $('chat-enabled').checked,
    chatFormat:    $('chat-format').value,
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
