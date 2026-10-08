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

importScripts('shared.js', 'evaluation-telemetry.js', 'load-control.js');

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
const MAX_PENDING_TRANSLATION_ITEMS = 8;
const MAX_PENDING_CORRECTION_LANE_CALLBACKS = MAX_PENDING_TRANSLATION_ITEMS;
const MAX_TRANSLATION_WAIT_MS = 3_000;
const MAX_TRANSLATION_AUDIO_AGE_MS = 8_000;
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
  audioQueuePendingTasks: 0,
  audioQueueEntries: [],
  audioQueuePendingItems: 0,
  audioQueuePendingMs: 0,
  audioQueueStatus: { code: null, droppedCount: 0, droppedAudioMs: 0, updatedAtMs: null },
  translationQueue: [],
  translationQueueActive: null,
  correctionLanePendingCallbacks: 0,
  translationQueueStatus: { code: null, droppedCount: 0, heldCount: 0, rejectedCount: 0, updatedAtMs: null },
  evaluationRunId: null,
  evaluationObservedConfigId: null,
  loadControlController: null,
  loadControlTimer: null,
  translationPaused: false,
  inferenceAdmissionStopped: false,
  asrAdmissionStopped: false,
  memoryStatus: { pressure: 'unknown', processGroupMemoryGiB: null, sourceAvailable: false },
  offscreenPort: null,
  offscreenBootId: null,
  captionPersistQueue: Promise.resolve(),
  offscreenReadyWaiters: [],
  pendingCaptionRpcs: new Map(),
  captionPublicClients: new Set(),
  captionPrivateClients: new Set(),
  captionHeartbeatTimer: null,
};

const evaluationTelemetry = globalThis.MeetTranslatorEvaluationTelemetry.createEvaluationTelemetry({
  storage: chrome.storage.session || null,
});
state.evaluationTelemetry = evaluationTelemetry;
const evaluationTelemetryReady = evaluationTelemetry.restore().then(() => {
  const snapshot = evaluationTelemetry.snapshot();
  if (!snapshot.activeRunId) return;
  state.evaluationRunId = snapshot.activeRunId;
  const runStarted = [...snapshot.events].reverse().find((event) =>
    event.type === 'run_started' && event.runId === snapshot.activeRunId
  );
  if (runStarted) {
    state.sessionId = runStarted.sessionId || state.sessionId;
    state.evaluationObservedConfigId = runStarted.observedConfigId || null;
  }
});
state.evaluationTelemetryReady = evaluationTelemetryReady;

function evaluationObservedConfigId(settings, serverInfo = state.serverInfo) {
  return globalThis.MeetTranslatorEvaluationTelemetry.configurationId({
    asrModel: serverInfo?.whisperModel || null,
    translationModel: settings?.llamaModel || serverInfo?.llamaModel || null,
    sourceLang: settings?.sourceLang || null,
    targetLang: settings?.targetLang || null,
    bidirectional: settings?.bidirectional === true,
    decodeOptions: settings?.llamaOptions || settings?.decodeOptions || null,
    runtimeRevision: settings?.runtimeRevision || null,
    quantization: settings?.quantization || null,
    templateId: settings?.templateId || null,
    publicationGateId: settings?.publicationGateId || null,
    asrHintsMode: settings?.asrHintsMode || 'off',
  });
}

function recordEvaluationEvent(type, fields = {}) {
  if (!state.evaluationRunId) return null;
  return evaluationTelemetry.record(type, {
    sessionId: state.sessionId,
    observedConfigId: state.evaluationObservedConfigId,
    configCoverage: 'partial',
    ...fields,
  });
}

function loadControlStatus() {
  const status = state.loadControlController?.snapshot() || {
    experimentsStopped: false,
    translationsPaused: state.translationPaused,
    inferenceBlocked: state.inferenceAdmissionStopped,
    stopAsr: state.asrAdmissionStopped,
    resumeEligible: false,
    requeueOldTranslations: false,
  };
  return {
    ...status,
    memoryPressure: state.memoryStatus.pressure,
    processGroupMemoryGiB: state.memoryStatus.processGroupMemoryGiB,
    memorySourceAvailable: state.memoryStatus.sourceAvailable,
    queueSource: 'extension_audio_admission',
  };
}

function broadcastLoadControlStatus() {
  const message = { type: 'CAPTION_LOAD_CONTROL_STATUS', status: loadControlStatus() };
  for (const port of state.captionPrivateClients) {
    if (!postPortMessage(port, message)) state.captionPrivateClients.delete(port);
  }
}

function stopLoadControlSampling() {
  if (!state.loadControlTimer) return;
  clearInterval(state.loadControlTimer);
  state.loadControlTimer = null;
}

function reportTranslationHeld(job, reason) {
  const status = state.translationQueueStatus;
  status.code = 'TRANSLATION_PAUSED';
  status.heldCount = (status.heldCount || 0) + 1;
  status.updatedAtMs = Date.now();
  recordEvaluationEvent('translation_held', {
    caseId: job.segmentId,
    sessionId: job.sessionId,
    streamId: job.streamId,
    streamGeneration: job.streamGeneration,
    observedConfigId: job.observedConfigId,
    configCoverage: 'partial',
    queueName: 'translation',
    queueLength: state.translationQueue.length,
    reason,
    outcome: 'held',
  });
  const message = { type: 'CAPTION_TRANSLATION_QUEUE_STATUS', status: { ...status } };
  for (const port of state.captionPrivateClients) {
    if (!postPortMessage(port, message)) state.captionPrivateClients.delete(port);
  }
}

function reportTranslationAdmissionRejected(job, reason) {
  const status = state.translationQueueStatus;
  status.code = 'TRANSLATION_PAUSED';
  status.rejectedCount = (status.rejectedCount || 0) + 1;
  status.updatedAtMs = Date.now();
  recordEvaluationEvent('translation_admission_rejected', {
    caseId: job.segmentId,
    sessionId: job.sessionId,
    streamId: job.streamId,
    streamGeneration: job.streamGeneration,
    observedConfigId: job.observedConfigId,
    configCoverage: 'partial',
    queueName: 'translation',
    queueLength: state.translationQueue.length,
    reason,
    outcome: 'rejected',
  });
  const message = { type: 'CAPTION_TRANSLATION_QUEUE_STATUS', status: { ...status } };
  for (const port of state.captionPrivateClients) {
    if (!postPortMessage(port, message)) state.captionPrivateClients.delete(port);
  }
}

function pausePendingTranslations(reason) {
  const pending = state.translationQueue.slice();
  state.translationQueue = [];
  for (const job of pending) {
    reportTranslationHeld(job, reason);
    failTranslationJob(job, translationQueueError('TRANSLATION_PAUSED', 'load-control'), { report: false });
  }
}

function applyLoadControlResult(result) {
  if (!result) return;
  const transition = result.transition || null;
  const memoryLimited = ['critical_memory_pressure', 'process_group_memory_limit'].includes(transition);

  if (result.inferenceBlocked) state.inferenceAdmissionStopped = true;
  if (result.stopAsr) state.asrAdmissionStopped = true;

  if (result.resumed && transition === 'user_resume') {
    state.translationPaused = false;
    state.inferenceAdmissionStopped = false;
    state.asrAdmissionStopped = false;
    recordEvaluationEvent('translation_resumed', { reason: 'USER_RESUME', outcome: 'resumed' });
  } else if (result.translationsPaused || memoryLimited) {
    const reason = memoryLimited || result.inferenceBlocked ? 'MEMORY_PRESSURE' : 'QUEUE_WAIT';
    if (!state.translationPaused) {
      state.translationPaused = true;
      pausePendingTranslations(reason);
      recordEvaluationEvent('translation_paused', { reason, outcome: 'paused' });
    }
  }

  if (transition) {
    recordEvaluationEvent('load_control_transition', {
      reason: transition.toUpperCase(),
      outcome: transition,
    });
  }
  if (transition === 'stop_experiments_and_diagnostics') {
    recordEvaluationEvent('adaptive_work_stopped', { reason: 'QUEUE_WAIT', outcome: 'stopped' });
    if (state.isActive && !state.loadControlTimer) state.loadControlTimer = setInterval(runLoadControlSample, 1_000);
  }
  if (result.releaseTranslationModel) {
    // Neither process-group memory sensing nor a safe native model-release API
    // is available to this extension. Record that the requested effect is blocked.
    recordEvaluationEvent('inference_rejected', { reason: 'MODEL_RELEASE_API_UNAVAILABLE' });
  }
  if (transition === 'memory_recovery_ready') {
    recordEvaluationEvent('memory_recovery_ready', { reason: 'RECOVERY_CONDITIONS_MET' });
  }
  broadcastLoadControlStatus();
}

function runLoadControlSample() {
  const nowMs = Date.now();
  const oldest = state.audioQueueEntries.find((entry) => entry.queueKind === 'asr');
  const oldestAudio = state.audioQueueEntries[0];
  const queueWaitMs = oldestAudio ? Math.max(0, nowMs - oldestAudio.queuedAtMs) : 0;
  const asrQueueWaitMs = oldest ? Math.max(0, nowMs - oldest.queuedAtMs) : 0;
  const result = state.loadControlController?.sample({
    nowMs,
    queueWaitMs,
    asrQueueWaitMs,
    memoryPressure: state.memoryStatus.pressure,
    processGroupMemoryGiB: state.memoryStatus.processGroupMemoryGiB,
  });
  if (result?.transition) applyLoadControlResult(result);
  else if (result?.inferenceBlocked || result?.stopAsr) applyLoadControlResult(result);
  else broadcastLoadControlStatus();
}

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

function reportAudioQueueDrop(code, audioMs, metadata = {}) {
  const status = state.audioQueueStatus;
  status.code = code;
  status.droppedCount += 1;
  status.droppedAudioMs += Math.round(audioMs);
  status.updatedAtMs = Date.now();
  recordEvaluationEvent('audio_dropped', {
    ...metadata,
    queueName: 'audio',
    queueLength: state.audioQueuePendingTasks,
    audioDurationMs: Math.round(audioMs),
    droppedCount: status.droppedCount,
    droppedAudioMs: status.droppedAudioMs,
    reason: code,
  });
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

function reportTranslationQueueDrop(code, metadata = {}) {
  const status = state.translationQueueStatus;
  status.code = code;
  status.droppedCount += 1;
  status.updatedAtMs = Date.now();
    recordEvaluationEvent('translation_dropped', {
    ...metadata,
    queueName: 'translation',
    queueLength: state.translationQueue.length,
    droppedCount: status.droppedCount,
    reason: metadata.reason || code,
  });
  const message = { type: 'CAPTION_TRANSLATION_QUEUE_STATUS', status: { ...status } };
  for (const port of state.captionPrivateClients) {
    if (!postPortMessage(port, message)) state.captionPrivateClients.delete(port);
  }
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

function audioSessionDiscardReason(metadata) {
  if (!state.isActive) return 'SESSION_INACTIVE';
  if (metadata.streamId !== 'mic' && metadata.streamId !== 'tab') return 'INVALID_STREAM';
  if (metadata.sessionId !== state.sessionId) return 'STALE_SESSION';
  if (!Number.isSafeInteger(metadata.streamGeneration) ||
      metadata.streamGeneration !== state.streamGenerations[metadata.streamId]) return 'STALE_GENERATION';
  return null;
}

function audioDiscardReason(message) {
  const metadata = message && typeof message === 'object' ? message : {};
  const sessionReason = audioSessionDiscardReason(metadata);
  if (sessionReason) return sessionReason;
  if (state.asrAdmissionStopped) return 'ASR_STOPPED_MEMORY_PRESSURE';
  const evidence = metadata.evidence;
  if (!evidence || evidence.vadKind !== 'energy' ||
      !Number.isFinite(evidence.voicedDurationMs) || !Number.isFinite(evidence.utteranceDurationMs) ||
      !Number.isFinite(evidence.clippingRatio) || evidence.clippingRatio < 0 || evidence.clippingRatio > 1) {
    return 'INVALID_VAD_EVIDENCE';
  }
  if (evidence.speechDetected !== true || evidence.voicedDurationMs <= 0 ||
      !Number.isFinite(metadata.speechMs) || metadata.speechMs <= 0) return 'NO_VOICED_SPEECH';
  if (evidence.utteranceDurationMs < evidence.voicedDurationMs) return 'INVALID_VAD_EVIDENCE';
  return null;
}

function recordAudioDiscard(audio, reason) {
  const evidence = audio?.evidence;
  recordEvaluationEvent('audio_discarded', {
    caseId: audio?.caseId,
    sessionId: audio?.sessionId,
    streamId: audio?.streamId,
    streamGeneration: audio?.streamGeneration,
    audioEndedAtMs: Number.isFinite(audio?.audioEndedAtMs) ? audio.audioEndedAtMs : undefined,
    audioDurationMs: Number.isFinite(evidence?.utteranceDurationMs)
      ? Math.round(evidence.utteranceDurationMs)
      : undefined,
    queueName: 'audio',
    queueLength: state.audioQueuePendingTasks,
    reason,
    outcome: 'discarded',
  });
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
      clearPendingTranslationTasksForSession(oldSessionId);
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
    if (message.event?.type === 'upsert') {
      const record = message.event.record;
      recordEvaluationEvent('caption_publication_event', {
        caseId: record.segmentId,
        sessionId: message.event.sessionId,
        streamId: record.streamId,
        streamGeneration: state.streamGenerations[record.streamId],
      });
    } else if (message.event?.type === 'retract') {
      recordEvaluationEvent('caption_retracted', {
        caseId: message.event.segmentId,
        sessionId: message.event.sessionId,
      });
    }
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
    message.caseId = typeof message.caseId === 'string' && message.caseId ? message.caseId : createSessionId();
    const audioMetadata = {
      sessionId: message.sessionId,
      streamId: message.streamId,
      streamGeneration: message.streamGeneration,
      audioEndedAtMs: Number.isFinite(message.audioEndedAtMs) ? message.audioEndedAtMs : null,
    };
    const discardReason = audioDiscardReason(message);
    if (discardReason) {
      recordAudioDiscard({ ...message, ...audioMetadata }, discardReason);
      return;
    }
    const audioMs = Number.isFinite(message.evidence?.utteranceDurationMs)
      ? message.evidence.utteranceDurationMs
      : message.speechMs;
    enqueueAudioTask((reservation) => handleAudioData(message, reservation), {
      audioMs,
      queuedAtMs: Date.now(),
      caseId: message.caseId,
      sessionId: message.sessionId,
      streamId: message.streamId,
      streamGeneration: message.streamGeneration,
      audioEndedAtMs: audioMetadata.audioEndedAtMs,
      queueKind: 'asr',
    });
  }
}

async function handleCaptionClientMessage(port, kind, message) {
  if (kind !== 'private') return;
  if (message?.type === 'CAPTION_LOAD_CONTROL_RESUME') {
    await evaluationTelemetryReady;
    const result = state.loadControlController?.resumeByUserAction();
    if (result?.resumed) applyLoadControlResult(result);
    else broadcastLoadControlStatus();
    postPortMessage(port, { type: 'CAPTION_LOAD_CONTROL_RESUME_RESULT', resumed: result?.resumed === true });
    return;
  }
  if (message?.type === 'EVALUATION_TELEMETRY_EXPORT_REQUEST') {
    await evaluationTelemetryReady;
    await evaluationTelemetry.flush();
    postPortMessage(port, {
      type: 'EVALUATION_TELEMETRY_EXPORT',
      requestId: message.requestId,
      snapshot: evaluationTelemetry.snapshot(),
      caseTimings: evaluationTelemetry.caseTimings(),
    });
    return;
  }
  if (message?.type !== 'CAPTION_ACTION') return;
  const action = message.action;
  const correctionQueuedAtMs = action === 'correct' ? Date.now() : null;
  const payload = message.payload || {};
  if (action === 'approve') {
    recordEvaluationEvent('approval_requested', {
      caseId: payload.segmentId,
      sessionId: state.sessionId,
    });
  }
  let result;
  try {
    if (!['approve', 'correct', 'undo'].includes(action) || typeof payload.segmentId !== 'string') {
      throw new Error('invalid caption action');
    }
    result = await captionStoreRequest(action, payload);
    if (result?.ok && action === 'correct') {
      recordEvaluationEvent('correction_saved', {
        caseId: result.record?.segmentId || payload.segmentId,
        sessionId: result.record?.sessionId || state.sessionId,
        streamId: result.record?.streamId,
        streamGeneration: result.record?.streamGeneration,
      });
    } else if (result?.ok && action === 'undo') {
      recordEvaluationEvent('correction_undone', {
        caseId: result.record?.segmentId || payload.segmentId,
        sessionId: result.record?.sessionId || state.sessionId,
        streamId: result.record?.streamId,
        streamGeneration: result.record?.streamGeneration,
      });
    }
    if (action === 'correct' && result?.ok && result.record?.translations?.length) {
      const translation = result.record.translations[0];
      let correctionFailureRecorded = false;
      const markCorrectionTranslationFailed = async (error) => {
        if (correctionFailureRecorded) return;
        correctionFailureRecorded = true;
        const paused = error?.code === 'TRANSLATION_PAUSED';
        const translationResult = await captionStoreRequest('set-translation', {
          segmentId: result.record.segmentId,
          sourceRevision: result.record.sourceRevision,
          targetLanguage: translation.targetLanguage,
          text: null,
          state: paused ? 'paused' : 'failed',
          allowHistorical: true,
        }).catch(() => {});
        if (translationResult?.ok && translationResult.record) result.record = translationResult.record;
        result.translationStale = error?.reason === 'source-revision';
        result.translationPaused = paused;
        result.translationFailed = !paused;
      };
      try {
        const cfg = await getSettings();
        if (state.translationPaused || state.inferenceAdmissionStopped) {
          const rejection = translationQueueError('TRANSLATION_PAUSED', 'load-control');
          reportTranslationAdmissionRejected({
            segmentId: result.record.segmentId,
            sessionId: result.record.sessionId,
            streamId: result.record.streamId,
            streamGeneration: result.record.streamGeneration,
            observedConfigId: evaluationObservedConfigId(cfg),
          }, state.inferenceAdmissionStopped ? 'MEMORY_PRESSURE' : 'QUEUE_WAIT');
          await markCorrectionTranslationFailed(rejection);
        } else {
          await enqueueTranslationTask(() => translateOnly(
            result.record.sourceText,
            result.record.sourceLanguage,
            translation.targetLanguage,
            cfg,
            {
              sessionId: result.record.sessionId,
              streamId: result.record.streamId,
              streamGeneration: result.record.streamGeneration,
              segmentId: result.record.segmentId,
              sourceRevision: result.record.sourceRevision,
              sourceText: result.record.sourceText,
            }
          ), {
            sessionId: result.record.sessionId,
            streamId: result.record.streamId,
            streamGeneration: result.record.streamGeneration,
            observedConfigId: evaluationObservedConfigId(cfg),
            segmentId: result.record.segmentId,
            sourceRevision: result.record.sourceRevision,
            sourceText: result.record.sourceText,
            sourceLang: result.record.sourceLanguage,
            targetLang: translation.targetLanguage,
            serverUrl: cfg.serverUrl,
            queuedAtMs: correctionQueuedAtMs,
            ready: false,
            onAdmitted: (job) => {
              if (state.correctionLanePendingCallbacks >= MAX_PENDING_CORRECTION_LANE_CALLBACKS) {
                const error = translationQueueError('TRANSLATION_OVERLOAD');
                state.translationQueue = state.translationQueue.filter((pending) => pending !== job);
                reportTranslationQueueDrop(error.code, {
                  caseId: job.segmentId,
                  sessionId: job.sessionId,
                  streamId: job.streamId,
                  streamGeneration: job.streamGeneration,
                  observedConfigId: job.observedConfigId,
                  reason: translationDropReason(error),
                });
                failTranslationJob(job, error, { report: false });
                return;
              }

              state.correctionLanePendingCallbacks += 1;
              enqueueAudioTask(async () => {
                if (!state.translationQueue.includes(job)) return;
                job.ready = true;
                runNextTranslationTask();
                await job.promise.catch(() => {});
              }, { queuedAtMs: correctionQueuedAtMs, queueKind: 'translation' }).then(
                () => { state.correctionLanePendingCallbacks -= 1; },
                () => { state.correctionLanePendingCallbacks -= 1; }
              );
            },
            allowHistorical: true,
            onResult: async (translated) => {
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
              if (!translated) result.translationFailed = true;
            },
            onFailure: async (error) => {
              await markCorrectionTranslationFailed(error);
            },
          });
        }
      } catch (error) {
        await markCorrectionTranslationFailed(error);
      }
    }
    if (action === 'approve') {
      recordEvaluationEvent('approval_finished', {
        caseId: result.record?.segmentId || payload.segmentId,
        sessionId: result.record?.sessionId || state.sessionId,
        streamId: result.record?.streamId,
        streamGeneration: result.record?.streamGeneration,
        outcome: result?.ok && result.record?.userApproved === true ? 'success' : 'error',
        reason: result?.ok && result.record?.userApproved === true ? null : 'APPROVAL_REQUEST_FAILED',
      });
    }
    postPortMessage(port, { type: 'CAPTION_ACTION_RESULT', requestId: message.requestId, action, result });
  } catch (err) {
    if (action === 'approve') {
      recordEvaluationEvent('approval_finished', {
        caseId: payload.segmentId,
        outcome: 'error',
        errorClass: err?.name || 'Error',
      });
    }
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
          translationQueueStatus: { ...state.translationQueueStatus },
          loadControlStatus: loadControlStatus(),
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
async function translateOnly(text, sourceLang, targetLang, cfg, identity = null) {
  const params = new URLSearchParams({ text, target_lang: targetLang });
  if (sourceLang) params.set('source_lang', sourceLang);
  if (identity && typeof identity === 'object') {
    const identityFields = {
      sessionId: 'session_id',
      streamId: 'audio_source',
      streamGeneration: 'stream_generation',
      segmentId: 'segment_id',
      sourceRevision: 'source_revision',
      sourceText: 'source_text',
    };
    for (const [key, field] of Object.entries(identityFields)) {
      if (identity[key] !== undefined && identity[key] !== null) params.set(field, String(identity[key]));
    }
  }

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

function removeAudioQueueEntry(entry) {
  const index = state.audioQueueEntries.indexOf(entry);
  if (index >= 0) state.audioQueueEntries.splice(index, 1);
}

function clearPendingSpeakerBatches() {
  for (const batch of state.pendingSpeakerBatches.values()) {
    for (const chunk of batch.chunks) releaseAudioQueueReservation(chunk.audioReservation);
  }
  state.pendingSpeakerBatches.clear();
  cancelSpeakerBatchFlush();
}

function appendSpeakerBatchChunk(batch, wavB64, speechMs, audioReservation, caseId = null) {
  retainAudioQueueReservation(audioReservation);
  batch.chunks.push({ wavB64, speechMs, audioReservation, caseId });
  if (caseId && !batch.caseIds.includes(caseId)) batch.caseIds.push(caseId);
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
    caseIds: [],
    chunks: [],
    totalDurationMs: durationMs,
    totalSpeechMs: 0,
    totalReservedAudioMs: 0,
    oldestQueuedAtMs: audioReservation?.queuedAtMs ?? Date.now(),
  };
  appendSpeakerBatchChunk(batch, wavB64, speechMs, audioReservation, audioMetadata.caseId);
  state.pendingSpeakerBatches.set(key, batch);
  scheduleSpeakerBatchFlush();
}

function enqueueAudioTask(task, options = {}) {
  const audioMs = Number.isFinite(options.audioMs) ? Math.max(0, options.audioMs) : 0;
  const queuedAtMs = Number.isFinite(options.queuedAtMs) ? options.queuedAtMs : Date.now();
  const reservesAudio = audioMs > 0;
  const telemetry = {
    caseId: options.caseId,
    sessionId: options.sessionId,
    streamId: options.streamId,
    streamGeneration: options.streamGeneration,
    audioEndedAtMs: options.audioEndedAtMs,
    queueName: 'audio',
    audioDurationMs: Math.round(audioMs),
  };
  if (reservesAudio) {
    if (Date.now() - queuedAtMs > MAX_AUDIO_QUEUE_STALE_MS) {
      return Promise.resolve(reportAudioQueueDrop('STALE', audioMs, telemetry));
    }
    if (state.audioQueuePendingItems + 1 > MAX_AUDIO_QUEUE_PENDING_ITEMS ||
        state.audioQueuePendingMs + audioMs > MAX_AUDIO_QUEUE_PENDING_MS) {
      return Promise.resolve(reportAudioQueueDrop('OVERLOAD', audioMs, telemetry));
    }
    state.audioQueuePendingItems += 1;
    state.audioQueuePendingMs += audioMs;
  }

  const queueLength = state.audioQueuePendingTasks;
  state.audioQueuePendingTasks += 1;
  const queueEntry = {
    queuedAtMs,
    caseId: telemetry.caseId || null,
    queueKind: options.queueKind || (telemetry.caseId ? 'asr' : 'control'),
  };
  state.audioQueueEntries.push(queueEntry);
  if (telemetry.caseId) {
    recordEvaluationEvent('audio_enqueued', { ...telemetry, queueLength: queueLength + 1 });
  }

  const reservation = reservesAudio
    ? { audioMs, queuedAtMs, retained: false, released: false }
    : null;

  let started = false;
  const next = state.audioQueue.then(async () => {
    started = true;
    const queueLengthAtStart = state.audioQueuePendingTasks;
    state.audioQueuePendingTasks = Math.max(0, state.audioQueuePendingTasks - 1);
    removeAudioQueueEntry(queueEntry);
    const queueWaitMs = Math.max(0, Date.now() - queuedAtMs);
    const loadControlResult = state.loadControlController?.observeQueueWait(queueWaitMs, Date.now());
    if (loadControlResult?.transition) applyLoadControlResult(loadControlResult);
    if (reservesAudio && Date.now() - queuedAtMs > MAX_AUDIO_QUEUE_STALE_MS) {
      return reportAudioQueueDrop('STALE', audioMs, telemetry);
    }
    if (telemetry.caseId) {
      recordEvaluationEvent('audio_started', {
        ...telemetry,
        queueLength: queueLengthAtStart,
        queueWaitMs,
      });
    }
    const taskStartedAtMs = Date.now();
    try {
      const result = await task(reservation);
      if (telemetry.caseId) {
        recordEvaluationEvent('audio_finished', {
          ...telemetry,
          durationMs: Math.max(0, Date.now() - taskStartedAtMs),
          outcome: 'success',
        });
      }
      return result;
    } catch (error) {
      if (telemetry.caseId) {
        recordEvaluationEvent('audio_finished', {
          ...telemetry,
          durationMs: Math.max(0, Date.now() - taskStartedAtMs),
          outcome: 'failed',
          errorClass: error?.name || 'Error',
        });
      }
      throw error;
    }
  }).finally(() => {
    if (!started) {
      state.audioQueuePendingTasks = Math.max(0, state.audioQueuePendingTasks - 1);
      removeAudioQueueEntry(queueEntry);
    }
    if (!reservation?.retained) releaseAudioQueueReservation(reservation);
  });
  state.audioQueue = next.catch((err) => {
    console.error('[background] audio processing error:', err);
  });
  return next;
}

function translationQueueError(code, reason = null) {
  const error = new Error(code === 'TRANSLATION_OVERLOAD'
    ? 'translation queue is full'
    : code === 'TRANSLATION_CONFLICT'
      ? 'conflicting translation request for the same source revision'
      : code === 'TRANSLATION_PAUSED'
        ? 'translation admission is paused by load control'
        : 'translation request became stale');
  error.code = code;
  error.reason = reason;
  return error;
}

function translationScopeKey(options) {
  if (typeof options.segmentId !== 'string' || !options.segmentId) return null;
  return JSON.stringify([
    options.sessionId ?? null,
    options.streamId ?? null,
    options.streamGeneration ?? null,
    options.segmentId,
  ]);
}

function translationRequestKey(options) {
  return JSON.stringify([
    options.sessionId ?? null,
    options.streamId ?? null,
    options.streamGeneration ?? null,
    options.segmentId ?? null,
    options.sourceRevision ?? null,
    options.sourceText ?? null,
    options.sourceLang ?? null,
    options.targetLang ?? null,
    options.serverUrl ?? null,
    options.allowHistorical === true,
  ]);
}

function translationDropReason(error) {
  if (error?.code === 'TRANSLATION_STALE') {
    return ({
      'queue-expired': 'QUEUE_EXPIRED',
      'audio-age': 'AUDIO_AGE_EXPIRED',
      'source-revision': 'SOURCE_REVISION_SUPERSEDED',
      'session-ended': 'SESSION_ENDED',
      'audio-session-changed': 'AUDIO_SESSION_CHANGED',
    })[error.reason] || 'TRANSLATION_STALE';
  }
  if (error?.code === 'TRANSLATION_OVERLOAD') return 'QUEUE_OVERFLOW';
  if (error?.code === 'TRANSLATION_PAUSED') return 'TRANSLATION_PAUSED';
  if (error?.code === 'TRANSLATION_CONFLICT') return 'SAME_REVISION_CONFLICT';
  return 'TRANSLATION_FAILED';
}

function failTranslationJob(job, error, { report = true } = {}) {
  if (report) {
    reportTranslationQueueDrop(error?.code || 'TRANSLATION_FAILED', {
      caseId: job.segmentId,
      sessionId: job.sessionId,
      streamId: job.streamId,
      streamGeneration: job.streamGeneration,
      observedConfigId: job.observedConfigId,
      configCoverage: 'partial',
      reason: translationDropReason(error),
    });
  }
  Promise.resolve()
    .then(() => job.onFailure?.(error))
    .catch(() => {})
    .finally(() => job.reject(error));
}

function translationJobStaleReason(job, nowMs = Date.now()) {
  if (nowMs - job.queuedAtMs > MAX_TRANSLATION_WAIT_MS) return 'queue-expired';
  if (Number.isFinite(job.audioEndedAtMs) && nowMs - job.audioEndedAtMs > MAX_TRANSLATION_AUDIO_AGE_MS) {
    return 'audio-age';
  }
  return null;
}

function expireStaleTranslationTasks(nowMs = Date.now()) {
  const staleJobs = state.translationQueue
    .map((job) => ({ job, reason: translationJobStaleReason(job, nowMs) }))
    .filter((entry) => entry.reason);
  if (staleJobs.length === 0) return;
  const staleSet = new Set(staleJobs.map((entry) => entry.job));
  state.translationQueue = state.translationQueue.filter((job) => !staleSet.has(job));
  for (const { job, reason } of staleJobs) {
    failTranslationJob(job, translationQueueError('TRANSLATION_STALE', reason));
  }
}

async function runNextTranslationTask() {
  if (state.translationQueueActive || state.translationPaused || state.inferenceAdmissionStopped) return;
  expireStaleTranslationTasks();
  const runnableIndex = state.translationQueue.findIndex((job) => job.ready);
  if (runnableIndex < 0) return;
  const [job] = state.translationQueue.splice(runnableIndex, 1);
  if (!job) return;
  state.translationQueueActive = job;
  const startedAtMs = Date.now();
  recordEvaluationEvent('translation_started', {
    caseId: job.segmentId,
    sessionId: job.sessionId,
    streamId: job.streamId,
    streamGeneration: job.streamGeneration,
    observedConfigId: job.observedConfigId,
    configCoverage: 'partial',
    queueName: 'translation',
    queueLength: state.translationQueue.length + 1,
    queueWaitMs: Math.max(0, startedAtMs - job.queuedAtMs),
    attempt: job.attempt,
  });
  try {
    const result = await job.task();
    await job.onResult?.(result);
    recordEvaluationEvent('translation_finished', {
      caseId: job.segmentId,
      sessionId: job.sessionId,
      streamId: job.streamId,
      streamGeneration: job.streamGeneration,
      observedConfigId: job.observedConfigId,
      configCoverage: 'partial',
      durationMs: Math.max(0, Date.now() - startedAtMs),
      attempt: job.attempt,
      outcome: 'success',
    });
    job.resolve(result);
  } catch (error) {
    const reason = error?.code || null;
    recordEvaluationEvent('translation_finished', {
      caseId: job.segmentId,
      sessionId: job.sessionId,
      streamId: job.streamId,
      streamGeneration: job.streamGeneration,
      observedConfigId: job.observedConfigId,
      configCoverage: 'partial',
      durationMs: Math.max(0, Date.now() - startedAtMs),
      attempt: job.attempt,
      outcome: 'failed',
      reason,
      errorClass: error?.name || 'Error',
    });
    if (!['TRANSLATION_STALE', 'TRANSLATION_OVERLOAD', 'TRANSLATION_PAUSED'].includes(reason)) {
      recordEvaluationEvent('backend_error', {
        caseId: job.segmentId,
        sessionId: job.sessionId,
        streamId: job.streamId,
        streamGeneration: job.streamGeneration,
        observedConfigId: job.observedConfigId,
        configCoverage: 'partial',
        reason: 'TRANSLATION',
        errorClass: error?.name || 'Error',
        attempt: job.attempt,
      });
    }
    failTranslationJob(job, error, { report: false });
  } finally {
    state.translationQueueActive = null;
    runNextTranslationTask();
  }
}

function enqueueTranslationTask(task, options = {}) {
  if (typeof task !== 'function') return Promise.reject(new TypeError('translation task must be a function'));
  const queuedAtMs = Number.isFinite(options.queuedAtMs) ? options.queuedAtMs : Date.now();
  const audioEndedAtMs = Number.isFinite(options.audioEndedAtMs) ? options.audioEndedAtMs : null;
  if (state.translationPaused || state.inferenceAdmissionStopped) {
    const error = translationQueueError('TRANSLATION_PAUSED', 'load-control');
    reportTranslationAdmissionRejected({
      segmentId: options.segmentId,
      sessionId: options.sessionId,
      streamId: options.streamId,
      streamGeneration: options.streamGeneration,
      observedConfigId: options.observedConfigId || state.evaluationObservedConfigId,
    }, state.inferenceAdmissionStopped ? 'MEMORY_PRESSURE' : 'QUEUE_WAIT');
    return Promise.resolve()
      .then(() => options.onFailure?.(error))
      .catch(() => {})
      .then(() => { throw error; });
  }
  expireStaleTranslationTasks();
  const scopeKey = translationScopeKey(options);
  const requestKey = translationRequestKey(options);
  const sourceRevision = Number.isSafeInteger(options.sourceRevision) ? options.sourceRevision : null;
  const scopedJobs = [state.translationQueueActive, ...state.translationQueue].filter((job) =>
    job && scopeKey && job.scopeKey === scopeKey && job.sourceRevision !== null
  );

  if (scopedJobs.length && sourceRevision !== null) {
    const latestRevision = Math.max(...scopedJobs.map((job) => job.sourceRevision));
    if (sourceRevision < latestRevision) {
      const error = translationQueueError('TRANSLATION_STALE', 'source-revision');
      reportTranslationQueueDrop(error.code, {
        caseId: options.segmentId,
        sessionId: options.sessionId,
        streamId: options.streamId,
        streamGeneration: options.streamGeneration,
        observedConfigId: options.observedConfigId || state.evaluationObservedConfigId,
        configCoverage: 'partial',
        reason: translationDropReason(error),
      });
      return Promise.reject(error);
    }
    if (sourceRevision === latestRevision) {
      const sameRevision = scopedJobs.find((job) => job.sourceRevision === sourceRevision);
      if (requestKey === sameRevision.requestKey) {
        recordEvaluationEvent('translation_deduplicated', {
          caseId: options.segmentId,
          sessionId: options.sessionId,
          streamId: options.streamId,
          streamGeneration: options.streamGeneration,
          observedConfigId: options.observedConfigId || state.evaluationObservedConfigId,
          configCoverage: 'partial',
          queueName: 'translation',
          queueLength: state.translationQueue.length + (state.translationQueueActive ? 1 : 0),
          reason: 'IDENTICAL_REQUEST',
        });
        return sameRevision.promise;
      }
      const error = translationQueueError('TRANSLATION_CONFLICT');
      reportTranslationQueueDrop(error.code, {
        caseId: options.segmentId,
        sessionId: options.sessionId,
        streamId: options.streamId,
        streamGeneration: options.streamGeneration,
        observedConfigId: options.observedConfigId || state.evaluationObservedConfigId,
        configCoverage: 'partial',
        reason: translationDropReason(error),
      });
      return Promise.reject(error);
    }
    const obsolete = state.translationQueue.filter((job) =>
      job.scopeKey === scopeKey && job.sourceRevision !== null && job.sourceRevision < sourceRevision
    );
    state.translationQueue = state.translationQueue.filter((job) => !obsolete.includes(job));
    for (const job of obsolete) {
      failTranslationJob(job, translationQueueError('TRANSLATION_STALE', 'source-revision'));
    }
  }

  if (state.translationQueue.length >= MAX_PENDING_TRANSLATION_ITEMS) {
    const error = translationQueueError('TRANSLATION_OVERLOAD');
    reportTranslationQueueDrop(error.code, {
      caseId: options.segmentId,
      sessionId: options.sessionId,
      streamId: options.streamId,
      streamGeneration: options.streamGeneration,
      observedConfigId: options.observedConfigId || state.evaluationObservedConfigId,
      configCoverage: 'partial',
      reason: translationDropReason(error),
    });
    const rejected = Promise.resolve()
      .then(() => options.onFailure?.(error))
      .catch(() => {})
      .then(() => { throw error; });
    return rejected;
  }

  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const job = {
    task,
    segmentId: options.segmentId ?? null,
    onResult: options.onResult,
    onFailure: options.onFailure,
    sessionId: options.sessionId ?? null,
    streamId: options.streamId === 'mic' || options.streamId === 'tab' ? options.streamId : null,
    observedConfigId: options.observedConfigId || state.evaluationObservedConfigId,
    streamGeneration: Number.isSafeInteger(options.streamGeneration) ? options.streamGeneration : null,
    sourceRevision,
    scopeKey,
    requestKey,
    queuedAtMs,
    audioEndedAtMs,
    attempt: Number.isSafeInteger(options.attempt) && options.attempt > 0 ? options.attempt : 1,
    isLiveAudio: options.isLiveAudio === true,
    ready: options.ready !== false,
    promise,
    resolve,
    reject,
  };
  state.translationQueue.push(job);
  recordEvaluationEvent('translation_enqueued', {
    caseId: job.segmentId,
    sessionId: job.sessionId,
    streamId: job.streamId,
    streamGeneration: job.streamGeneration,
    observedConfigId: job.observedConfigId,
    configCoverage: 'partial',
    queueName: 'translation',
    queueLength: state.translationQueue.length,
    audioEndedAtMs,
    attempt: job.attempt,
  });
  if (job.attempt > 1) {
    recordEvaluationEvent('retry', {
      caseId: job.segmentId,
      sessionId: job.sessionId,
      streamId: job.streamId,
      streamGeneration: job.streamGeneration,
      observedConfigId: job.observedConfigId,
      configCoverage: 'partial',
      reason: 'RETRY_REQUESTED',
      outcome: 'queued',
      attempt: job.attempt,
    });
  }
  options.onAdmitted?.(job);
  runNextTranslationTask();
  return promise;
}

function clearPendingTranslationTasksForSession(sessionId) {
  const pending = state.translationQueue.filter((job) => job.isLiveAudio && job.sessionId === sessionId);
  if (pending.length === 0) return;
  state.translationQueue = state.translationQueue.filter((job) => !pending.includes(job));
  for (const job of pending) {
    failTranslationJob(job, translationQueueError('TRANSLATION_STALE', 'session-ended'));
  }
}

async function processAudioChunk(wavB64, speakerName, tabId, speechMs = null, audioMetadata = null) {
  // Live audio is accepted only with the active session and stream generation.
  // This also prevents legacy callers from publishing an untracked result.
  if (!audioMetadata) return;
  const initialDiscardReason = audioSessionDiscardReason(audioMetadata) ||
    (state.asrAdmissionStopped ? 'ASR_STOPPED_MEMORY_PRESSURE' : null);
  if (initialDiscardReason) {
    recordAudioDiscard(audioMetadata, initialDiscardReason);
    return;
  }
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
  const caseId = audioMetadata.caseId || createSessionId();
  const caseContext = {
    caseId,
    sessionId: audioMetadata.sessionId,
    streamId: audioMetadata.streamId,
    streamGeneration: audioMetadata.streamGeneration,
    relatedCaseIds: audioMetadata.relatedCaseIds,
    audioEndedAtMs: audioMetadata.audioEndedAtMs,
    observedConfigId: evaluationObservedConfigId(cfg),
    configCoverage: 'partial',
  };

  // Step 1: ASR. Keep all candidate text private until host approval, including
  // text marked by model-specific or text-only diagnostics.
  const asrStartedAtMs = Date.now();
  recordEvaluationEvent('asr_started', caseContext);
  let asr;
  try {
    asr = await transcribeOnly(wavB64, cfg, effectiveSpeechMs, audioMetadata.evidence);
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - asrStartedAtMs);
    recordEvaluationEvent('asr_finished', { ...caseContext, durationMs, outcome: 'failed', errorClass: error?.name || 'Error' });
    recordEvaluationEvent('backend_error', { ...caseContext, reason: 'ASR', attempt: 1, errorClass: error?.name || 'Error' });
    throw error;
  }
  recordEvaluationEvent('asr_finished', {
    ...caseContext,
    durationMs: Math.max(0, Date.now() - asrStartedAtMs),
    outcome: 'success',
  });
  const afterAsrDiscardReason = audioSessionDiscardReason(audioMetadata);
  if (afterAsrDiscardReason) {
    recordAudioDiscard(audioMetadata, afterAsrDiscardReason);
    return;
  }
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
  const beforeCandidateDiscardReason = audioSessionDiscardReason(audioMetadata);
  if (beforeCandidateDiscardReason) {
    recordAudioDiscard(audioMetadata, beforeCandidateDiscardReason);
    return;
  }

  const needTranslation = Boolean(languageResolution.accepted && textToTranslate && cfg.overlayFormat !== 'transcription');
  const translationAdmissionPaused = state.translationPaused || state.inferenceAdmissionStopped;
  const segmentId = caseId;
  const translationEntry = needTranslation
    ? [{ targetLanguage: translTargetLang, sourceRevision: 1,
      state: translationAdmissionPaused ? 'paused' : 'pending', text: null }]
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
  if (!stored?.ok) return;
  const afterCandidateDiscardReason = audioSessionDiscardReason(audioMetadata);
  if (afterCandidateDiscardReason) {
    recordAudioDiscard(audioMetadata, afterCandidateDiscardReason);
    return;
  }
  recordEvaluationEvent('candidate_generated', caseContext);

  if (!needTranslation) return;
  if (translationAdmissionPaused) {
    reportTranslationAdmissionRejected({
      segmentId,
      sessionId: audioMetadata.sessionId,
      streamId: audioMetadata.streamId,
      streamGeneration: audioMetadata.streamGeneration,
      observedConfigId: caseContext.observedConfigId,
    }, state.inferenceAdmissionStopped ? 'MEMORY_PRESSURE' : 'QUEUE_WAIT');
    return;
  }
  try {
    await enqueueTranslationTask(() => {
      if (!isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) {
        throw translationQueueError('TRANSLATION_STALE', 'audio-session-changed');
      }
      return translateOnly(textToTranslate, translSourceLang, translTargetLang, cfg, {
        sessionId: audioMetadata.sessionId,
        streamId: audioMetadata.streamId,
        streamGeneration: audioMetadata.streamGeneration,
        segmentId,
        sourceRevision: 1,
        sourceText: transcription,
      });
    }, {
      sessionId: audioMetadata.sessionId,
      streamId: audioMetadata.streamId,
      streamGeneration: audioMetadata.streamGeneration,
      segmentId,
      sourceRevision: 1,
      sourceText: transcription,
      sourceLang: translSourceLang,
      targetLang: translTargetLang,
      serverUrl: cfg.serverUrl,
      audioEndedAtMs: audioMetadata.audioEndedAtMs,
      observedConfigId: caseContext.observedConfigId,
      isLiveAudio: true,
      onResult: async (translation) => {
        if (!isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;
        await captionStoreRequest('set-translation', {
          segmentId,
          sourceRevision: 1,
          targetLanguage: translTargetLang,
          text: translation,
          state: translation ? 'ready' : 'failed',
        });
      },
      onFailure: async (error) => {
        await captionStoreRequest('set-translation', {
          segmentId,
          sourceRevision: 1,
          targetLanguage: translTargetLang,
          text: null,
          state: error?.code === 'TRANSLATION_PAUSED' ? 'paused' : 'failed',
          allowHistorical: true,
        }).catch(() => {});
      },
    });
  } catch (_) {
    // Queue and inference failures are reflected on the candidate as failed.
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
    const audioMetadata = {
      ...batch.audioMetadata,
      caseId: batch.caseIds[0] || batch.audioMetadata.caseId || createSessionId(),
      relatedCaseIds: batch.caseIds,
    };
    try {
      if (Date.now() - batch.oldestQueuedAtMs > MAX_AUDIO_QUEUE_STALE_MS) {
        reportAudioQueueDrop('STALE', batch.totalReservedAudioMs || batch.totalDurationMs, {
          caseId: audioMetadata.caseId,
          sessionId: audioMetadata.sessionId,
          streamId: audioMetadata.streamId,
          streamGeneration: audioMetadata.streamGeneration,
          relatedCaseIds: audioMetadata.relatedCaseIds,
        });
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
          await processAudioChunk(chunk.wavB64, batch.speakerName, tabId, chunk.speechMs, {
            ...audioMetadata,
            caseId: chunk.caseId || createSessionId(),
            relatedCaseIds: [chunk.caseId].filter(Boolean),
          });
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
  const audioMetadata = {
    caseId: audioChunk?.caseId || createSessionId(),
    sessionId: audioChunk?.sessionId,
    streamId: audioChunk?.streamId,
    streamGeneration: audioChunk?.streamGeneration,
    audioEndedAtMs: Number.isFinite(audioChunk?.audioEndedAtMs) ? audioChunk.audioEndedAtMs : null,
    evidence: audioChunk?.evidence,
  };
  const initialDiscardReason = !wavB64 ? 'INVALID_AUDIO_PAYLOAD'
    : audioSessionDiscardReason(audioMetadata) ||
      (state.asrAdmissionStopped ? 'ASR_STOPPED_MEMORY_PRESSURE' : null);
  if (initialDiscardReason) {
    recordAudioDiscard(audioMetadata, initialDiscardReason);
    return;
  }

  const tabId = state.tabId;
  const speakerName = audioMetadata.streamId === 'tab' ? await getActiveSpeaker(tabId) : null;
  const afterSpeakerDiscardReason = audioSessionDiscardReason(audioMetadata) ||
    (state.asrAdmissionStopped ? 'ASR_STOPPED_MEMORY_PRESSURE' : null);
  if (afterSpeakerDiscardReason) {
    recordAudioDiscard(audioMetadata, afterSpeakerDiscardReason);
    return;
  }
  const normalizedSpeaker = normalizeSpeakerName(speakerName);
  const durationMs = getWavDurationMs(wavB64);
  const speechMs = Number.isFinite(audioChunk?.speechMs) ? audioChunk.speechMs : durationMs;
  if (!shouldRequestTranscription(speechMs, audioMetadata.evidence)) {
    recordAudioDiscard({ ...audioMetadata, speechMs }, 'INVALID_VAD_EVIDENCE');
    return;
  }

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
    if (!isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;
    startSpeakerBatch(wavB64, normalizedSpeaker, durationMs, speechMs, audioMetadata, audioReservation);
    return;
  }

  if (pending.totalDurationMs + durationMs > MAX_SPEAKER_BATCH_DURATION_MS) {
    await flushPendingSpeakerBatch('max-batch-duration', tabId, audioMetadata.streamId);
    if (!isCurrentAudioMetadata(audioMetadata, state.sessionId, state.streamGenerations)) return;
    startSpeakerBatch(wavB64, normalizedSpeaker, durationMs, speechMs, audioMetadata, audioReservation);
    return;
  }

  appendSpeakerBatchChunk(pending, wavB64, speechMs, audioReservation, audioMetadata.caseId);
  pending.totalDurationMs += durationMs;
  pending.audioMetadata.audioEndedAtMs = audioMetadata.audioEndedAtMs;
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
    await evaluationTelemetryReady;
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
    state.evaluationRunId = createSessionId();
    state.evaluationObservedConfigId = evaluationObservedConfigId(cfg, state.serverInfo);
    state.loadControlController = globalThis.MeetTranslatorLoadControl.createAdaptiveLoadController();
    state.translationPaused = false;
    state.inferenceAdmissionStopped = false;
    state.asrAdmissionStopped = false;
    state.memoryStatus = { pressure: 'unknown', processGroupMemoryGiB: null, sourceAvailable: false };
    stopLoadControlSampling();
    state.audioQueueEntries = [];
    evaluationTelemetry.beginRun({
      runId: state.evaluationRunId,
      sessionId,
      observedConfigId: state.evaluationObservedConfigId,
      configCoverage: 'partial',
    });
    recordEvaluationEvent('load_control_transition', {
      sessionId,
      outcome: 'normal',
      reason: 'CAPTURE_STARTED',
    });
    clearPendingSpeakerBatches();
    state.audioQueueStatus = { code: null, droppedCount: 0, droppedAudioMs: 0, updatedAtMs: null };
    state.translationQueueStatus = { code: null, droppedCount: 0, heldCount: 0, rejectedCount: 0, updatedAtMs: null };

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
    if (state.evaluationRunId) {
      evaluationTelemetry.endRun({
        sessionId,
        observedConfigId: state.evaluationObservedConfigId,
        configCoverage: 'partial',
        outcome: 'failed',
        reason: 'START_FAILED',
        errorClass: err?.name || 'Error',
      });
      await evaluationTelemetry.flush();
      state.evaluationRunId = null;
      state.evaluationObservedConfigId = null;
    }
    stopLoadControlSampling();
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
  stopLoadControlSampling();
  clearPendingSpeakerBatches();
  clearPendingTranslationTasksForSession(sessionId);

  // 定期ヘルスチェックを停止
  if (state.healthCheckTimer) {
    clearInterval(state.healthCheckTimer);
    state.healthCheckTimer = null;
  }

  try {
    await captionStoreRequest('stop-audio');
  } catch (_) {}

  await state.audioQueue;

  if (state.evaluationRunId) {
    evaluationTelemetry.endRun({
      sessionId,
      observedConfigId: state.evaluationObservedConfigId,
      configCoverage: 'partial',
      outcome: 'stopped',
      reason: 'USER_STOPPED',
      pendingCount: state.audioQueuePendingTasks + state.translationQueue.length,
      droppedCount: state.audioQueueStatus.droppedCount + state.translationQueueStatus.droppedCount,
    });
    await evaluationTelemetry.flush();
    state.evaluationRunId = null;
    state.evaluationObservedConfigId = null;
  }

  state.loadControlController = null;
  state.translationPaused = false;
  state.inferenceAdmissionStopped = false;
  state.asrAdmissionStopped = false;
  state.memoryStatus = { pressure: 'unknown', processGroupMemoryGiB: null, sourceAvailable: false };
  broadcastLoadControlStatus();

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
