/**
 * offscreen.js  –  Offscreen Document (Manifest V3)
 *
 * Responsibilities:
 *  1. Receive a tabCapture stream-ID from the background service worker.
 *  2. Attach to the tab audio stream via getUserMedia().
 *  3. Analyse audio with the Web Audio API (ScriptProcessor / AudioWorklet).
 *  4. Periodically forward audio buffers to the background worker, which
 *     hands them to transcribeAndTranslate().
 *
 * Audio is sent every SEND_INTERVAL_MS milliseconds regardless of silence,
 * so the mock implementation in background.js fires at a predictable rate.
 * A production implementation should add VAD (Voice Activity Detection).
 */

'use strict';

// How often (ms) a collected audio buffer is forwarded to the background
const SEND_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let mediaStream = null;
let collectedSamples = [];
let sendTimer = null;

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------
function startAudioProcessing(stream) {
  audioContext = new AudioContext();
  mediaStream = stream;

  sourceNode = audioContext.createMediaStreamSource(stream);

  // ScriptProcessorNode is deprecated but still universally supported.
  // Replace with an AudioWorklet before production deployment to avoid
  // deprecation warnings and improve audio processing performance.
  const bufferSize = 4096;
  processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  processorNode.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);
    // Keep a copy of this chunk (Float32Array → plain Array for serialisation)
    collectedSamples.push(Array.from(inputData));
  };

  sourceNode.connect(processorNode);
  // Connect to destination so the graph stays alive (but audio is not played
  // out because the offscreen document has no speakers attached)
  processorNode.connect(audioContext.destination);

  // Send accumulated audio to the background at regular intervals
  sendTimer = setInterval(sendAudioBuffer, SEND_INTERVAL_MS);
}

function sendAudioBuffer() {
  if (collectedSamples.length === 0) return;

  const audioData = collectedSamples;
  collectedSamples = [];

  // Send to background.js
  chrome.runtime.sendMessage({ type: 'AUDIO_DATA', audioData });
}

function stopAudioProcessing() {
  clearInterval(sendTimer);
  sendTimer = null;

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

  collectedSamples = [];
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {

    case 'OFFSCREEN_START_AUDIO': {
      const constraints = {
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: message.streamId,
          },
        },
        video: false,
      };

      navigator.mediaDevices
        .getUserMedia(constraints)
        .then((stream) => {
          startAudioProcessing(stream);
        })
        .catch((err) => {
          console.error('[offscreen] getUserMedia failed:', err);
        });
      break;
    }

    case 'OFFSCREEN_STOP_AUDIO':
      stopAudioProcessing();
      break;

    default:
      break;
  }
});
