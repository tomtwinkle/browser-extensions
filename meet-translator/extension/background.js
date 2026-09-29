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
 *  5. Run local transcription and translation, then update the in-Meet overlay.
 *  5. Accept in-call glossary feedback from the Meet UI and upsert it to the server.
 */

'use strict';

importScripts('shared.js');

if (typeof chrome.storage.local.setAccessLevel === 'function') {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
}

const {
  base64ToUint8Array,
  buildGlossaryFeedbackDescription,
  detectTextLang,
  getWavDurationMs,
  isFillerOnly,
  mergeWavBase64Chunks,
  normalizeFeedbackText,
  normalizeLocalServerURL,
  normalizeSpeakerName,
  stripFillers,
} = globalThis.MeetTranslatorShared;

const SPEAKER_BATCH_IDLE_MS = 1200;
const MAX_SPEAKER_BATCH_DURATION_MS = 20000;
const MAX_AUDIO_QUEUE_PENDING_ITEMS = 4;
const MAX_AUDIO_QUEUE_PENDING_MS = 10_000;
const MAX_AUDIO_QUEUE_STALE_MS = 5_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const API_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONSECUTIVE_HEALTH_CHECK_FAILURES = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  isActive: false,
  isStarting: false,
  tabId: null,
  lastError: null,
  healthCheckTimer: null,
  healthCheckFailures: 0,
  healthCheckInFlight: false,
  serverInfo: null, // { whisperModel, llamaModel } – populated from /health
  sessionId: null,
  activeStreamIds: [],
  streamGenerations: { mic: 0, tab: 0 },
  pendingSpeakerBatches: new Map(),
  speakerBatchFlushTimer: null,
  audioQueue: Promise.resolve(),
  audioQueuePendingItems: 0,
  audioQueuePendingMs: 0,
  audioQueueStatus: { code: null, droppedCount: 0, droppedAudioMs: 0, updatedAtMs: null },
  offscreenPort: null,
  offscreenBootId: null,
  captionPersistQueue: Promise.resolve(),
  offscreenReadyWaiters: [],
  pendingCaptionRpcs: new Map(),
  captionPublicClients: new Set(),
  captionPrivateClients: new Set(),
  captionHeartbeatTimer: null,
};

function createSessionId() {
  return globalThis.crypto?.randomUUID?.()
    || `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isCurrentAudioMetadata(metadata, sessionId, streamGenerations) {
  return Boolean(
    metadata &&
    (metadata.streamId === 'mic' || metadata.streamId === 'tab') &&
    typeof metadata.sessionId === 'string' && metadata.sessionId === sessionId &&
    Number.isSafeInteger(metadata.streamGeneration) &&
    metadata.streamGeneration === streamGenerations?.[metadata.streamId]
  );
}

function postPortMessage(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch (_) {
    return false;
  }
}

function extensionPageKind(port) {
  const pageUrl = port?.sender?.url;
  if (typeof pageUrl !== 'string') return null;
  try {
    const url = new URL(pageUrl);
    const extensionUrl = new URL(chrome.runtime.getURL(''));
    if (url.protocol !== extensionUrl.protocol || url.host !== extensionUrl.host) return null;
    if (url.pathname.endsWith('/caption-presenter.html')) return 'public';
    if (url.pathname.endsWith('/sidepanel.html')) return 'private';
  } catch (_) {}
  return null;
}

async function waitForOffscreenPort(timeoutMs = 10_000) {
  if (state.offscreenPort) return state.offscreenPort;
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      state.offscreenReadyWaiters = state.offscreenReadyWaiters.filter((item) => item !== waiter);
      reject(new Error('offscreen document did not connect'));
    }, timeoutMs);
    state.offscreenReadyWaiters.push(waiter);
  });
}

async function captionStoreRequest(action, payload = {}) {
  await ensureOffscreenDocument();
  const port = await waitForOffscreenPort();
  const requestId = createSessionId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingCaptionRpcs.delete(requestId);
      reject(new Error(`caption store request timed out: ${action}`));
    }, 10_000);
    state.pendingCaptionRpcs.set(requestId, { resolve, reject, timer });
    if (!postPortMessage(port, { type: 'CAPTION_RPC', requestId, action, payload })) {
      clearTimeout(timer);
      state.pendingCaptionRpcs.delete(requestId);
      reject(new Error('offscreen connection was lost'));
    }
  });
}

function sendPrivateCaptionUpdate(record) {
  for (const port of state.captionPrivateClients) {
    if (!postPortMessage(port, { type: 'CAPTION_PRIVATE_RECORD', record })) state.captionPrivateClients.delete(port);
  }
}

function reportAudioQueueDrop(code, audioMs) {
  const status = state.audioQueueStatus;
  status.code = code;
  status.droppedCount += 1;
  status.droppedAudioMs += Math.round(audioMs);
  status.updatedAtMs = Date.now();
  const message = { type: 'CAPTION_QUEUE_STATUS', status: { ...status } };
  for (const port of state.captionPrivateClients) {
    if (!postPortMessage(port, message)) state.captionPrivateClients.delete(port);
  }
  return {
    accepted: false,
    code,
    droppedCount: 1,
    droppedAudioMs: Math.round(audioMs),
  };
}

function sendPublicCaptionEvent(event) {
  for (const port of state.captionPublicClients) {
    if (!postPortMessage(port, { type: 'CAPTION_PUBLIC_EVENT', event })) state.captionPublicClients.delete(port);
  }
}

function startCaptionHeartbeat() {
  if (state.captionHeartbeatTimer) return;
  state.captionHeartbeatTimer = setInterval(() => {
    for (const port of state.captionPublicClients) {
      if (!postPortMessage(port, { type: 'CAPTION_HEARTBEAT', at: Date.now() })) state.captionPublicClients.delete(port);
    }
  }, 1000);
}

function stopCaptionHeartbeatIfUnused() {
  if (state.captionPublicClients.size || !state.captionHeartbeatTimer) return;
  clearInterval(state.captionHeartbeatTimer);
  state.captionHeartbeatTimer = null;
}

function initializeOffscreenPort(port, message) {
  if (port !== state.offscreenPort || typeof message.bootId !== 'string' || !message.bootId) return;
  state.offscreenBootId = message.bootId;
  Promise.all([
    chrome.storage.session.get('captionStoreState'),
    chrome.storage.local.get(['publishMicrophoneCaptions']),
  ]).then(([sessionValues, localValues]) => {
    if (port !== state.offscreenPort || message.bootId !== state.offscreenBootId) return;
    const recovered = sessionValues?.captionStoreState && typeof sessionValues.captionStoreState === 'object'
      ? sessionValues.captionStoreState
      : {};
    const sameOffscreenDocument = recovered.offscreenBootId === message.bootId;
    postPortMessage(port, {
      type: sameOffscreenDocument ? 'OFFSCREEN_RECONNECT' : 'CAPTION_STORE_INIT',
      state: recovered,
      publishMicrophoneCaptions: localValues?.publishMicrophoneCaptions === true,
    });
  }).catch(() => {
    if (port !== state.offscreenPort || message.bootId !== state.offscreenBootId) return;
    postPortMessage(port, {
      type: 'CAPTION_STORE_INIT',
      state: {},
      publishMicrophoneCaptions: false,
    });
  });
}

function persistCaptionStateFromOffscreen(port, message) {
  if (port !== state.offscreenPort || message.bootId !== state.offscreenBootId ||
      typeof message.requestId !== 'string' || !message.state || typeof message.state !== 'object') return;
  const savedState = { ...message.state, offscreenBootId: message.bootId };
  const write = () => {
    if (port !== state.offscreenPort || message.bootId !== state.offscreenBootId) {
      throw new Error('offscreen document changed before state persistence');
    }
    return chrome.storage.session.set({ captionStoreState: savedState });
  };
  const pendingWrite = state.captionPersistQueue.catch(() => {}).then(write);
  state.captionPersistQueue = pendingWrite.catch(() => {});
  pendingWrite.then(() => {
    if (port === state.offscreenPort) {
      postPortMessage(port, { type: 'CAPTION_STORE_PERSISTED', requestId: message.requestId, ok: true });
    }
  }).catch(() => {
    if (port === state.offscreenPort) {
      postPortMessage(port, { type: 'CAPTION_STORE_PERSISTED', requestId: message.requestId, ok: false });
    }
  });
}

function scheduleHealthCheckTimer() {
  if (state.healthCheckTimer) return;
  state.healthCheckTimer = setInterval(() => {
    runPeriodicHealthCheck().catch((err) => {
      console.warn('[background] periodic health check failed unexpectedly:', err?.message ?? String(err));
    });
  }, HEALTH_CHECK_INTERVAL_MS);
}

function handleOffscreenPortMessage(port, message) {
  if (message?.type === 'OFFSCREEN_HELLO') {
    initializeOffscreenPort(port, message);
    return;
  }
  if (message?.type === 'CAPTION_STORE_PERSIST') {
    persistCaptionStateFromOffscreen(port, message);
    return;
  }
  if (message?.type === 'OFFSCREEN_LOG') {
    const fn = console[message.level] ?? console.info;
    fn('[offscreen→bg]', message.msg);
    return;
  }
  if (message?.type === 'CAPTION_RPC_RESULT') {
    const pending = state.pendingCaptionRpcs.get(message.requestId);
    if (!pending) return;
    state.pendingCaptionRpcs.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message.result);
    return;
  }

  if (message?.type === 'OFFSCREEN_STATE') {
    if (message.isActive && typeof message.sessionId === 'string') {
      state.isActive = true;
      state.tabId = message.tabId ?? null;
      state.sessionId = message.sessionId;
      state.activeStreamIds = Array.isArray(message.activeStreamIds) ? message.activeStreamIds : [];
      state.streamGenerations = message.streamGenerations || { mic: 0, tab: 0 };
      scheduleHealthCheckTimer();
    } else if (state.isActive) {
      const oldTabId = state.tabId;
      const oldSessionId = state.sessionId;
      state.isActive = false;
      state.sessionId = null;
      state.activeStreamIds = [];
      clearPendingSpeakerBatches();
      if (state.healthCheckTimer) clearInterval(state.healthCheckTimer);
      state.healthCheckTimer = null;
      if (oldTabId) dispatchToContentScript(oldTabId, { type: 'TRANSLATION_STOPPED', sessionId: oldSessionId }).catch(() => {});
      state.tabId = null;
    }
    return;
  }

  if (message?.type === 'CAPTION_PRIVATE_RECORD') {
    sendPrivateCaptionUpdate(message.record);
    return;
  }

  if (message?.type === 'CAPTION_PUBLIC_EVENT') {
    sendPublicCaptionEvent(message.event);
    if (message.event?.type === 'upsert' && state.isActive && state.tabId) {
      const record = message.event.record;
      const cfgPromise = getSettings();
      cfgPromise.then((cfg) => dispatchToContentScript(state.tabId, {
        type: 'SHOW_OVERLAY',
        original: cfg.overlayFormat === 'translation' ? null : record.sourceText,
        translation: cfg.overlayFormat === 'transcription' ? null : record.translations.find((item) => item.state === 'ready')?.text || null,
        scroll: cfg.overlayScroll,
        sessionId: message.event.sessionId,
        streamId: record.streamId,
        streamGeneration: state.streamGenerations[record.streamId],
      })).catch(() => {});
    } else if (message.event?.type === 'retract' || message.event?.type === 'session-ended') {
      if (state.tabId) dispatchToContentScript(state.tabId, {
        type: message.event.type === 'session-ended' ? 'TRANSLATION_STOPPED' : 'CLEAR_OVERLAY',
        sessionId: message.event.sessionId,
      }).catch(() => {});
    }
    return;
  }

  if (message?.type === 'AUDIO_DATA') {
    const audioMetadata = {
      sessionId: message.sessionId,
      streamId: message.streamId,
      streamGeneration: message.streamGeneration,
    };
    if (!state.isActive || !isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations) ||
        !shouldRequestTranscription(message.speechMs, message.evidence)) return;
    const audioMs = Number.isFinite(message.evidence?.utteranceDurationMs)
      ? message.evidence.utteranceDurationMs
      : message.speechMs;
    enqueueAudioTask((reservation) => handleAudioData(message, reservation), {
      audioMs,
      queuedAtMs: Date.now(),
    });
  }
}

async function handleCaptionClientMessage(port, kind, message) {
  if (kind !== 'private' || message?.type !== 'CAPTION_ACTION') return;
  const action = message.action;
  const payload = message.payload || {};
  let result;
  try {
    if (!['approve', 'correct', 'undo'].includes(action) || typeof payload.segmentId !== 'string') {
      throw new Error('invalid caption action');
    }
    result = await captionStoreRequest(action, payload);
    if (action === 'correct' && result?.ok && result.record?.translations?.length) {
      const translation = result.record.translations[0];
      try {
        const cfg = await getSettings();
        const translated = await enqueueAudioTask(() => translateOnly(
          result.record.sourceText,
          result.record.sourceLanguage,
          translation.targetLanguage,
          cfg
        ));
        const translationResult = await captionStoreRequest('set-translation', {
          segmentId: result.record.segmentId,
          sourceRevision: result.record.sourceRevision,
          targetLanguage: translation.targetLanguage,
          text: translated,
          state: translated ? 'ready' : 'failed',
          allowHistorical: true,
        });
        if (translationResult?.ok && translationResult.record) result.record = translationResult.record;
        else result.translationStale = true;
      } catch (_) {
        const translationResult = await captionStoreRequest('set-translation', {
          segmentId: result.record.segmentId,
          sourceRevision: result.record.sourceRevision,
          targetLanguage: translation.targetLanguage,
          text: null,
          state: 'failed',
          allowHistorical: true,
        }).catch(() => {});
        if (translationResult?.ok && translationResult.record) result.record = translationResult.record;
      }
    }
    postPortMessage(port, { type: 'CAPTION_ACTION_RESULT', requestId: message.requestId, action, result });
  } catch (err) {
    postPortMessage(port, {
      type: 'CAPTION_ACTION_RESULT',
      requestId: message.requestId,
      action,
      result: { ok: false, reason: err.message },
    });
  }
}

chrome.runtime.onConnect?.addListener?.((port) => {
  if (port.name === 'meet-translator-offscreen' && port.sender?.url === OFFSCREEN_URL) {
    state.offscreenPort = port;
    port.onMessage.addListener((message) => handleOffscreenPortMessage(port, message));
    port.onDisconnect.addListener(() => {
      if (state.offscreenPort === port) state.offscreenPort = null;
      for (const waiter of state.offscreenReadyWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('offscreen connection closed'));
      }
      for (const pending of state.pendingCaptionRpcs.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('offscreen connection closed'));
      }
      state.pendingCaptionRpcs.clear();
    });
    for (const waiter of state.offscreenReadyWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(port);
    }
    return;
  }

  const kind = extensionPageKind(port);
  if (!kind || (kind === 'public' && port.name !== 'caption-public') ||
      (kind === 'private' && port.name !== 'caption-private')) return;

  const clients = kind === 'public' ? state.captionPublicClients : state.captionPrivateClients;
  clients.add(port);
  if (kind === 'public') startCaptionHeartbeat();
  port.onDisconnect.addListener(() => {
    clients.delete(port);
    if (kind === 'public') stopCaptionHeartbeatIfUnused();
  });
  port.onMessage.addListener((message) => {
    if (kind === 'private') handleCaptionClientMessage(port, kind, message);
  });

  captionStoreRequest(kind === 'public' ? 'snapshot-public' : 'snapshot-private')
    .then((snapshot) => {
      if (kind === 'public') {
        postPortMessage(port, { type: 'CAPTION_PUBLIC_SNAPSHOT', event: snapshot?.event || null });
      } else {
        postPortMessage(port, {
          type: 'CAPTION_PRIVATE_SNAPSHOT',
          snapshot,
          queueStatus: { ...state.audioQueueStatus },
        });
      }
    })
    .catch(() => postPortMessage(port, { type: 'CAPTION_CONNECTION_ERROR' }));
});

chrome.storage.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, 'publishMicrophoneCaptions')) return;
  captionStoreRequest('set-mic-publication', {
    enabled: changes.publishMicrophoneCaptions.newValue === true,
  }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Transcription + Translation via local server
// ---------------------------------------------------------------------------

/** Load settings from chrome.storage.local with defaults. */
async function getSettings() {
  const defaults = {
    serverUrl:      'http://127.0.0.1:17070',
    apiToken:       '',
    sourceLang:     '',
    targetLang:     'ja',
    audioSource:    'mic-only',  // 'both' | 'mic-only' | 'tab-only'
    overlayEnabled: true,        // Meet 画面オーバーレイ表示（デフォルト有効）
    overlayFormat:  'both',      // 'both' | 'translation' | 'transcription'
    overlayScroll:  false,       // true=ニコニコ風スクロール / false=固定字幕
    bidirectional:  false,       // 双方向翻訳（発話言語を検出して翻訳方向を動的に決定）
    publishMicrophoneCaptions: false,
  };
  const stored = await chrome.storage.local.get(Object.keys(defaults));
  const settings = { ...defaults, ...stored };
  settings.serverUrl = normalizeLocalServerURL(settings.serverUrl) || settings.serverUrl;
  return settings;
}

function apiRequestHeaders(cfg, headers = {}) {
  if (!normalizeLocalServerURL(cfg?.serverUrl)) {
    throw new Error('server URL must use a loopback origin: http://localhost or http://127.0.0.1');
  }
  const requestHeaders = { ...headers };
  if (typeof cfg?.apiToken === 'string' && cfg.apiToken.length > 0) {
    requestHeaders.Authorization = `Bearer ${cfg.apiToken}`;
  }
  return requestHeaders;
}

async function fetchWithTimeout(url, options, timeoutMs = API_REQUEST_TIMEOUT_MS, consumeResponse = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return consumeResponse ? await consumeResponse(response) : response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * GET /health を叩いてサーバーの疎通とロード済みモデルを確認する。
 * AbortController + setTimeout を使い、AbortSignal.timeout が
 * 利用できない環境でも動作するよう実装する。
 * @returns {{ ok: boolean, whisperModel?: string, llamaModel?: string }}
 */
async function checkServerHealth() {
  const cfg = await getSettings();
  try {
    return await fetchWithTimeout(
      `${cfg.serverUrl}/health`,
      { headers: apiRequestHeaders(cfg) },
      HEALTH_CHECK_TIMEOUT_MS,
      async (res) => {
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
      }
    );
  } catch (err) {
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
 * @returns {Promise<{transcription: string, rawText: string, detectedLang: string|null, backend: string|null, segments: Array, qualityFlags: string[]}>}
 */
async function transcribeOnly(wavB64, cfg, speechMs = null, evidence = null) {
  // base64 → Uint8Array に変換。文字列は structured-clone で常に正しくコピーされる。
  const audioData = base64ToUint8Array(wavB64);
  const form = new FormData();
  form.append('audio', new Blob([audioData], { type: 'audio/wav' }), 'audio.wav');
  const transcriptionSourceLang = resolveTranscriptionSourceLang(cfg);
  if (transcriptionSourceLang) form.append('source_lang', transcriptionSourceLang);
  if (Number.isFinite(speechMs)) form.append('speech_ms', String(Math.round(speechMs)));
  if (evidence && typeof evidence === 'object') {
    if (typeof evidence.vadKind === 'string') form.append('vad_kind', evidence.vadKind);
    if (typeof evidence.speechDetected === 'boolean') form.append('speech_detected', String(evidence.speechDetected));
    if (Number.isFinite(evidence.clippingRatio)) form.append('clipping_ratio', String(evidence.clippingRatio));
    if (Number.isFinite(evidence.voicedDurationMs)) form.append('voiced_duration_ms', String(Math.round(evidence.voicedDurationMs)));
    if (Number.isFinite(evidence.utteranceDurationMs)) form.append('utterance_duration_ms', String(Math.round(evidence.utteranceDurationMs)));
  }

  console.info(
    '[background] transcribeOnly: POST',
    `${cfg.serverUrl}/transcribe`,
    '–',
    audioData.byteLength,
    'bytes',
    'source_lang=',
    transcriptionSourceLang || 'auto'
  );
  const { transcription, raw_text, detected_language, backend, segments, quality_flags } = await fetchWithTimeout(
    `${cfg.serverUrl}/transcribe`,
    { method: 'POST', headers: apiRequestHeaders(cfg), body: form },
    API_REQUEST_TIMEOUT_MS,
    async (res) => {
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`server error ${res.status}: ${detail}`);
      }
      return res.json();
    }
  );
  return {
    transcription: typeof transcription === 'string' ? transcription : '',
    rawText: typeof raw_text === 'string' ? raw_text : (typeof transcription === 'string' ? transcription : ''),
    detectedLang: detected_language || null,
    backend: backend || null,
    segments: Array.isArray(segments) ? segments : [],
    qualityFlags: Array.isArray(quality_flags) ? quality_flags.filter((flag) => typeof flag === 'string') : [],
  };
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
  const { translation } = await fetchWithTimeout(
    `${cfg.serverUrl}/translate`,
    {
      method: 'POST',
      headers: apiRequestHeaders(cfg, { 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: params,
    },
    API_REQUEST_TIMEOUT_MS,
    async (res) => {
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`server error ${res.status}: ${detail}`);
      }
      return res.json();
    }
  );
  return translation || null;
}

function normalizeLanguageCode(code) {
  return typeof code === 'string' ? code.trim().toLowerCase() : '';
}

function shouldRequestTranscription(speechMs, evidence = null) {
  return Number.isFinite(speechMs) && speechMs > 0 &&
    evidence?.vadKind === 'energy' && evidence.speechDetected === true &&
    Number.isFinite(evidence.voicedDurationMs) && evidence.voicedDurationMs > 0 &&
    Number.isFinite(evidence.utteranceDurationMs) && evidence.utteranceDurationMs >= evidence.voicedDurationMs &&
    Number.isFinite(evidence.clippingRatio) && evidence.clippingRatio >= 0 && evidence.clippingRatio <= 1;
}

function resolveTranscriptionSourceLang(cfg) {
  const sourceLang = normalizeLanguageCode(cfg?.sourceLang);
  const targetLang = normalizeLanguageCode(cfg?.targetLang);
  if (!sourceLang) return '';

  // 双方向翻訳では source/target の両方が発話候補になるため、
  // Whisper には固定言語を渡さず音声から判定させる。
  if (cfg?.bidirectional && targetLang && targetLang !== sourceLang) {
    return '';
  }
  return sourceLang;
}

function resolveExpectedSpeechLanguages(cfg) {
  const sourceLang = normalizeLanguageCode(cfg?.sourceLang);
  const targetLang = normalizeLanguageCode(cfg?.targetLang);
  if (!sourceLang) return [];
  if (cfg?.bidirectional && targetLang && targetLang !== sourceLang) {
    return [sourceLang, targetLang];
  }
  return [sourceLang];
}

function resolveTranscriptLanguage(cfg, transcription, detectedLang) {
  const expectedLanguages = resolveExpectedSpeechLanguages(cfg);
  const normalizedDetectedLang = normalizeLanguageCode(detectedLang);
  const textLang = normalizeLanguageCode(detectTextLang(transcription));

  if (expectedLanguages.length === 0) {
    return {
      accepted: true,
      language: normalizedDetectedLang || textLang || null,
      textLang: textLang || null,
    };
  }

  for (const lang of [normalizedDetectedLang, textLang]) {
    if (lang && expectedLanguages.includes(lang)) {
      return {
        accepted: true,
        language: lang,
        textLang: textLang || null,
      };
    }
  }

  const unexpectedLanguages = [...new Set([normalizedDetectedLang, textLang].filter(Boolean))];
  if (unexpectedLanguages.length > 0) {
    return {
      accepted: false,
      language: null,
      textLang: textLang || null,
      reason: `unexpected language ${unexpectedLanguages.join('/')}`,
    };
  }

  return {
    accepted: true,
    language: expectedLanguages[0],
    textLang: textLang || null,
  };
}


function scheduleSpeakerBatchFlush(delayMs = SPEAKER_BATCH_IDLE_MS) {
  cancelSpeakerBatchFlush();
  state.speakerBatchFlushTimer = setTimeout(() => {
    state.speakerBatchFlushTimer = null;
    if (state.pendingSpeakerBatches.size === 0 || !state.isActive) return;
    enqueueAudioTask(() => flushPendingSpeakerBatch('idle-timeout', state.tabId));
  }, delayMs);
}

function cancelSpeakerBatchFlush() {
  if (state.speakerBatchFlushTimer !== null) clearTimeout(state.speakerBatchFlushTimer);
  state.speakerBatchFlushTimer = null;
}

function retainAudioQueueReservation(reservation) {
  if (reservation && !reservation.released) reservation.retained = true;
}

function releaseAudioQueueReservation(reservation) {
  if (!reservation || reservation.released) return;
  reservation.released = true;
  state.audioQueuePendingItems = Math.max(0, state.audioQueuePendingItems - 1);
  state.audioQueuePendingMs = Math.max(0, state.audioQueuePendingMs - reservation.audioMs);
}

function clearPendingSpeakerBatches() {
  for (const batch of state.pendingSpeakerBatches.values()) {
    for (const chunk of batch.chunks) releaseAudioQueueReservation(chunk.audioReservation);
  }
  state.pendingSpeakerBatches.clear();
  cancelSpeakerBatchFlush();
}

function appendSpeakerBatchChunk(batch, wavB64, speechMs, audioReservation) {
  retainAudioQueueReservation(audioReservation);
  batch.chunks.push({ wavB64, speechMs, audioReservation });
  batch.totalSpeechMs += speechMs;
  batch.totalReservedAudioMs += audioReservation?.audioMs || 0;
  batch.oldestQueuedAtMs = Math.min(batch.oldestQueuedAtMs, audioReservation?.queuedAtMs ?? Date.now());
}

function startSpeakerBatch(wavB64, speakerName, durationMs, speechMs, audioMetadata, audioReservation = null) {
  const key = JSON.stringify([
    audioMetadata.streamId,
    audioMetadata.streamGeneration,
    speakerName,
  ]);
  const batch = {
    speakerName,
    audioMetadata,
    chunks: [],
    totalDurationMs: durationMs,
    totalSpeechMs: 0,
    totalReservedAudioMs: 0,
    oldestQueuedAtMs: audioReservation?.queuedAtMs ?? Date.now(),
  };
  appendSpeakerBatchChunk(batch, wavB64, speechMs, audioReservation);
  state.pendingSpeakerBatches.set(key, batch);
  scheduleSpeakerBatchFlush();
}

function enqueueAudioTask(task, options = {}) {
  const audioMs = Number.isFinite(options.audioMs) ? Math.max(0, options.audioMs) : 0;
  const queuedAtMs = Number.isFinite(options.queuedAtMs) ? options.queuedAtMs : Date.now();
  const reservesAudio = audioMs > 0;
  if (reservesAudio) {
    if (Date.now() - queuedAtMs > MAX_AUDIO_QUEUE_STALE_MS) {
      return Promise.resolve(reportAudioQueueDrop('STALE', audioMs));
    }
    if (state.audioQueuePendingItems + 1 > MAX_AUDIO_QUEUE_PENDING_ITEMS ||
        state.audioQueuePendingMs + audioMs > MAX_AUDIO_QUEUE_PENDING_MS) {
      return Promise.resolve(reportAudioQueueDrop('OVERLOAD', audioMs));
    }
    state.audioQueuePendingItems += 1;
    state.audioQueuePendingMs += audioMs;
  }

  const reservation = reservesAudio
    ? { audioMs, queuedAtMs, retained: false, released: false }
    : null;

  const next = state.audioQueue.then(async () => {
    if (reservesAudio && Date.now() - queuedAtMs > MAX_AUDIO_QUEUE_STALE_MS) {
      return reportAudioQueueDrop('STALE', audioMs);
    }
    return await task(reservation);
  }).finally(() => {
    if (!reservation?.retained) releaseAudioQueueReservation(reservation);
  });
  state.audioQueue = next.catch((err) => {
    console.error('[background] audio processing error:', err);
  });
  return next;
}

async function processAudioChunk(wavB64, speakerName, tabId, speechMs = null, audioMetadata = null) {
  // Live audio is accepted only with the active session and stream generation.
  // This also prevents legacy callers from publishing an untracked result.
  if (!audioMetadata) return;
  if (audioMetadata && !isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;
  const effectiveSpeechMs = Number.isFinite(speechMs) ? speechMs : getWavDurationMs(wavB64);
  const canRequestTranscription = audioMetadata
    ? shouldRequestTranscription(effectiveSpeechMs, audioMetadata.evidence)
    : Number.isFinite(effectiveSpeechMs) && effectiveSpeechMs > 0;
  if (!canRequestTranscription) {
    console.info(
      '[background] short utterance, skipping transcription request:',
      `${effectiveSpeechMs.toFixed(0)}ms speech`
    );
    return;
  }

  const cfg = await getSettings();

  // Step 1: ASR. Keep all candidate text private until host approval, including
  // text marked by model-specific or text-only diagnostics.
  const asr = await transcribeOnly(wavB64, cfg, effectiveSpeechMs, audioMetadata.evidence);
  if (audioMetadata && !isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;
  const transcription = asr.transcription;
  const rawText = asr.rawText;
  const reasonCodes = [...new Set(['INSUFFICIENT_EVIDENCE', ...asr.qualityFlags])];
  if (isFillerOnly(transcription)) reasonCodes.push('FILLER_ONLY');
  if (!transcription && audioMetadata.evidence?.speechDetected === true) reasonCodes.push('EMPTY_WITH_SPEECH');
  if (!transcription && audioMetadata.evidence?.speechDetected !== true) return;
  if (asr.segments.length > 128) reasonCodes.push('ASR_SEGMENTS_TRUNCATED');
  const asrSegments = asr.segments.slice(0, 128).map((segment) => ({
    startMs: Number.isFinite(segment.start_ms) ? segment.start_ms : null,
    endMs: Number.isFinite(segment.end_ms) ? segment.end_ms : null,
    avgLogprob: Number.isFinite(segment.avg_logprob) ? segment.avg_logprob : null,
    noSpeechProbability: Number.isFinite(segment.no_speech_probability) ? segment.no_speech_probability : null,
  }));

  const languageResolution = resolveTranscriptLanguage(cfg, transcription, asr.detectedLang);
  if (!languageResolution.accepted) {
    reasonCodes.push('LANGUAGE_MISMATCH');
    console.info('[background] unexpected transcription language; retaining private candidate:', languageResolution.reason);
  }

  const configuredSourceLang = normalizeLanguageCode(cfg.sourceLang);
  const configuredTargetLang = normalizeLanguageCode(cfg.targetLang);
  const effectiveDetectedLang = languageResolution.language;

  // 双方向翻訳: Whisper 検出言語を優先し、未取得時は文字種フォールバック
  let translSourceLang = languageResolution.accepted ? (effectiveDetectedLang || configuredSourceLang) : null;
  let translTargetLang = configuredTargetLang;
  if (languageResolution.accepted && cfg.bidirectional && configuredSourceLang && configuredTargetLang) {
    if (effectiveDetectedLang && effectiveDetectedLang === configuredTargetLang) {
      // 翻訳先言語で発話 → 逆方向に翻訳
      translSourceLang = configuredTargetLang;
      translTargetLang = configuredSourceLang;
      console.info(
        '[background] bidirectional: detected',
        effectiveDetectedLang,
        '→ translating to',
        translTargetLang
      );
    } else {
      translSourceLang = configuredSourceLang;
      translTargetLang = configuredTargetLang;
    }
  }

  // フィラー除去後のテキストを翻訳に使う
  const textToTranslate = stripFillers(transcription);
  await pushFeedbackContext(tabId, {
    original: transcription,
    translation: null,
    speakerName,
  }, audioMetadata);
  if (audioMetadata && !isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;

  const needTranslation = Boolean(languageResolution.accepted && textToTranslate && cfg.overlayFormat !== 'transcription');
  const segmentId = createSessionId();
  const translationEntry = needTranslation
    ? [{ targetLanguage: translTargetLang, sourceRevision: 1, state: 'pending', text: null }]
    : [];
  const candidate = {
    sessionId: audioMetadata.sessionId,
    streamId: audioMetadata.streamId,
    streamGeneration: audioMetadata.streamGeneration,
    segmentId,
    startMs: null,
    endMs: null,
    rawText,
    sourceText: transcription,
    sourceLanguage: translSourceLang || null,
    translations: translationEntry,
    reasonCodes: [...new Set(reasonCodes)],
    evidence: {
      ...audioMetadata.evidence,
      asrBackend: asr.backend,
      asrSegments,
      qualityFlags: [...new Set(reasonCodes)],
    },
  };
  const stored = await captionStoreRequest('upsert-candidate', { candidate });
  if (!stored?.ok || !isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;

  if (!needTranslation) return;
  try {
    const translation = await translateOnly(textToTranslate, translSourceLang, translTargetLang, cfg);
    if (!isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;
    await captionStoreRequest('set-translation', {
      segmentId,
      sourceRevision: 1,
      targetLanguage: translTargetLang,
      text: translation,
      state: translation ? 'ready' : 'failed',
    });
  } catch (_) {
    if (!isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;
    await captionStoreRequest('set-translation', {
      segmentId,
      sourceRevision: 1,
      targetLanguage: translTargetLang,
      text: null,
      state: 'failed',
    }).catch(() => {});
  }
}

async function flushPendingSpeakerBatch(reason, tabId = state.tabId, streamId = null) {
  const batches = [...state.pendingSpeakerBatches.entries()].filter(([, batch]) =>
    !streamId || batch.audioMetadata.streamId === streamId
  );
  if (batches.length === 0) return false;

  for (const [key, batch] of batches) state.pendingSpeakerBatches.delete(key);
  if (state.pendingSpeakerBatches.size === 0) cancelSpeakerBatchFlush();

  for (const [, batch] of batches) {
    const { audioMetadata } = batch;
    try {
      if (Date.now() - batch.oldestQueuedAtMs > MAX_AUDIO_QUEUE_STALE_MS) {
        reportAudioQueueDrop('STALE', batch.totalReservedAudioMs || batch.totalDurationMs);
        continue;
      }

      if (batch.chunks.length === 1) {
        await processAudioChunk(batch.chunks[0].wavB64, batch.speakerName, tabId, batch.totalSpeechMs, audioMetadata);
        continue;
      }

      try {
        const mergedWavB64 = mergeWavBase64Chunks(batch.chunks.map((chunk) => chunk.wavB64));
        await processAudioChunk(mergedWavB64, batch.speakerName, tabId, batch.totalSpeechMs, audioMetadata);
      } catch (err) {
        console.warn('[background] speaker batch merge failed, replaying individual chunks:', err.message);
        for (const chunk of batch.chunks) {
          await processAudioChunk(chunk.wavB64, batch.speakerName, tabId, chunk.speechMs, audioMetadata);
        }
      }
    } catch (err) {
      console.error('[background] speaker batch processing failed:', err);
    } finally {
      for (const chunk of batch.chunks) releaseAudioQueueReservation(chunk.audioReservation);
    }
  }
  return true;
}

async function handleAudioData(audioChunk, audioReservation = null) {
  const wavB64 = typeof audioChunk === 'string' ? audioChunk : audioChunk?.wavB64;
  if (!wavB64) return;

  const audioMetadata = {
    sessionId: audioChunk?.sessionId,
    streamId: audioChunk?.streamId,
    streamGeneration: audioChunk?.streamGeneration,
    evidence: audioChunk?.evidence,
  };
  if (!isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;

  const tabId = state.tabId;
  const speakerName = audioMetadata.streamId === 'tab' ? await getActiveSpeaker(tabId) : null;
  if (!isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;
  const normalizedSpeaker = normalizeSpeakerName(speakerName);
  const durationMs = getWavDurationMs(wavB64);
  const speechMs = Number.isFinite(audioChunk?.speechMs) ? audioChunk.speechMs : durationMs;
  if (!shouldRequestTranscription(speechMs, audioMetadata.evidence)) return;

  if (!normalizedSpeaker) {
    await flushPendingSpeakerBatch('speaker-unavailable', tabId, audioMetadata.streamId);
    await processAudioChunk(wavB64, null, tabId, speechMs, audioMetadata);
    return;
  }

  if (durationMs >= MAX_SPEAKER_BATCH_DURATION_MS) {
    await flushPendingSpeakerBatch('oversized-single-chunk', tabId, audioMetadata.streamId);
    await processAudioChunk(wavB64, normalizedSpeaker, tabId, speechMs, audioMetadata);
    return;
  }

  const pendingEntry = [...state.pendingSpeakerBatches.entries()].find(([, batch]) =>
    batch.audioMetadata.streamId === audioMetadata.streamId
  );
  const pending = pendingEntry?.[1];
  if (!pending) {
    startSpeakerBatch(wavB64, normalizedSpeaker, durationMs, speechMs, audioMetadata, audioReservation);
    return;
  }

  if (pending.speakerName !== normalizedSpeaker) {
    await flushPendingSpeakerBatch('speaker-changed', tabId, audioMetadata.streamId);
    startSpeakerBatch(wavB64, normalizedSpeaker, durationMs, speechMs, audioMetadata, audioReservation);
    return;
  }

  if (pending.totalDurationMs + durationMs > MAX_SPEAKER_BATCH_DURATION_MS) {
    await flushPendingSpeakerBatch('max-batch-duration', tabId, audioMetadata.streamId);
    startSpeakerBatch(wavB64, normalizedSpeaker, durationMs, speechMs, audioMetadata, audioReservation);
    return;
  }

  appendSpeakerBatchChunk(pending, wavB64, speechMs, audioReservation);
  pending.totalDurationMs += durationMs;
  scheduleSpeakerBatchFlush();
}

/**
 * content.js へメッセージを送る。
 * 「Receiving end does not exist」の場合は content.js を動的注入してリトライする。
 * 拡張機能の更新後に開いたままのタブでも確実に届くようにする。
 */
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
  return sendToContentScript(tabId, message);
}

async function getActiveSpeaker(tabId) {
  if (!tabId) return null;
  const response = await dispatchToContentScript(tabId, { type: 'GET_ACTIVE_SPEAKER' });
  return normalizeSpeakerName(response?.speakerName);
}

async function pushFeedbackContext(tabId, context, audioMetadata = null) {
  if (!tabId) return null;
  return dispatchToContentScript(tabId, {
    type: 'UPDATE_FEEDBACK_CONTEXT',
    original: context.original || null,
    translation: context.translation || null,
    speakerName: context.speakerName || null,
    sessionId: audioMetadata?.sessionId,
    streamId: audioMetadata?.streamId,
    streamGeneration: audioMetadata?.streamGeneration,
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
    headers: apiRequestHeaders(cfg, { 'Content-Type': 'application/json' }),
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
    justification: 'Google Meet 音声の処理と字幕セッション状態を保持するため',
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
  if (state.isStarting) throw new Error('字幕の開始処理中です。しばらく待ってから再試行してください。');
  if (state.isActive) return;
  state.isStarting = true;

  let sessionId = null;
  let activeStreamIds = [];
  let startAudioRequested = false;
  try {
    // サーバー疎通確認 – 接続できなければ開始を拒否
    const health = await checkServerHealth();
    if (!health.ok) {
      throw new Error('サーバーに接続できません。サーバーが起動しているか確認してください。');
    }

    const cfg = await getSettings();
    activeStreamIds = cfg.audioSource === 'mic-only'
      ? ['mic']
      : cfg.audioSource === 'tab-only'
        ? ['tab']
        : ['mic', 'tab'];
    sessionId = createSessionId();
    state.sessionId = sessionId;
    state.activeStreamIds = activeStreamIds;
    for (const streamId of activeStreamIds) state.streamGenerations[streamId] += 1;
    const streamGenerations = { ...state.streamGenerations };

    state.isActive = false;
    state.tabId = tabId;
    state.lastError = null;
    state.healthCheckFailures = 0;
    state.healthCheckInFlight = false;
    state.serverInfo = { whisperModel: health.whisperModel, llamaModel: health.llamaModel };
    clearPendingSpeakerBatches();
    state.audioQueueStatus = { code: null, droppedCount: 0, droppedAudioMs: 0, updatedAtMs: null };

    // Make sure the offscreen document is ready for audio processing
    await ensureOffscreenDocument();

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

    startAudioRequested = true;
    const startResult = await captionStoreRequest('start-audio', {
      streamId,
      audioSource: cfg.audioSource,
      sessionId,
      streamGenerations,
      tabId,
      publishMicrophoneCaptions: cfg.publishMicrophoneCaptions === true,
    });
    if (!startResult?.ok) throw new Error(startResult?.reason || 'offscreen audio start failed');
    state.isActive = true;
    scheduleHealthCheckTimer();
    console.info('[background] offscreen audio started; source=', cfg.audioSource);
    await dispatchToContentScript(tabId, {
      type: 'TRANSLATION_STARTED',
      sessionId,
      streamGenerations,
    });
    console.info('[background] startCapture: audio capture started, tabId=', tabId);
  } catch (err) {
    console.error('[background] startCapture failed:', err);
    if (sessionId && state.sessionId === sessionId) {
      state.isActive = false;
      for (const streamId of activeStreamIds) state.streamGenerations[streamId] += 1;
      state.activeStreamIds = [];
      clearPendingSpeakerBatches();
      if (state.healthCheckTimer) clearInterval(state.healthCheckTimer);
      state.healthCheckTimer = null;
      if (startAudioRequested) await captionStoreRequest('stop-audio').catch(() => {});
      state.sessionId = null;
      state.tabId = null;
    }
    throw err; // popup にエラーを伝える
  } finally {
    state.isStarting = false;
  }
}

async function stopCapture() {
  if (!state.isActive) return;

  const tabId = state.tabId;
  const sessionId = state.sessionId;
  state.isActive = false;
  for (const streamId of state.activeStreamIds) state.streamGenerations[streamId] += 1;
  state.activeStreamIds = [];
  state.sessionId = null;
  clearPendingSpeakerBatches();

  // 定期ヘルスチェックを停止
  if (state.healthCheckTimer) {
    clearInterval(state.healthCheckTimer);
    state.healthCheckTimer = null;
  }

  try {
    await captionStoreRequest('stop-audio');
  } catch (_) {}

  await state.audioQueue;

  state.tabId = null;
  state.healthCheckFailures = 0;
  state.healthCheckInFlight = false;
  // Notify the content script that translation has stopped
  if (tabId) {
    try {
      await dispatchToContentScript(tabId, { type: 'TRANSLATION_STOPPED', sessionId });
    } catch (_) {}
  }
}

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

    default:
      return false;
  }
});
