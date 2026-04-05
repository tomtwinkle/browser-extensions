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

// How often (ms) a collected audio buffer is forwarded to the background
const SEND_INTERVAL_MS = 5000;

// RMS threshold below which a chunk is considered silent and not sent
const SILENCE_RMS_THRESHOLD = 5e-4;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
let audioContext  = null;
let sourceNode    = null;   // tab audio source
let micSourceNode = null;   // microphone source (optional)
let processorNode = null;
let mediaStream   = null;   // tab MediaStream
let micStream     = null;   // microphone MediaStream
let collectedSamples = []; // Array of Float32Array
let sendTimer = null;

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

/** Calculate RMS of collected Float32Array chunks. */
function calcRms(chunks) {
  let sumSq = 0;
  let count = 0;
  for (const chunk of chunks) {
    for (const s of chunk) { sumSq += s * s; count++; }
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
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

  const bufferSize = 4096;
  processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
  processorNode.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);
    collectedSamples.push(new Float32Array(inputData)); // copy the buffer
  };

  // Tab audio source (null when mic-only)
  if (tabStream) {
    mediaStream = tabStream;
    sourceNode = audioContext.createMediaStreamSource(tabStream);
    sourceNode.connect(processorNode);
  }

  // Microphone source – mixed into the same processor node (signals are summed)
  if (micMediaStream) {
    micStream = micMediaStream;
    micSourceNode = audioContext.createMediaStreamSource(micMediaStream);
    micSourceNode.connect(processorNode);
    bgLog('info', 'microphone source connected');
  }

  // Connect to destination so the graph stays alive
  processorNode.connect(audioContext.destination);

  sendTimer = setInterval(sendAudioBuffer, SEND_INTERVAL_MS);
}

function sendAudioBuffer() {
  if (collectedSamples.length === 0) {
    bgLog('info', 'sendAudioBuffer: no samples collected yet');
    return;
  }

  const chunks = collectedSamples;
  collectedSamples = [];

  // VAD: skip silent chunks
  const rms = calcRms(chunks);
  if (rms < SILENCE_RMS_THRESHOLD) {
    bgLog('info', 'sendAudioBuffer: silent (RMS=' + rms.toFixed(6) + '), skipping');
    return;
  }

  const sampleRate = audioContext ? audioContext.sampleRate : 48000;
  const wavBuffer = encodeWav(chunks, sampleRate);

  bgLog('info', 'sendAudioBuffer: sending WAV ' + wavBuffer.byteLength + ' bytes, RMS=' + rms.toFixed(6));
  // Send the WAV buffer to the background service worker.
  // chrome.runtime.sendMessage serialises via structured clone — no transfer list needed.
  chrome.runtime.sendMessage({ type: 'AUDIO_DATA', wavBuffer });
}

function stopAudioProcessing() {
  clearInterval(sendTimer);
  sendTimer = null;

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

  collectedSamples = [];
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
