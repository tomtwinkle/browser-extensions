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
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_LOG', level, msg }).catch(() => {});
}

bgLog('info', 'script loaded');

// ---------------------------------------------------------------------------
// Voice Activity Detection (VAD) parameters
// ---------------------------------------------------------------------------

// Smoothing factor for exponential moving average of RMS (0 < α ≤ 1).
// Lower values give more smoothing and reject short transient noise better,
// but slow down detection of actual speech onset.
const RMS_EMA_ALPHA = 0.5;

// Minimum smoothed RMS above this triggers the confirmation phase.
// Adaptive logic may raise the effective threshold when the session noise floor climbs.
const SPEECH_RMS_THRESHOLD = 3e-3;

// Minimum smoothed RMS below this while SPEAKING counts as silence (hysteresis).
// Adaptive logic may raise the effective threshold when the session noise floor climbs.
const SILENCE_RMS_THRESHOLD = 8e-4;

// Slow running estimate of the session noise floor. Update it only during
// clearly quiet stretches so sustained speech does not poison the baseline.
const NOISE_FLOOR_RISE_ALPHA = 0.05;
const NOISE_FLOOR_FALL_ALPHA = 0.01;
const NOISE_FLOOR_UPDATE_GATE = 0.75;
const MIN_NOISE_FLOOR_RMS = 1e-4;

// Require speech to clear the current noise floor by both a ratio and a small
// absolute margin. This helps suppress HVAC hum / fan noise / AGC drift during
// long meetings without making quiet rooms harder to capture.
const SPEECH_TO_NOISE_RATIO = 1.8;
const SPEECH_TO_NOISE_MARGIN = 8e-4;

// Let the silence threshold follow the noise floor more gently than the speech
// start threshold so natural within-speech dips still survive.
const SILENCE_TO_NOISE_RATIO = 1.25;

// Drop utterances whose active speech energy never separated enough from the
// captured noise floor. This keeps very low-SNR chunks away from Whisper.
const MIN_ACTIVE_SPEECH_TO_NOISE_RATIO = 1.35;
const MIN_PEAK_SPEECH_TO_NOISE_RATIO = 1.8;

// How many milliseconds of continuous above-threshold audio must be observed
// before the state machine transitions CONFIRMING → SPEAKING.
// Prevents brief noise spikes (keyboard click, mic pop, cough) from starting recording.
const SPEECH_CONFIRM_MS = 200;

// How many milliseconds of continuous silence ends an utterance.
const SILENCE_AFTER_SPEECH_MS = 800;

// Safety cap: force-flush an utterance that exceeds this duration.
const MAX_SPEECH_DURATION_MS = 15000;

// Minimum speech duration (ms) worth sending to the server.
const MIN_SPEECH_DURATION_MS = 500;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
let audioContext  = null;
let sourceNode    = null;   // tab audio source
let micSourceNode = null;   // microphone source (optional)
let processorNode = null;
let mediaStream   = null;   // tab MediaStream
let micStream     = null;   // microphone MediaStream

// VAD state machine
// States: 'SILENCE' | 'CONFIRMING' | 'SPEAKING'
//
//  SILENCE ──(RMS > speechStartThreshold)──► CONFIRMING
//              │                                │
//              │  (RMS drops / timeout)         │ (confirmMs >= SPEECH_CONFIRM_MS)
//              ◄────────────────────────────────┤
//                                               ▼
//                                           SPEAKING
//                                               │
//                 (RMS < silenceThreshold for SILENCE_AFTER_SPEECH_MS)
//                                               ▼
//                                           SILENCE
//
let vadState = 'SILENCE';
let speechSamples  = [];   // Float32Array chunks for the confirmed utterance
let confirmSamples = [];   // buffered chunks during CONFIRMING (prepended to speechSamples)
let silenceMs  = 0;        // accumulated silence while SPEAKING
let speechMs   = 0;        // accumulated speech duration for current utterance
let confirmMs  = 0;        // accumulated above-threshold time while CONFIRMING
let smoothedRms = 0;       // exponential moving average of RMS
let noiseFloorRms = 0;     // slow-running baseline noise estimate
let speechActiveRmsSum = 0;
let speechActiveChunks = 0;
let speechPeakRms = 0;
let speechNoiseFloorRms = 0;

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

/** Calculate RMS of a single Float32Array chunk. */
function calcRmsChunk(data) {
  let sumSq = 0;
  for (const s of data) { sumSq += s * s; }
  return data.length > 0 ? Math.sqrt(sumSq / data.length) : 0;
}

function updateNoiseFloor(rms) {
  const clampedRms = Math.max(rms, MIN_NOISE_FLOOR_RMS);
  if (noiseFloorRms === 0) {
    noiseFloorRms = clampedRms;
    return;
  }
  const alpha = clampedRms > noiseFloorRms ? NOISE_FLOOR_RISE_ALPHA : NOISE_FLOOR_FALL_ALPHA;
  noiseFloorRms = alpha * clampedRms + (1 - alpha) * noiseFloorRms;
}

function getSpeechStartThreshold() {
  return Math.max(
    SPEECH_RMS_THRESHOLD,
    noiseFloorRms * SPEECH_TO_NOISE_RATIO,
    noiseFloorRms + SPEECH_TO_NOISE_MARGIN
  );
}

function getSilenceThreshold() {
  return Math.max(
    SILENCE_RMS_THRESHOLD,
    noiseFloorRms * SILENCE_TO_NOISE_RATIO
  );
}

function resetSpeechState() {
  speechSamples = [];
  silenceMs = 0;
  speechMs = 0;
  speechActiveRmsSum = 0;
  speechActiveChunks = 0;
  speechPeakRms = 0;
  speechNoiseFloorRms = 0;
}

function trackSpeechChunkRms(rms, silenceThreshold) {
  speechPeakRms = Math.max(speechPeakRms, rms);
  if (rms >= silenceThreshold) {
    speechActiveRmsSum += rms;
    speechActiveChunks += 1;
  }
}

function initializeSpeechTracking(silenceThreshold) {
  speechActiveRmsSum = 0;
  speechActiveChunks = 0;
  speechPeakRms = 0;
  speechNoiseFloorRms = noiseFloorRms;
  for (const chunk of speechSamples) {
    trackSpeechChunkRms(calcRmsChunk(chunk), silenceThreshold);
  }
}

function evaluateSpeechForFlush() {
  const baselineNoise = Math.max(speechNoiseFloorRms, MIN_NOISE_FLOOR_RMS);
  const avgActiveRms = speechActiveChunks > 0 ? speechActiveRmsSum / speechActiveChunks : 0;
  const minAvgActiveRms = Math.max(SILENCE_RMS_THRESHOLD, baselineNoise * MIN_ACTIVE_SPEECH_TO_NOISE_RATIO);
  const minPeakRms = Math.max(SPEECH_RMS_THRESHOLD, baselineNoise * MIN_PEAK_SPEECH_TO_NOISE_RATIO);

  if (speechMs < MIN_SPEECH_DURATION_MS) {
    return {
      shouldFlush: false,
      reason: 'utterance too short',
      baselineNoise,
      avgActiveRms,
      minAvgActiveRms,
      minPeakRms,
    };
  }
  if (speechPeakRms < minPeakRms) {
    return {
      shouldFlush: false,
      reason: 'peak RMS too close to noise floor',
      baselineNoise,
      avgActiveRms,
      minAvgActiveRms,
      minPeakRms,
    };
  }
  if (avgActiveRms < minAvgActiveRms) {
    return {
      shouldFlush: false,
      reason: 'average RMS too close to noise floor',
      baselineNoise,
      avgActiveRms,
      minAvgActiveRms,
      minPeakRms,
    };
  }
  return {
    shouldFlush: true,
    baselineNoise,
    avgActiveRms,
    minAvgActiveRms,
    minPeakRms,
  };
}

function finishSpeech(reason) {
  const verdict = evaluateSpeechForFlush();
  bgLog(
    'info',
    'VAD: speech end (' + reason +
      ', speechMs=' + speechMs.toFixed(0) + 'ms' +
      ', silenceMs=' + silenceMs.toFixed(0) + 'ms' +
      ', noiseFloor=' + verdict.baselineNoise.toFixed(6) +
      ', avgActiveRms=' + verdict.avgActiveRms.toFixed(6) +
      ', peakRms=' + speechPeakRms.toFixed(6) + ')'
  );
  if (verdict.shouldFlush) {
    flushSpeech(speechSamples);
  } else {
    bgLog(
      'info',
      'VAD: discarding utterance (' + verdict.reason +
        ', minAvgActiveRms=' + verdict.minAvgActiveRms.toFixed(6) +
        ', minPeakRms=' + verdict.minPeakRms.toFixed(6) + ')'
    );
  }
  vadState = 'SILENCE';
  resetSpeechState();
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

/** Encode and send the accumulated speech samples to the background worker. */
function flushSpeech(chunks) {
  if (chunks.length === 0) return;
  const sampleRate = audioContext ? audioContext.sampleRate : 48000;
  const wavBuffer = encodeWav(chunks, sampleRate);
  bgLog('info', 'sendAudioBuffer: sending WAV ' + wavBuffer.byteLength + ' bytes (end-of-speech)');
  // WAV を base64 文字列として送る。
  // Uint8Array / ArrayBuffer をそのまま sendMessage に渡すと、Chrome が
  // structured-clone で backing ArrayBuffer を転送（detach）し、受信側で
  // byteLength === 0 になる場合がある（→ サーバーで RIFF ヘッダー読み取りエラー）。
  // 文字列は必ずコピーされるため安全。Array<number> より約 3 倍コンパクト。
  chrome.runtime.sendMessage({ type: 'AUDIO_DATA', wavB64: bufferToBase64(wavBuffer) });
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------
/** Start audio processing. tabStream and/or micMediaStream can be null. */
function startAudioProcessing(tabStream, micMediaStream) {
  audioContext = new AudioContext();
  bgLog('info', 'AudioContext created, state=' + audioContext.state + ' sampleRate=' + audioContext.sampleRate);

  // Resume in case AudioContext starts suspended (Chrome autoplay policy)
  if (audioContext.state === 'suspended') {
    audioContext.resume().then(() => bgLog('info', 'AudioContext resumed'));
  }

  // Reset VAD state
  vadState = 'SILENCE';
  resetSpeechState();
  confirmSamples = [];
  confirmMs  = 0;
  smoothedRms = 0;
  noiseFloorRms = 0;

  const bufferSize = 4096;
  processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
  processorNode.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);
    const sampleRate = audioContext ? audioContext.sampleRate : 48000;
    const chunkMs = (inputData.length / sampleRate) * 1000;
    const rms = calcRmsChunk(inputData);

    // Exponential moving average smooths out transient spikes (keyboard clicks, etc.)
    smoothedRms = RMS_EMA_ALPHA * rms + (1 - RMS_EMA_ALPHA) * smoothedRms;
    const speechStartThreshold = getSpeechStartThreshold();
    const silenceThreshold = getSilenceThreshold();

    if (vadState === 'SILENCE') {
      if (smoothedRms > speechStartThreshold) {
        // Possible speech – enter confirmation phase
        vadState = 'CONFIRMING';
        confirmMs = chunkMs;
        confirmSamples = [new Float32Array(inputData)];
        bgLog(
          'info',
          'VAD: confirming (smoothedRms=' + smoothedRms.toFixed(6) +
            ', noiseFloor=' + noiseFloorRms.toFixed(6) +
            ', threshold=' + speechStartThreshold.toFixed(6) + ')'
        );
      }

    } else if (vadState === 'CONFIRMING') {
      if (smoothedRms > speechStartThreshold) {
        // Signal still above threshold – keep accumulating
        confirmSamples.push(new Float32Array(inputData));
        confirmMs += chunkMs;

        if (confirmMs >= SPEECH_CONFIRM_MS) {
          // Confirmed sustained speech – transition to SPEAKING
          vadState = 'SPEAKING';
          speechSamples = confirmSamples;
          speechMs = confirmMs;
          silenceMs = 0;
          initializeSpeechTracking(silenceThreshold);
          confirmSamples = [];
          confirmMs = 0;
          bgLog('info', 'VAD: speech confirmed (smoothedRms=' + smoothedRms.toFixed(6) +
            ', confirmDuration=' + speechMs.toFixed(0) + 'ms' +
            ', noiseFloor=' + speechNoiseFloorRms.toFixed(6) +
            ', threshold=' + speechStartThreshold.toFixed(6) + ')');
        }
      } else {
        // Signal dropped – was transient noise, not speech; discard and go back to SILENCE
        bgLog('info', 'VAD: transient noise discarded (confirmMs=' + confirmMs.toFixed(0) +
          'ms, smoothedRms=' + smoothedRms.toFixed(6) +
          ', threshold=' + speechStartThreshold.toFixed(6) + ')');
        vadState = 'SILENCE';
        confirmSamples = [];
        confirmMs = 0;
      }

    } else { // SPEAKING
      speechSamples.push(new Float32Array(inputData));
      speechMs += chunkMs;
      trackSpeechChunkRms(rms, silenceThreshold);

      if (smoothedRms < silenceThreshold) {
        silenceMs += chunkMs;
        if (silenceMs >= SILENCE_AFTER_SPEECH_MS) {
          finishSpeech('silence');
        }
      } else {
        // Still speaking – reset silence counter
        silenceMs = 0;
      }

      // Safety cap: flush if utterance is too long
      if (speechMs >= MAX_SPEECH_DURATION_MS) {
        bgLog('info', 'VAD: max duration reached, evaluating flush (' + speechMs.toFixed(0) + 'ms)');
        finishSpeech('max-duration');
      }
    }

    if (vadState === 'SILENCE' && smoothedRms <= speechStartThreshold * NOISE_FLOOR_UPDATE_GATE) {
      updateNoiseFloor(smoothedRms);
    }
  };

  // Tab audio source (null when mic-only)
  if (tabStream) {
    mediaStream = tabStream;
    sourceNode = audioContext.createMediaStreamSource(tabStream);
    sourceNode.connect(processorNode);
    // Tab capture mutes the original tab audio; route it back to the speakers
    // so the user can still hear the other participants.
    sourceNode.connect(audioContext.destination);
  }

  // Microphone source – mixed into the same processor node (signals are summed).
  // Mic is NOT routed to destination to avoid feedback.
  if (micMediaStream) {
    micStream = micMediaStream;
    micSourceNode = audioContext.createMediaStreamSource(micMediaStream);
    micSourceNode.connect(processorNode);
    bgLog('info', 'microphone source connected');
  }

  // Keep the processor node alive in the graph (its output is silence, used for VAD only)
  processorNode.connect(audioContext.destination);
}

function stopAudioProcessing() {
  // Flush any in-progress utterance before tearing down
  if (vadState === 'SPEAKING' && speechSamples.length > 0) {
    bgLog('info', 'VAD: evaluating incomplete utterance on stop (' + speechMs.toFixed(0) + 'ms)');
    finishSpeech('stop');
  }

  if (micSourceNode) {
    micSourceNode.disconnect();
    micSourceNode = null;
  }
  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }

  vadState = 'SILENCE';
  resetSpeechState();
  confirmSamples = [];
  confirmMs  = 0;
  smoothedRms = 0;
  noiseFloorRms = 0;
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    case 'OFFSCREEN_START_AUDIO': {
      bgLog('info', 'OFFSCREEN_START_AUDIO received, audioSource=' + message.audioSource);
      // Acknowledge receipt synchronously so background.js knows the doc is ready
      sendResponse({ ack: true });

      const { streamId, audioSource } = message;
      (async () => {
        // --- Tab stream ---
        let tabStream = null;
        if (audioSource !== 'mic-only' && streamId) {
          bgLog('info', 'calling getUserMedia (tab)...');
          try {
            tabStream = await navigator.mediaDevices.getUserMedia({
              audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
              video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
            });
            // Chrome requires the video constraint for tab capture, but we only
            // need audio. Stop the video tracks immediately to free the frame
            // buffers, which can otherwise consume tens of MB throughout the session.
            tabStream.getVideoTracks().forEach((t) => t.stop());
            const at = tabStream.getAudioTracks();
            bgLog('info', 'tab stream ok, audio tracks=' + at.length + ' (video tracks stopped)');
            at.forEach((t) => bgLog('info', 'tab audio: label=' + t.label + ' enabled=' + t.enabled + ' state=' + t.readyState));
          } catch (err) {
            bgLog('error', 'tab getUserMedia failed: ' + err.name + ' ' + err.message);
          }
        }

        // --- Microphone stream ---
        let micMediaStream = null;
        if (audioSource !== 'tab-only') {
          bgLog('info', 'calling getUserMedia (mic)...');
          try {
            micMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            bgLog('info', 'mic stream ok, tracks=' + micMediaStream.getAudioTracks().length);
          } catch (err) {
            bgLog('warn', 'mic getUserMedia failed (continuing without mic): ' + err.name + ' ' + err.message);
          }
        }

        if (!tabStream && !micMediaStream) {
          bgLog('error', 'no audio source available – aborting');
          return;
        }

        startAudioProcessing(tabStream, micMediaStream);
      })();
      return false; // sendResponse was already called synchronously
    }

    case 'OFFSCREEN_STOP_AUDIO':
      stopAudioProcessing();
      break;

    default:
      break;
  }
});
