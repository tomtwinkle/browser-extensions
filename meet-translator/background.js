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
};

// ---------------------------------------------------------------------------
// Mock transcription + translation
// Replace this function with a real API call (e.g. Whisper + DeepL / Google
// Cloud Translation) when you are ready to wire up the backend.
// ---------------------------------------------------------------------------
async function transcribeAndTranslate(audioData) {
  // TODO: send audioData to a transcription API and translate the result
  return 'テスト翻訳です';
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

  state.isActive = true;
  state.tabId = tabId;

  try {
    // Make sure the offscreen document is ready for audio processing
    await ensureOffscreenDocument();

    // Obtain the tab capture stream ID.
    // The offscreen document will call navigator.mediaDevices.getUserMedia()
    // with this ID to get the actual MediaStream.
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, async (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        console.error('[background] tabCapture error:', chrome.runtime.lastError?.message);
        await stopCapture();
        return;
      }

      // Forward the stream ID to the offscreen document
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_START_AUDIO',
        streamId,
        tabId,
      });
    });
  } catch (err) {
    console.error('[background] startCapture failed:', err);
    await stopCapture();
  }
}

async function stopCapture() {
  if (!state.isActive) return;

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
      sendResponse({ isActive: state.isActive });
      return false;

    // ---- Audio data from the offscreen document -------------------------
    case 'AUDIO_DATA':
      if (!state.isActive) return false;
      (async () => {
        try {
          const translatedText = await transcribeAndTranslate(message.audioData);
          if (state.tabId && translatedText) {
            await chrome.tabs.sendMessage(state.tabId, {
              type: 'POST_TRANSLATION',
              text: translatedText,
            });
          }
        } catch (err) {
          console.error('[background] transcribeAndTranslate error:', err);
        }
      })();
      return false;

    default:
      return false;
  }
});
