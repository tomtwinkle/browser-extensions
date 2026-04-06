/**
 * background.js  –  Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  1. Receive START / STOP commands from the popup.
 *  2. Obtain a Tab Capture stream-ID via chrome.tabCapture.getMediaStreamId(),
 *     then hand it to the offscreen document for Web Audio processing.
 *  3. Receive raw audio data back from the offscreen document.
 *  4. Run transcribeAndTranslate() – currently a mock – and forward the result
 *     to the content script so it can post the text to the Meet chat.
 */

'use strict';

/** 言語コード → 表示名マッピング */
const LANG_LABELS = {
  en: 'English', ja: '日本語', zh: '中文', ko: '한국어',
  fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português',
};
const langLabel = (code) => LANG_LABELS[code] || code || '原文';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  isActive: false,
  tabId: null,
  lastError: null,
  healthCheckTimer: null,
  serverInfo: null, // { whisperModel, llamaModel } – populated from /health
};

// ---------------------------------------------------------------------------
// Transcription + Translation via local server
// ---------------------------------------------------------------------------

/** Load settings from chrome.storage.local with defaults. */
async function getSettings() {
  const defaults = {
    serverUrl:     'http://localhost:17070',
    sourceLang:    '',
    targetLang:    'ja',
    whisperModel:  'base',
    llamaModel:    '',
    llamaThinking: true,
    audioSource:   'mic-only', // 'both' | 'mic-only' | 'tab-only'
    chatEnabled:   true,        // チャットへの自動投稿
    chatFormat:    'both',      // 'both' | 'translation' | 'transcription'
  };
  const stored = await chrome.storage.local.get(Object.keys(defaults));
  return { ...defaults, ...stored };
}

/**
 * GET /health を叩いてサーバーの疎通とロード済みモデルを確認する。
 * AbortController + setTimeout を使い、AbortSignal.timeout が
 * 利用できない環境でも動作するよう実装する。
 * @returns {{ ok: boolean, whisperModel?: string, llamaModel?: string }}
 */
async function checkServerHealth() {
  const cfg = await getSettings();
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${cfg.serverUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) {
      console.warn('[background] health check: server returned', res.status);
      return { ok: false };
    }
    const data = await res.json();
    const result = {
      ok: true,
      whisperModel: data.whisper_model || '',
      llamaModel:   data.llama_model   || '',
    };
    console.info('[background] health check ok – whisper:', result.whisperModel, 'llama:', result.llamaModel);
    return result;
  } catch (err) {
    clearTimeout(tid);
    console.warn('[background] health check failed:', err?.message ?? String(err));
    return { ok: false };
  }
}

/**
 * POST /transcribe – 音声データを Whisper で文字起こしして返す。
 * @param {number[]} wavBytes - offscreen から送られてきた Array<number>
 * @param {object}  cfg       - getSettings() の結果
 * @returns {Promise<string|null>}
 */
async function transcribeOnly(wavBytes, cfg) {
  const wavBuffer = new Uint8Array(wavBytes).buffer;
  const form = new FormData();
  form.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  if (cfg.sourceLang) form.append('source_lang', cfg.sourceLang);

  console.info('[background] transcribeOnly: POST', `${cfg.serverUrl}/transcribe`, '–', wavBuffer.byteLength, 'bytes');
  const res = await fetch(`${cfg.serverUrl}/transcribe`, { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`server error ${res.status}: ${detail}`);
  }
  const { transcription } = await res.json();
  return transcription || null;
}

/**
 * POST /translate – テキストを LLM で翻訳して返す。
 * @param {string}  text - 翻訳元テキスト
 * @param {object}  cfg  - getSettings() の結果
 * @returns {Promise<string|null>}
 */
async function translateOnly(text, cfg) {
  const params = new URLSearchParams({ text, target_lang: cfg.targetLang });
  if (cfg.sourceLang)  params.set('source_lang', cfg.sourceLang);
  if (cfg.llamaModel) {
    params.set('llama_model', cfg.llamaModel);
    params.set('llama_options', JSON.stringify(buildModelOptions(cfg)));
  }

  console.info('[background] translateOnly: POST', `${cfg.serverUrl}/translate`);
  const res = await fetch(`${cfg.serverUrl}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`server error ${res.status}: ${detail}`);
  }
  const { translation } = await res.json();
  return translation || null;
}

/** モデル名に応じたオプションオブジェクトを組み立てる。 */
function buildModelOptions(cfg) {
  if (cfg.llamaModel.startsWith('qwen3:') || cfg.llamaModel.startsWith('qwen3.5:')) {
    return { thinking: cfg.llamaThinking };
  }
  return {};
}

/**
 * content.js へメッセージを送る。
 * 「Receiving end does not exist」の場合は content.js を動的注入してリトライする。
 * 拡張機能の更新後に開いたままのタブでも確実に届くようにする。
 */
async function sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (!err.message?.includes('Receiving end does not exist')) throw err;

    // content.js が未注入 → 動的注入してリトライ
    console.info('[background] content.js not found, injecting into tab', tabId);
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (injectErr) {
      console.warn('[background] content script injection failed:', injectErr.message);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Offscreen document helpers (MV3: AudioContext must live in a document)
// ---------------------------------------------------------------------------
const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

async function ensureOffscreenDocument() {
  // Check whether the offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  });
  if (existingContexts.length > 0) {
    return; // already open
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Google Meet タブの音声を Web Audio API でキャプチャするため',
  });
}

async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) {
    // Already closed or never created – ignore
  }
}

// ---------------------------------------------------------------------------
// Capture lifecycle
// ---------------------------------------------------------------------------
async function startCapture(tabId) {
  if (state.isActive) return;

  // サーバー疎通確認 – 接続できなければ開始を拒否
  const health = await checkServerHealth();
  if (!health.ok) {
    throw new Error('サーバーに接続できません。サーバーが起動しているか確認してください。');
  }

  state.isActive = true;
  state.tabId    = tabId;
  state.lastError = null;
  state.serverInfo = { whisperModel: health.whisperModel, llamaModel: health.llamaModel };

  // 定期ヘルスチェック（30 秒ごと）- サーバーが落ちたら自動停止
  state.healthCheckTimer = setInterval(async () => {
    if (!state.isActive) return;
    const h = await checkServerHealth();
    if (!h.ok) {
      console.warn('[background] server health check failed – stopping capture.');
      state.lastError = 'サーバーへの接続が切断されました。';
      await stopCapture();
      chrome.runtime.sendMessage({ type: 'SERVER_UNREACHABLE' }).catch(() => {});
      return;
    }
    state.serverInfo = { whisperModel: h.whisperModel, llamaModel: h.llamaModel };
  }, 30_000);

  try {
    // Make sure the offscreen document is ready for audio processing
    await ensureOffscreenDocument();

    const cfg = await getSettings();
    const needsTabCapture = cfg.audioSource !== 'mic-only';

    // tab 音声が必要な場合のみ getMediaStreamId を呼ぶ
    let streamId = null;
    if (needsTabCapture) {
      streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError || !id) {
            reject(new Error(chrome.runtime.lastError?.message ?? 'tabCapture: failed to get stream ID'));
          } else {
            resolve(id);
          }
        });
      });
    }

    // Forward the stream ID (and audioSource) to the offscreen document and wait for ack
    const ack = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START_AUDIO',
      streamId,          // null if mic-only
      audioSource: cfg.audioSource,
      tabId,
    }).catch((err) => {
      throw new Error('offscreen document not ready: ' + (err?.message ?? String(err)));
    });
    console.info('[background] OFFSCREEN_START_AUDIO ack=', ack, 'audioSource=', cfg.audioSource);
    console.info('[background] startCapture: audio capture started, tabId=', tabId);
  } catch (err) {
    console.error('[background] startCapture failed:', err);
    await stopCapture();
    throw err; // popup にエラーを伝える
  }
}

async function stopCapture() {
  if (!state.isActive) return;

  // 定期ヘルスチェックを停止
  if (state.healthCheckTimer) {
    clearInterval(state.healthCheckTimer);
    state.healthCheckTimer = null;
  }

  state.isActive = false;
  const tabId = state.tabId;
  state.tabId = null;

  // Tell the offscreen document to stop processing
  try {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_AUDIO' });
  } catch (_) {}

  await closeOffscreenDocument();

  // Notify the content script that translation has stopped
  if (tabId) {
    try {
      await sendToContentScript(tabId, { type: 'TRANSLATION_STOPPED' });
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    // ---- Commands from the popup ----------------------------------------
    case 'START_CAPTURE':
      startCapture(message.tabId)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // keep channel open for async response

    case 'STOP_CAPTURE':
      stopCapture()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'GET_STATE':
      sendResponse({ isActive: state.isActive, lastError: state.lastError, serverInfo: state.serverInfo });
      return false;

    // ---- popup がサーバー情報を要求（キャプチャ中かどうかに関わらず） -------
    case 'GET_SERVER_INFO':
      (async () => {
        const health = await checkServerHealth();
        if (health.ok) {
          state.serverInfo = { whisperModel: health.whisperModel, llamaModel: health.llamaModel };
          sendResponse({ ok: true, whisperModel: health.whisperModel, llamaModel: health.llamaModel });
        } else {
          sendResponse({ ok: false });
        }
      })();
      return true; // 非同期レスポンスのためチャネルを維持

    // ---- Log bridge from offscreen document -----------------------------
    case 'OFFSCREEN_LOG': {
      const fn = console[message.level] ?? console.info;
      fn('[offscreen→bg]', message.msg);
      return false;
    }

    // ---- Audio data from the offscreen document -------------------------
    case 'AUDIO_DATA': {
      console.info('[background] AUDIO_DATA received, isActive=', state.isActive,
        'bytes=', Array.isArray(message.wavBytes) ? message.wavBytes.length : '?');
      if (!state.isActive) {
        console.warn('[background] AUDIO_DATA dropped: capture is not active');
        return false;
      }
      const tabId = state.tabId; // capture before async – state may change mid-await
      (async () => {
        try {
          const cfg = await getSettings();

          // Step 1: Whisper 文字起こし → 即チャット投稿
          const transcription = await transcribeOnly(message.wavBytes, cfg);
          if (!transcription) return;

          console.info('[background] transcription:', transcription.slice(0, 100));
          if (tabId && cfg.chatEnabled && cfg.chatFormat !== 'translation') {
            await sendToContentScript(tabId, {
              type: 'POST_TRANSLATION',
              text: `[${langLabel(cfg.sourceLang)}]\n${transcription}`,
            });
          }

          // Step 2: LLM 翻訳 → チャット投稿
          if (cfg.chatFormat === 'transcription') return;
          const translation = await translateOnly(transcription, cfg);
          if (!translation) return;

          console.info('[background] translation:', translation.slice(0, 100));
          if (tabId && cfg.chatEnabled) {
            await sendToContentScript(tabId, {
              type: 'POST_TRANSLATION',
              text: `[${langLabel(cfg.targetLang)}]\n${translation}`,
            });
          }
        } catch (err) {
          console.error('[background] audio processing error:', err);
        }
      })();
      return false;
    }

    default:
      return false;
  }
});
