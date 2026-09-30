/**
 * offscreen.js  –  Offscreen Document (Manifest V3)
 *
 * Responsibilities:
 *  1. Receive a tabCapture stream-ID from the background service worker.
 *  2. Attach to the tab audio stream via getUserMedia().
 *  3. Analyse audio with the Web Audio API (ScriptProcessor / AudioWorklet).
 *  4. Encode accumulated audio as WAV and forward to the background worker.
 *  5. Skip silent chunks (VAD) to avoid unnecessary API calls.
 */

'use strict';

// ---------------------------------------------------------------------------
// Log bridge – forwards all offscreen logs to background.js service worker
// so they appear in the service worker DevTools console.
// ---------------------------------------------------------------------------
function bgLog(level, ...args) {
  const msg = args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
  // eslint-disable-next-line no-console
  console[level]('[offscreen]', msg);
  postToBackground({ type: 'OFFSCREEN_LOG', level, msg });
}

bgLog('info', 'script loaded');

let audioContext = null;
let mediaStream = null; // tab MediaStream
let micStream = null;   // microphone MediaStream
let audioPipelines = new Map(); // independent per-stream VAD and Web Audio nodes
const { createEnergyVad } = globalThis.MeetTranslatorVad;
const { createCaptionStore } = globalThis.MeetTranslatorCaptionStore;
let backgroundPort = null;
let activeSessionId = null;
let activeTabId = null;
let activeStreamIds = [];
let activeStreamGenerations = { mic: 0, tab: 0 };
const offscreenBootId = globalThis.crypto?.randomUUID?.() || `offscreen-${Date.now()}-${Math.random()}`;
const pendingPersistRequests = new Map();
let resolveStoreReady;
let captionStore;
const storeReady = new Promise((resolve) => { resolveStoreReady = resolve; });

function postToBackground(message) {
  try {
    backgroundPort?.postMessage(message);
  } catch (_) {}
}

function connectToBackground() {
  const port = chrome.runtime.connect({ name: 'meet-translator-offscreen' });
  backgroundPort = port;
  port.onMessage.addListener((message) => handleBackgroundPortMessage(port, message));
  port.onDisconnect.addListener(() => {
    if (backgroundPort === port) backgroundPort = null;
    setTimeout(connectToBackground, 250);
  });
  postToBackground({ type: 'OFFSCREEN_HELLO', bootId: offscreenBootId });
}

function initializeCaptionStore(recovered = {}, publishMicrophoneCaptions = false) {
  if (captionStore) return captionStore;
  const interruptedSessionId = recovered.activeSessionId;
  const records = (recovered.records || []).map((record) => {
    if (record.sessionId !== interruptedSessionId) return record;
    return {
      ...record,
      publishEligible: false,
      published: false,
      reasonCodes: [...new Set([...(record.reasonCodes || []), 'SESSION_INTERRUPTED'])],
      updatedAt: Date.now(),
    };
  });
  captionStore = createCaptionStore({
    initialState: {
      ...recovered,
      activeSessionId: null,
      activeGenerations: {},
      records,
      publishMicrophoneCaptions: publishMicrophoneCaptions === true,
    },
    onPrivateRecord: (record) => postToBackground({ type: 'CAPTION_PRIVATE_RECORD', record }),
    onPublicEvent: (event) => postToBackground({ type: 'CAPTION_PUBLIC_EVENT', event }),
  });
  resolveStoreReady(captionStore);
  return captionStore;
}

async function persistCaptionStore() {
  await storeReady;
  const requestId = `persist-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPersistRequests.delete(requestId);
      resolve(false);
    }, 5_000);
    pendingPersistRequests.set(requestId, { resolve, timer });
    postToBackground({
      type: 'CAPTION_STORE_PERSIST',
      requestId,
      bootId: offscreenBootId,
      state: captionStore.state(),
    });
  });
}

// ---------------------------------------------------------------------------
// WAV encoder  (PCM 16-bit, mono)
// ---------------------------------------------------------------------------

/** Encode collected Float32Array chunks into a WAV ArrayBuffer. */
function encodeWav(chunks, sampleRate) {
  const totalLength = chunks.reduce((s, c) => s + c.length, 0);
  const dataBytes = totalLength * 2; // 16-bit = 2 bytes per sample

  // Allocate the final buffer once and write PCM data directly into it,
  // avoiding the intermediate Float32Array and Int16Array allocations that
  // would otherwise triple the peak memory usage during encoding.
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  // RIFF header
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');

  // fmt  chunk (PCM = 1, mono = 1, 16-bit)
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);             // chunk size
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, 1, true);              // channels: mono
  view.setUint32(24, sampleRate, true);     // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * 1ch * 2bytes)
  view.setUint16(32, 2, true);              // block align
  view.setUint16(34, 16, true);             // bits per sample

  // data chunk
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Convert float32 [-1, 1] → int16 and write directly into the buffer
  const pcm16 = new Int16Array(buffer, 44);
  let offset = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      pcm16[offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }

  return buffer;
}

/**
 * ArrayBuffer を base64 文字列にエンコードする。
 * String.fromCharCode.apply を 32 KB チャンクで呼び出すことで
 * 大きなバッファでもスタックオーバーフローを防ぐ。
 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // 32 768 bytes – apply() の安全な上限
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------
/** Start audio processing. tabStream and/or micMediaStream can be null. */
function emitIndependentUtterance(streamId, streamGeneration, sessionId, utterance) {
  if (!utterance.samples.length || !Number.isFinite(utterance.sampleRate)) return;
  const wavBuffer = encodeWav(utterance.samples, utterance.sampleRate);
  postToBackground({
    type: 'AUDIO_DATA',
    wavB64: bufferToBase64(wavBuffer),
    speechMs: utterance.speechMs,
    audioEndedAtMs: utterance.audioEndedAtMs,
    streamId,
    streamGeneration,
    sessionId,
    evidence: utterance.evidence,
  });
}

function startIndependentAudioProcessing(tabStream, micMediaStream, sessionId, generations = {}) {
  if (audioContext) stopIndependentAudioProcessing();
  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  const context = audioContext;
  audioPipelines = new Map();

  const connectStream = (streamId, stream, restoreTabAudio) => {
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const generation = Number.isSafeInteger(generations[streamId]) ? generations[streamId] : 0;
    const vad = createEnergyVad({
      streamId,
      onUtterance: (utterance) => emitIndependentUtterance(
        streamId, generation, sessionId, utterance
      ),
      onDiscard: (event) => bgLog('info', 'VAD: discarded ' + streamId + ' utterance (' + event.reason + ')'),
    });
    processor.onaudioprocess = (event) => {
      if (audioContext !== context) return;
      vad.process(event.inputBuffer.getChannelData(0), context.sampleRate);
    };
    source.connect(processor);
    processor.connect(context.destination);
    if (restoreTabAudio) source.connect(context.destination);
    audioPipelines.set(streamId, { source, processor, vad });
  };

  if (tabStream) {
    mediaStream = tabStream;
    connectStream('tab', tabStream, true);
  }
  if (micMediaStream) {
    micStream = micMediaStream;
    connectStream('mic', micMediaStream, false);
  }
  bgLog('info', 'started independent audio pipelines:', [...audioPipelines.keys()].join(','));
}

function stopIndependentAudioProcessing() {
  for (const [streamId, pipeline] of audioPipelines) {
    pipeline.vad.stop();
    pipeline.processor.disconnect();
    pipeline.source.disconnect();
    bgLog('info', 'stopped independent ' + streamId + ' audio pipeline');
  }
  audioPipelines.clear();
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  for (const stream of [mediaStream, micStream]) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }
  mediaStream = null;
  micStream = null;
}

// ---------------------------------------------------------------------------
// Private port to the service worker. Audio and candidate text never use the
// extension-wide runtime message broadcast, where a presenter page could hear it.
// ---------------------------------------------------------------------------
async function startAudio(payload) {
  if (activeSessionId) return { ok: false, reason: 'session-already-active' };
  const { streamId, audioSource, streamGenerations, sessionId, tabId, publishMicrophoneCaptions } = payload;
  let tabStream = null;
  let micMediaStream = null;

  if (audioSource !== 'mic-only' && streamId) {
    try {
      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      });
      tabStream.getVideoTracks().forEach((track) => track.stop());
    } catch (err) {
      bgLog('error', 'tab getUserMedia failed: ' + err.name + ' ' + err.message);
    }
  }

  if (audioSource !== 'tab-only') {
    try {
      micMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      bgLog('warn', 'mic getUserMedia failed: ' + err.name + ' ' + err.message);
    }
  }
  if (!tabStream && !micMediaStream) return { ok: false, reason: 'no-audio-source' };

  await storeReady;
  captionStore.setMicPublication(publishMicrophoneCaptions);
  const begun = captionStore.beginSession(sessionId, streamGenerations);
  if (!begun.ok) {
    for (const stream of [tabStream, micMediaStream]) {
      if (stream) stream.getTracks().forEach((track) => track.stop());
    }
    return begun;
  }
  try {
    activeSessionId = sessionId;
    activeTabId = tabId;
    activeStreamIds = [tabStream && 'tab', micMediaStream && 'mic'].filter(Boolean);
    activeStreamGenerations = { ...streamGenerations };
    startIndependentAudioProcessing(tabStream, micMediaStream, sessionId, streamGenerations);
    await persistCaptionStore();
    return { ok: true, sessionId, activeStreamIds, streamGenerations: activeStreamGenerations };
  } catch (err) {
    stopIndependentAudioProcessing();
    for (const stream of [tabStream, micMediaStream]) {
      if (stream) stream.getTracks().forEach((track) => track.stop());
    }
    captionStore.endSession(sessionId);
    activeSessionId = null;
    activeTabId = null;
    activeStreamIds = [];
    await persistCaptionStore();
    throw err;
  }
}

async function stopAudio() {
  const sessionId = activeSessionId;
  if (!sessionId) return { ok: true, inactive: true };
  stopIndependentAudioProcessing();
  const result = captionStore.endSession(sessionId);
  activeSessionId = null;
  activeTabId = null;
  activeStreamIds = [];
  await persistCaptionStore();
  return result;
}

async function runCaptionRpc(action, payload = {}) {
  await storeReady;
  switch (action) {
    case 'start-audio': return startAudio(payload);
    case 'stop-audio': return stopAudio();
    case 'snapshot-private': return captionStore.privateSnapshot();
    case 'snapshot-public': return captionStore.publicSnapshot();
    case 'upsert-candidate': return captionStore.upsertCandidate(payload.candidate);
    case 'approve': return captionStore.approve(payload.segmentId, payload.expectedRevision);
    case 'correct': return captionStore.correct(payload.segmentId, payload.sourceText, { expectedRevision: payload.expectedRevision });
    case 'undo': return captionStore.undo(payload.segmentId);
    case 'set-translation': return captionStore.setTranslation(
      payload.segmentId, payload.sourceRevision, payload.targetLanguage, payload.text, payload.state,
      { allowHistorical: payload.allowHistorical === true }
    );
    case 'set-mic-publication': return captionStore.setMicPublication(payload.enabled);
    default: return { ok: false, reason: 'unknown-caption-action' };
  }
}

async function handleBackgroundPortMessage(port, message) {
  if (port !== backgroundPort || !message) return;
  if (message.type === 'CAPTION_STORE_INIT') {
    initializeCaptionStore(message.state || {}, message.publishMicrophoneCaptions === true);
    await persistCaptionStore();
    postToBackground({
      type: 'OFFSCREEN_STATE',
      isActive: Boolean(activeSessionId),
      sessionId: activeSessionId,
      tabId: activeTabId,
      activeStreamIds,
      streamGenerations: activeStreamGenerations,
    });
    return;
  }
  if (message.type === 'OFFSCREEN_RECONNECT') {
    if (!captionStore) initializeCaptionStore(message.state || {}, message.publishMicrophoneCaptions === true);
    else if (captionStore.state().publishMicrophoneCaptions !== (message.publishMicrophoneCaptions === true)) {
      captionStore.setMicPublication(message.publishMicrophoneCaptions === true);
      await persistCaptionStore();
    }
    await storeReady;
    postToBackground({
      type: 'OFFSCREEN_STATE',
      isActive: Boolean(activeSessionId),
      sessionId: activeSessionId,
      tabId: activeTabId,
      activeStreamIds,
      streamGenerations: activeStreamGenerations,
    });
    return;
  }
  if (message.type === 'CAPTION_STORE_PERSISTED') {
    const pending = pendingPersistRequests.get(message.requestId);
    if (pending) {
      pendingPersistRequests.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message.ok === true);
    }
    return;
  }
  if (message.type === 'OFFSCREEN_QUERY_STATE') {
    await storeReady;
    postToBackground({
      type: 'OFFSCREEN_STATE',
      isActive: Boolean(activeSessionId),
      sessionId: activeSessionId,
      tabId: activeTabId,
      activeStreamIds,
      streamGenerations: activeStreamGenerations,
    });
    return;
  }
  if (message.type !== 'CAPTION_RPC' || typeof message.requestId !== 'string') return;
  try {
    const result = await runCaptionRpc(message.action, message.payload);
    const persisted = await persistCaptionStore();
    postToBackground({ type: 'CAPTION_RPC_RESULT', requestId: message.requestId, result, persisted });
  } catch (err) {
    postToBackground({
      type: 'CAPTION_RPC_RESULT',
      requestId: message.requestId,
      result: { ok: false, reason: err?.message || 'caption store error' },
    });
  }
}

connectToBackground();
