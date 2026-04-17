/**
 * background.js  –  Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  1. Receive START / STOP commands from the popup.
 *  2. Obtain a Tab Capture stream-ID via chrome.tabCapture.getMediaStreamId(),
 *     then hand it to the offscreen document for Web Audio processing.
 *  3. Receive raw audio data back from the offscreen document.
 *  4. Batch consecutive same-speaker utterances briefly before sending them to
 *     the local server.
 *  5. Run transcribeAndTranslate() – currently a mock – and forward the result
 *     to the content script so it can post the text to the Meet chat.
 *  5. Accept in-call glossary feedback from the Meet UI and upsert it to the server.
 */

'use strict';

importScripts('shared.js');

const {
  base64ToUint8Array,
  buildGlossaryFeedbackDescription,
  detectTextLang,
  formatChatMessage,
  getWavDurationMs,
  isFillerOnly,
  mergeWavBase64Chunks,
  normalizeFeedbackText,
  normalizeSpeakerName,
  resolveContentScriptFrame,
  stripFillers,
} = globalThis.MeetTranslatorShared;

const SPEAKER_BATCH_ALARM = 'speaker-audio-batch-flush';
const SPEAKER_BATCH_IDLE_MS = 1200;
const MAX_SPEAKER_BATCH_DURATION_MS = 20000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_HEALTH_CHECK_FAILURES = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  isActive: false,
  tabId: null,
  lastError: null,
  healthCheckTimer: null,
  healthCheckFailures: 0,
  healthCheckInFlight: false,
  serverInfo: null, // { whisperModel, llamaModel } – populated from /health
  pendingSpeakerBatch: null,
  embeddedChatFrame: null, // { tabId, frameId }
  audioQueue: Promise.resolve(),
  translationTasks: new Set(),
  nextUtteranceId: 0,
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
  const tid = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
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

function assessHealthCheckFailures(
  previousFailures,
  healthOk,
  threshold = MAX_CONSECUTIVE_HEALTH_CHECK_FAILURES
) {
  const failureCount = healthOk ? 0 : previousFailures + 1;
  return {
    failureCount,
    recovered: healthOk && previousFailures > 0,
    shouldStop: !healthOk && failureCount >= threshold,
  };
}

async function runPeriodicHealthCheck() {
  if (!state.isActive || state.healthCheckInFlight) return;

  state.healthCheckInFlight = true;
  try {
    const health = await checkServerHealth();
    const assessment = assessHealthCheckFailures(state.healthCheckFailures, health.ok);
    state.healthCheckFailures = assessment.failureCount;

    if (health.ok) {
      if (assessment.recovered) {
        console.info('[background] health check recovered after transient failures.');
      }
      state.serverInfo = { whisperModel: health.whisperModel, llamaModel: health.llamaModel };
      return;
    }

    if (!assessment.shouldStop) {
      console.warn(
        `[background] health check failed (${assessment.failureCount}/${MAX_CONSECUTIVE_HEALTH_CHECK_FAILURES}) – keeping capture active.`
      );
      return;
    }

    console.warn('[background] server health check failed repeatedly – confirming before stopping capture.');
    const confirmation = await checkServerHealth();
    if (confirmation.ok) {
      state.healthCheckFailures = 0;
      state.serverInfo = {
        whisperModel: confirmation.whisperModel,
        llamaModel: confirmation.llamaModel,
      };
      console.info('[background] health check recovered during confirmation – keeping capture active.');
      return;
    }

    console.warn('[background] server health check failed repeatedly – stopping capture.');
    state.lastError = 'サーバーへの接続が切断されました。';
    await stopCapture();
    chrome.runtime.sendMessage({ type: 'SERVER_UNREACHABLE' }).catch(() => {});
  } finally {
    state.healthCheckInFlight = false;
  }
}

/**
 * POST /transcribe – 音声データを Whisper で文字起こしして返す。
 * @param {string} wavB64 - base64 エンコードされた WAV データ (offscreen から送られてくる)
 * @param {object} cfg    - getSettings() の結果
 * @returns {Promise<{transcription: string|null, detectedLang: string|null}>}
 */
async function transcribeOnly(wavB64, cfg) {
  // base64 → Uint8Array に変換。文字列は structured-clone で常に正しくコピーされる。
  const audioData = base64ToUint8Array(wavB64);
  const form = new FormData();
  form.append('audio', new Blob([audioData], { type: 'audio/wav' }), 'audio.wav');
  if (cfg.sourceLang) form.append('source_lang', cfg.sourceLang);

  console.info('[background] transcribeOnly: POST', `${cfg.serverUrl}/transcribe`, '–', audioData.byteLength, 'bytes');
  const res = await fetch(`${cfg.serverUrl}/transcribe`, { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`server error ${res.status}: ${detail}`);
  }
  const { transcription, detected_language } = await res.json();
  return { transcription: transcription || null, detectedLang: detected_language || null };
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


function scheduleSpeakerBatchFlush(delayMs = SPEAKER_BATCH_IDLE_MS) {
  chrome.alarms.create(SPEAKER_BATCH_ALARM, { when: Date.now() + delayMs });
}

function cancelSpeakerBatchFlush() {
  chrome.alarms.clear(SPEAKER_BATCH_ALARM);
}

function startSpeakerBatch(wavB64, speakerName, durationMs) {
  state.pendingSpeakerBatch = {
    speakerName,
    wavChunks: [wavB64],
    totalDurationMs: durationMs,
  };
  console.info('[background] speaker batch started:', speakerName, `(${durationMs.toFixed(0)}ms)`);
  scheduleSpeakerBatchFlush();
}

function enqueueAudioTask(task) {
  const next = state.audioQueue.then(task);
  state.audioQueue = next.catch((err) => {
    console.error('[background] audio processing error:', err);
  });
  return next;
}

function startTranslationTask(task) {
  const tracked = Promise.resolve()
    .then(task)
    .catch((err) => {
      console.error('[background] translation processing error:', err);
    });

  state.translationTasks.add(tracked);
  tracked.finally(() => {
    state.translationTasks.delete(tracked);
  });
  return tracked;
}

async function waitForQueuedAudioTasks() {
  while (true) {
    const queuedTask = state.audioQueue;
    await queuedTask;
    if (queuedTask === state.audioQueue) return;
  }
}

async function waitForTranslationTasks() {
  while (state.translationTasks.size > 0) {
    await Promise.all(Array.from(state.translationTasks));
  }
}

async function processAudioChunk(wavB64, speakerName, tabId) {
  const cfg = await getSettings();

  // Step 1: Whisper 文字起こし → チャット投稿 / オーバーレイ（原文）
  const { transcription, detectedLang } = await transcribeOnly(wavB64, cfg);
  if (!transcription) return;

  if (isFillerOnly(transcription)) {
    console.info('[background] filler-only transcription, skipping:', transcription);
    return;
  }

  console.info('[background] transcription:', transcription.slice(0, 100));
  const utteranceId = ++state.nextUtteranceId;
  await pushFeedbackContext(tabId, {
    utteranceId,
    original: transcription,
    translation: null,
    speakerName,
  });

  // 双方向翻訳: Whisper 検出言語を優先し、未取得時は文字種フォールバック
  let translSourceLang = cfg.sourceLang;
  let translTargetLang = cfg.targetLang;
  if (cfg.bidirectional && cfg.sourceLang && cfg.targetLang) {
    const detected = detectedLang || detectTextLang(transcription);
    if (detected && detected === cfg.targetLang) {
      // 翻訳先言語で発話 → 逆方向に翻訳
      translSourceLang = cfg.targetLang;
      translTargetLang = cfg.sourceLang;
      console.info('[background] bidirectional: detected', detected, '→ translating to', translTargetLang);
    }
  }

  // チャット: 原文投稿
  if (tabId && cfg.chatEnabled && cfg.chatFormat !== 'translation') {
    await dispatchToContentScript(tabId, {
      type: 'POST_TRANSLATION',
      text: formatChatMessage(translSourceLang || cfg.sourceLang, transcription, speakerName),
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
      await dispatchToContentScript(tabId, {
        type:        'SHOW_OVERLAY',
        utteranceId,
        original:    transcription,
        translation: null,
        scroll:      cfg.overlayScroll,
        speakerName,
      });
    }
    return;
  }

  // Step 2: LLM 翻訳
  // 翻訳は音声キューから切り離して並列実行し、後続の音声を早く backend に送れるようにする。
  startTranslationTask(async () => {
    const translation = await translateOnly(textToTranslate, translSourceLang, translTargetLang, cfg);
    if (!translation) return;

    console.info('[background] translation:', translation.slice(0, 100));
    await pushFeedbackContext(tabId, {
      utteranceId,
      original: transcription,
      translation,
      speakerName,
    });

    // チャット: 翻訳投稿
    if (tabId && cfg.chatEnabled && cfg.chatFormat !== 'transcription') {
      await dispatchToContentScript(tabId, {
        type: 'POST_TRANSLATION',
        text: formatChatMessage(translTargetLang, translation, speakerName),
      });
    }

    // オーバーレイ表示
    if (tabId && cfg.overlayEnabled) {
      await dispatchToContentScript(tabId, {
        type:        'SHOW_OVERLAY',
        utteranceId,
        original:    cfg.overlayFormat !== 'translation'   ? transcription : null,
        translation: cfg.overlayFormat !== 'transcription' ? translation   : null,
        scroll:      cfg.overlayScroll,
        speakerName,
      });
    }
  });
}

async function flushPendingSpeakerBatch(reason, tabId = state.tabId) {
  const batch = state.pendingSpeakerBatch;
  if (!batch) return false;

  state.pendingSpeakerBatch = null;
  cancelSpeakerBatchFlush();

  console.info(
    '[background] flushing speaker batch:',
    batch.speakerName,
    `(${batch.wavChunks.length} chunks, ${batch.totalDurationMs.toFixed(0)}ms, reason=${reason})`
  );

  if (batch.wavChunks.length === 1) {
    await processAudioChunk(batch.wavChunks[0], batch.speakerName, tabId);
    return true;
  }

  try {
    const mergedWavB64 = mergeWavBase64Chunks(batch.wavChunks);
    await processAudioChunk(mergedWavB64, batch.speakerName, tabId);
  } catch (err) {
    console.warn('[background] speaker batch merge failed, replaying individual chunks:', err.message);
    for (const wavB64 of batch.wavChunks) {
      await processAudioChunk(wavB64, batch.speakerName, tabId);
    }
  }

  return true;
}

async function handleAudioData(wavB64) {
  const tabId = state.tabId;
  const speakerName = await getActiveSpeaker(tabId);
  const normalizedSpeaker = normalizeSpeakerName(speakerName);

  if (!normalizedSpeaker) {
    await flushPendingSpeakerBatch('speaker-unavailable', tabId);
    await processAudioChunk(wavB64, null, tabId);
    return;
  }

  const durationMs = getWavDurationMs(wavB64);
  if (durationMs >= MAX_SPEAKER_BATCH_DURATION_MS) {
    await flushPendingSpeakerBatch('oversized-single-chunk', tabId);
    await processAudioChunk(wavB64, normalizedSpeaker, tabId);
    return;
  }

  const pending = state.pendingSpeakerBatch;
  if (!pending) {
    startSpeakerBatch(wavB64, normalizedSpeaker, durationMs);
    return;
  }

  if (pending.speakerName !== normalizedSpeaker) {
    await flushPendingSpeakerBatch('speaker-changed', tabId);
    startSpeakerBatch(wavB64, normalizedSpeaker, durationMs);
    return;
  }

  if (pending.totalDurationMs + durationMs > MAX_SPEAKER_BATCH_DURATION_MS) {
    await flushPendingSpeakerBatch('max-batch-duration', tabId);
    startSpeakerBatch(wavB64, normalizedSpeaker, durationMs);
    return;
  }

  pending.wavChunks.push(wavB64);
  pending.totalDurationMs += durationMs;
  console.info('[background] speaker batch appended:', normalizedSpeaker, `(${pending.totalDurationMs.toFixed(0)}ms total)`);
  scheduleSpeakerBatchFlush();
}

/**
 * content.js へメッセージを送る。
 * 「Receiving end does not exist」の場合は content.js を動的注入してリトライする。
 * 拡張機能の更新後に開いたままのタブでも確実に届くようにする。
 */
function getEmbeddedChatFrameId(tabId) {
  if (state.embeddedChatFrame?.tabId === tabId) {
    return state.embeddedChatFrame.frameId;
  }
  return null;
}

function rememberEmbeddedChatFrame(tabId, frameId) {
  if (!state.isActive || tabId !== state.tabId || !Number.isInteger(frameId) || frameId === 0) {
    return false;
  }
  state.embeddedChatFrame = { tabId, frameId };
  return true;
}

function clearEmbeddedChatFrame(tabId = null) {
  if (!state.embeddedChatFrame) return;
  if (tabId === null || state.embeddedChatFrame.tabId === tabId) {
    state.embeddedChatFrame = null;
  }
}

function tabsSendMessage(tabId, message, options = null) {
  return options ? chrome.tabs.sendMessage(tabId, message, options) : chrome.tabs.sendMessage(tabId, message);
}

async function sendToContentScript(tabId, message, options = null) {
  try {
    return await tabsSendMessage(tabId, message, options);
  } catch (err) {
    if (!err.message?.includes('Receiving end does not exist')) throw err;

    // content.js が未注入 → 動的注入してリトライ
    console.info('[background] content.js not found, injecting into tab', tabId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['shared.js', 'content.js'],
      });
      return await tabsSendMessage(tabId, message, options);
    } catch (injectErr) {
      console.warn('[background] content script injection failed:', injectErr.message);
      return null;
    }
  }
}

async function dispatchToContentScript(tabId, message) {
  const frameId = resolveContentScriptFrame(
    message.type,
    message.target,
    getEmbeddedChatFrameId(tabId)
  );
  const options = Number.isInteger(frameId) ? { frameId } : null;

  try {
    return await sendToContentScript(tabId, message, options);
  } catch (err) {
    if (message.target === 'embedded-chat' && Number.isInteger(frameId)) {
      clearEmbeddedChatFrame(tabId);
      return sendToContentScript(tabId, message);
    }
    throw err;
  }
}

async function getActiveSpeaker(tabId) {
  if (!tabId) return null;
  const response = await dispatchToContentScript(tabId, { type: 'GET_ACTIVE_SPEAKER' });
  return normalizeSpeakerName(response?.speakerName);
}

async function pushFeedbackContext(tabId, context) {
  if (!tabId) return null;
  return dispatchToContentScript(tabId, {
    type: 'UPDATE_FEEDBACK_CONTEXT',
    utteranceId: Number.isInteger(context.utteranceId) ? context.utteranceId : null,
    original: context.original || null,
    translation: context.translation || null,
    speakerName: context.speakerName || null,
  });
}

async function submitGlossaryFeedback(feedback) {
  const kind = feedback?.kind;
  const source = normalizeFeedbackText(feedback?.source);
  const target = normalizeFeedbackText(feedback?.target);
  if (!source || !target) {
    throw new Error('source and target are required');
  }

  let path;
  switch (kind) {
    case 'correction':
      path = '/glossary/corrections';
      break;
    case 'term':
      path = '/glossary/terms';
      break;
    default:
      throw new Error(`unknown feedback kind: ${String(kind)}`);
  }

  const cfg = await getSettings();
  const res = await fetch(`${cfg.serverUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source,
      target,
      description: buildGlossaryFeedbackDescription(feedback),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`server error ${res.status}: ${detail}`);
  }
  return res.json().catch(() => ({ status: 'ok' }));
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
  state.healthCheckFailures = 0;
  state.healthCheckInFlight = false;
  state.serverInfo = { whisperModel: health.whisperModel, llamaModel: health.llamaModel };
  state.pendingSpeakerBatch = null;
  state.embeddedChatFrame = null;
  state.audioQueue = Promise.resolve();
  state.translationTasks.clear();
  state.nextUtteranceId = 0;
  cancelSpeakerBatchFlush();

  // 定期ヘルスチェック（30 秒ごと）- サーバーが落ちたら自動停止
  state.healthCheckTimer = setInterval(() => {
    runPeriodicHealthCheck().catch((err) => {
      console.warn('[background] periodic health check failed unexpectedly:', err?.message ?? String(err));
    });
  }, HEALTH_CHECK_INTERVAL_MS);

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

  const tabId = state.tabId;

  // Tell the offscreen document to stop processing
  try {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_AUDIO' });
  } catch (_) {}

  await waitForQueuedAudioTasks();
  await flushPendingSpeakerBatch('stop', tabId);
  await waitForTranslationTasks();

  state.isActive = false;
  state.tabId = null;
  state.healthCheckFailures = 0;
  state.healthCheckInFlight = false;
  clearEmbeddedChatFrame(tabId);

  await closeOffscreenDocument();

  // Notify the content script that translation has stopped
  if (tabId) {
    try {
      await dispatchToContentScript(tabId, { type: 'TRANSLATION_STOPPED' });
    } catch (_) {}
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== SPEAKER_BATCH_ALARM) return;
  if (!state.pendingSpeakerBatch || !state.isActive) return;
  enqueueAudioTask(() => flushPendingSpeakerBatch('idle-timeout', state.tabId));
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

    case 'SUBMIT_GLOSSARY_FEEDBACK':
      submitGlossaryFeedback(message.feedback)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'REGISTER_EMBEDDED_CHAT_FRAME':
      let registered = false;
      if (sender.tab?.id && Number.isInteger(sender.frameId)) {
        registered = rememberEmbeddedChatFrame(sender.tab.id, sender.frameId);
      }
      sendResponse({ success: true, registered });
      return false;

    case 'RELAY_POST_TRANSLATION':
      if (!sender.tab?.id) {
        sendResponse({ success: false, error: 'active tab is unavailable' });
        return false;
      }
      dispatchToContentScript(sender.tab.id, {
        type: 'POST_TRANSLATION',
        text: message.text,
        target: 'embedded-chat',
      })
        .then((response) => {
          if (!response?.success) {
            throw new Error(response?.error || 'embedded Google Chat iframe is not ready');
          }
          sendResponse({ success: true });
        })
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    // ---- Log bridge from offscreen document -----------------------------
    case 'OFFSCREEN_LOG': {
      const fn = console[message.level] ?? console.info;
      fn('[offscreen→bg]', message.msg);
      return false;
    }

    // ---- Audio data from the offscreen document -------------------------
    case 'AUDIO_DATA': {
      console.info('[background] AUDIO_DATA received, isActive=', state.isActive,
        'wav_bytes(approx)=', message.wavB64 ? Math.round(message.wavB64.length * 0.75) : '?');
      if (!state.isActive) {
        console.warn('[background] AUDIO_DATA dropped: capture is not active');
        return false;
      }
      enqueueAudioTask(() => handleAudioData(message.wavB64));
      return false;
    }

    default:
      return false;
  }
});
