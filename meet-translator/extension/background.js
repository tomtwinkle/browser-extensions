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
    serverUrl:     'http://localhost:7070',
    sourceLang:    '',
    targetLang:    'ja',
    whisperModel:  'base',
    llamaModel:    '',
    llamaThinking: true,
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

async function transcribeAndTranslate(wavBuffer) {
  const cfg = await getSettings();

  const form = new FormData();
  form.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('target_lang', cfg.targetLang);
  if (cfg.sourceLang) form.append('source_lang', cfg.sourceLang);

  // モデル指定 (空の場合はサーバーデフォルトを使用)
  if (cfg.llamaModel) {
    form.append('llama_model', cfg.llamaModel);
    // モデル別オプションを JSON で送信
    const opts = buildModelOptions(cfg);
    form.append('llama_options', JSON.stringify(opts));
  }

  const url = `${cfg.serverUrl}/transcribe-and-translate`;
  const bufLen = wavBuffer instanceof ArrayBuffer ? wavBuffer.byteLength : typeof wavBuffer;
  console.info('[background] transcribeAndTranslate: POST', url, '– wav', bufLen, 'bytes');

  const res = await fetch(url, {
    method: 'POST',
    body: form,
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

    // getMediaStreamId をラップして失敗時にエラーを呼び出し元まで伝播させる
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError || !id) {
          reject(new Error(chrome.runtime.lastError?.message ?? 'tabCapture: failed to get stream ID'));
        } else {
          resolve(id);
        }
      });
    });

    // Forward the stream ID to the offscreen document and wait for ack
    const ack = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START_AUDIO',
      streamId,
      tabId,
    }).catch((err) => {
      throw new Error('offscreen document not ready: ' + (err?.message ?? String(err)));
    });
    console.info('[background] OFFSCREEN_START_AUDIO ack=', ack);
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
      await chrome.tabs.sendMessage(tabId, { type: 'TRANSLATION_STOPPED' });
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

    // ---- Audio data from the offscreen document -------------------------
    case 'AUDIO_DATA': {
      console.info('[background] AUDIO_DATA received, isActive=', state.isActive,
        'bufLen=', message.wavBuffer instanceof ArrayBuffer ? message.wavBuffer.byteLength : typeof message.wavBuffer);
      if (!state.isActive) {
        console.warn('[background] AUDIO_DATA dropped: capture is not active');
        return false;
      }
      const tabId = state.tabId; // capture before async – state may change mid-await
      (async () => {
        try {
          const translatedText = await transcribeAndTranslate(message.wavBuffer);
          if (tabId && translatedText) {
            await chrome.tabs.sendMessage(tabId, {
              type: 'POST_TRANSLATION',
              text: translatedText,
            });
          }
        } catch (err) {
          console.error('[background] transcribeAndTranslate error:', err);
        }
      })();
      return false;
    }

    default:
      return false;
  }
});
