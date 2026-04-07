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

/**
 * テキストの言語を簡易判定する（ja / en のみ対応）。
 * ひらがな・カタカナ・漢字の割合が 20% を超えれば 'ja'、それ以外は 'en'。
 * @param {string} text
 * @returns {'ja'|'en'|null} 空文字・空白のみの場合は null
 */
function detectTextLang(text) {
  const stripped = text.replace(/\s+/g, '');
  if (!stripped) return null;
  const jpChars = (stripped.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/g) || []).length;
  return jpChars / stripped.length > 0.2 ? 'ja' : 'en';
}

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
    serverUrl:      'http://localhost:17070',
    sourceLang:     '',
    targetLang:     'ja',
    audioSource:    'mic-only',  // 'both' | 'mic-only' | 'tab-only'
    chatEnabled:    false,       // チャットへの自動投稿（デフォルト無効）
    chatFormat:     'both',      // 'both' | 'translation' | 'transcription'
    overlayEnabled: true,        // Meet 画面オーバーレイ表示（デフォルト有効）
    overlayFormat:  'both',      // 'both' | 'translation' | 'transcription'
    overlayScroll:  false,       // true=ニコニコ風スクロール / false=固定字幕
    bidirectional:  false,       // 双方向翻訳（発話言語を検出して翻訳方向を動的に決定）
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
 * @param {string}  text       - 翻訳元テキスト
 * @param {string}  sourceLang - 翻訳元言語コード（空文字で自動）
 * @param {string}  targetLang - 翻訳先言語コード
 * @param {object}  cfg        - getSettings() の結果（serverUrl 取得用）
 * @returns {Promise<string|null>}
 */
async function translateOnly(text, sourceLang, targetLang, cfg) {
  const params = new URLSearchParams({ text, target_lang: targetLang });
  if (sourceLang) params.set('source_lang', sourceLang);

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

/**
 * Returns true when the transcription consists entirely of filler sounds
 * (hesitation words like "うーん", "えー", "uh", "hmm") and should be discarded.
 *
 * The regex requires that the *whole* string be filler tokens (optionally
 * separated by punctuation), so "えーと、今日は" is NOT filtered — only
 * strings where every token is a filler.
 *
 * @param {string} text - Whisper transcription result
 * @returns {boolean}
 */
function isFillerOnly(text) {
  if (!text || !text.trim()) return true;
  // Filler tokens: Japanese hesitations + common English equivalents
  // Punctuation/whitespace characters that may appear between or around tokens
  const FILLER_RE = /^[\s\u3000、。,.!?！？…「」]*((う[ーんむ]*|え[ーと]*|あ[ーの]*|は[ー]+|ふ[ーん]*|ん[ーん]*|uh+|um+|hm+|er+|ah+|oh+|mm+)[\s\u3000、。,.!?！？…「」]*)+$/iu;
  return FILLER_RE.test(text.trim());
}

/**
 * Strip filler tokens from text, returning clean speech content for translation.
 * Adjacent punctuation/whitespace is consumed along with each filler token and
 * replaced with a single space so the remaining words stay naturally separated.
 * Returns empty string if the whole text is fillers.
 *
 * Example: "えーと、今日は天気がいいですね" → "今日は天気がいいですね"
 *
 * @param {string} text - Whisper transcription result
 * @returns {string}
 */
function stripFillers(text) {
  if (!text) return '';
  const FILLER_RE = /[\s\u3000、。,.!?！？…「」]*(う[ーんむ]*|え[ーと]*|あ[ーの]*|は[ー]+|ふ[ーん]*|ん[ーん]*|uh+|um+|hm+|er+|ah+|oh+|mm+)[\s\u3000、。,.!?！？…「」]*/giu;
  return text.replace(FILLER_RE, ' ').replace(/\s+/g, ' ').trim();
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

          // Step 1: Whisper 文字起こし → チャット投稿 / オーバーレイ（原文）
          const transcription = await transcribeOnly(message.wavBytes, cfg);
          if (!transcription) return;

          if (isFillerOnly(transcription)) {
            console.info('[background] filler-only transcription, skipping:', transcription);
            return;
          }

          console.info('[background] transcription:', transcription.slice(0, 100));

          // 双方向翻訳: 発話言語を検出して翻訳方向を決定
          let translSourceLang = cfg.sourceLang;
          let translTargetLang = cfg.targetLang;
          if (cfg.bidirectional && cfg.sourceLang && cfg.targetLang) {
            const detected = detectTextLang(transcription);
            if (detected && detected === cfg.targetLang) {
              // 翻訳先言語で発話 → 逆方向に翻訳
              translSourceLang = cfg.targetLang;
              translTargetLang = cfg.sourceLang;
              console.info('[background] bidirectional: detected', detected, '→ translating to', translTargetLang);
            }
          }

          // チャット: 原文投稿
          if (tabId && cfg.chatEnabled && cfg.chatFormat !== 'translation') {
            await sendToContentScript(tabId, {
              type: 'POST_TRANSLATION',
              text: `[${langLabel(translSourceLang || cfg.sourceLang)}]\n${transcription}`,
            });
          }

          // フィラー除去後のテキストを翻訳に使う
          const textToTranslate = stripFillers(transcription);

          // 翻訳不要なら原文のみオーバーレイ表示して終了
          const needTranslation =
            textToTranslate &&
            ((cfg.chatEnabled    && cfg.chatFormat    !== 'transcription') ||
             (cfg.overlayEnabled && cfg.overlayFormat !== 'transcription'));

          if (!needTranslation) {
            if (tabId && cfg.overlayEnabled && cfg.overlayFormat !== 'translation') {
              await sendToContentScript(tabId, {
                type:        'SHOW_OVERLAY',
                original:    transcription,
                translation: null,
                scroll:      cfg.overlayScroll,
              });
            }
            return;
          }

          // Step 2: LLM 翻訳
          const translation = await translateOnly(textToTranslate, translSourceLang, translTargetLang, cfg);
          if (!translation) return;

          console.info('[background] translation:', translation.slice(0, 100));

          // チャット: 翻訳投稿
          if (tabId && cfg.chatEnabled && cfg.chatFormat !== 'transcription') {
            await sendToContentScript(tabId, {
              type: 'POST_TRANSLATION',
              text: `[${langLabel(translTargetLang)}]\n${translation}`,
            });
          }

          // オーバーレイ表示
          if (tabId && cfg.overlayEnabled) {
            await sendToContentScript(tabId, {
              type:        'SHOW_OVERLAY',
              original:    cfg.overlayFormat !== 'translation'   ? transcription : null,
              translation: cfg.overlayFormat !== 'transcription' ? translation   : null,
              scroll:      cfg.overlayScroll,
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
