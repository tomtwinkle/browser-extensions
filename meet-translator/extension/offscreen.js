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

// RMS above this triggers the confirmation phase (candidate speech start).
// Raised from 1.5e-3 to 3e-3 to filter keyboard clicks and background hum.
const SPEECH_RMS_THRESHOLD = 3e-3;

// RMS below this while SPEAKING counts as silence (hysteresis vs start threshold)
const SILENCE_RMS_THRESHOLD = 8e-4;

// How many milliseconds of continuous above-threshold audio must be observed
// before the state machine transitions SILENCE → SPEAKING.
// Prevents brief noise spikes (keyboard click, mic pop) from starting recording.
const SPEECH_CONFIRM_MS = 150;

// How many milliseconds of continuous silence ends an utterance
const SILENCE_AFTER_SPEECH_MS = 800;

// Safety cap: force-flush an utterance that exceeds this duration
const MAX_SPEECH_DURATION_MS = 15000;

// Minimum speech duration (ms) worth sending to the server
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
let vadState = 'SILENCE';  // 'SILENCE' | 'SPEAKING'
let speechSamples = [];    // Float32Array chunks for current utterance
let silenceMs = 0;         // accumulated silence duration while SPEAKING
let speechMs  = 0;         // accumulated speech duration for current utterance

// ---------------------------------------------------------------------------
// WAV encoder  (PCM 16-bit, mono)
// ---------------------------------------------------------------------------

/** Encode collected Float32Array chunks into a WAV ArrayBuffer. */
function encodeWav(chunks, sampleRate) {
  // Flatten all chunks into a single Float32Array
  const totalLength = chunks.reduce((s, c) => s + c.length, 0);
  const pcmFloat = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    pcmFloat.set(chunk, offset);
    offset += chunk.length;
  }

  // Convert float32 [-1, 1] to int16 [-32768, 32767]
  const pcm16 = new Int16Array(totalLength);
  for (let i = 0; i < totalLength; i++) {
    const s = Math.max(-1, Math.min(1, pcmFloat[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const dataBytes = pcm16.buffer.byteLength;
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
  view.setUint32(16, 16, true);         // chunk size
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // channels: mono
  view.setUint32(24, sampleRate, true); // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * 1ch * 2bytes)
  view.setUint16(32, 2, true);          // block align
  view.setUint16(34, 16, true);         // bits per sample

  // data chunk
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, 44).set(pcm16);

  return buffer;
}

/** Calculate RMS of a single Float32Array chunk. */
function calcRmsChunk(data) {
  let sumSq = 0;
  for (const s of data) { sumSq += s * s; }
  return data.length > 0 ? Math.sqrt(sumSq / data.length) : 0;
}

/** Encode and send the accumulated speech samples to the background worker. */
function flushSpeech(chunks) {
  if (chunks.length === 0) return;
  const sampleRate = audioContext ? audioContext.sampleRate : 48000;
  const wavBuffer = encodeWav(chunks, sampleRate);
  bgLog('info', 'sendAudioBuffer: sending WAV ' + wavBuffer.byteLength + ' bytes (end-of-speech)');
  // ArrayBuffer does not survive the offscreen→service-worker structured-clone boundary intact;
  // convert to a plain Array<number> so it round-trips safely.
  const wavBytes = Array.from(new Uint8Array(wavBuffer));
  chrome.runtime.sendMessage({ type: 'AUDIO_DATA', wavBytes });
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
  speechSamples = [];
  silenceMs = 0;
  speechMs  = 0;

  const bufferSize = 4096;
  processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
  processorNode.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);
    const sampleRate = audioContext ? audioContext.sampleRate : 48000;
    const chunkMs = (inputData.length / sampleRate) * 1000;
    const rms = calcRmsChunk(inputData);

    if (vadState === 'SILENCE') {
      if (rms > SPEECH_RMS_THRESHOLD) {
        // Speech detected – start accumulating
        vadState = 'SPEAKING';
        silenceMs = 0;
        speechMs  = chunkMs;
        speechSamples = [new Float32Array(inputData)];
        bgLog('info', 'VAD: speech start (RMS=' + rms.toFixed(6) + ')');
      }
    } else { // SPEAKING
      speechSamples.push(new Float32Array(inputData));
      speechMs += chunkMs;

      if (rms < SILENCE_RMS_THRESHOLD) {
        silenceMs += chunkMs;
        if (silenceMs >= SILENCE_AFTER_SPEECH_MS) {
          // End of utterance detected
          bgLog('info', 'VAD: speech end (speechMs=' + speechMs.toFixed(0) + ' silenceMs=' + silenceMs.toFixed(0) + ')');
          if (speechMs >= MIN_SPEECH_DURATION_MS) {
            flushSpeech(speechSamples);
          } else {
            bgLog('info', 'VAD: utterance too short, discarding');
          }
          vadState = 'SILENCE';
          speechSamples = [];
          silenceMs = 0;
          speechMs  = 0;
        }
      } else {
        // Still speaking – reset silence counter
        silenceMs = 0;
      }

      // Safety cap: flush if utterance is too long
      if (speechMs >= MAX_SPEECH_DURATION_MS) {
        bgLog('info', 'VAD: max duration reached, flushing (' + speechMs.toFixed(0) + 'ms)');
        flushSpeech(speechSamples);
        vadState = 'SILENCE';
        speechSamples = [];
        silenceMs = 0;
        speechMs  = 0;
      }
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
  if (vadState === 'SPEAKING' && speechMs >= MIN_SPEECH_DURATION_MS) {
    bgLog('info', 'VAD: flushing incomplete utterance on stop (' + speechMs.toFixed(0) + 'ms)');
    flushSpeech(speechSamples);
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
  speechSamples = [];
  silenceMs = 0;
  speechMs  = 0;
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
            const at = tabStream.getAudioTracks();
            bgLog('info', 'tab stream ok, audio tracks=' + at.length + ' video tracks=' + tabStream.getVideoTracks().length);
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
