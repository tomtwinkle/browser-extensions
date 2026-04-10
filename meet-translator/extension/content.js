/**
 * content.js  –  Content Script (injected into https://meet.google.com/*)
 *
 * Responsibilities:
 *  1. Listen for POST_TRANSLATION messages from the background worker.
 *  2. Locate the Google Meet chat textarea and send button in the DOM.
 *  3. Detect the currently highlighted speaker in the Meet DOM.
 *  4. Programmatically fill the input and submit the message.
 *  5. Show an in-call feedback widget so users can upsert glossary entries.
 *
 * DOM selector notes
 * ------------------
 * Google Meet has two chat UI modes:
 *
 * Mode A – Classic Meet chat (older UI)
 *   • Message input: div[jsname="r4nke"] or div[contenteditable="true"]
 *   • Send button:   button[jsname="c6xSqd"]
 *
 * Mode B – Embedded Google Chat ("履歴がオンになっています" / "History is on")
 *   • Meet embeds the full Google Chat web component (c-wiz / d-view).
 *   • The message input is a div[contenteditable] (value may be "" not "true")
 *     with an aria-label like "メッセージを送信…" / "Send a message…".
 *   • A SEARCH input (aria-label="Chat を検索…" / "Search Chat") is also
 *     present and must NOT be confused with the message input.
 *
 * If Meet changes its DOM again, open DevTools → find the message input →
 * update SEL.messageInput or the fallback search in findMessageInput().
 */

'use strict';

const {
  normalizeSpeakerName,
  parseSpeakerNameFromAriaLabel,
} = globalThis.MeetTranslatorShared;

// ---------------------------------------------------------------------------
// DOM selectors  (update these if Meet changes its markup)
// ---------------------------------------------------------------------------
const SEL = {
  // Toolbar button that opens the in-call chat panel.
  chatPanelButton: [
    'button[aria-label*="Chat with everyone"]',  // en
    'button[aria-label*="チャット"]',             // ja
    '[data-panel-id="2"]',
  ].join(', '),

  // Message composition input – two patterns observed in 2025:
  //
  // Pattern 1 – History OFF (textarea):
  //   <textarea jsname="YPqjbf" aria-label="メッセージを送信" placeholder="メッセージを送信">
  //
  // Pattern 2 – History ON (contenteditable div):
  //   <div jsname="yrriRe" g_editable="true" contenteditable="true"
  //        aria-label="履歴がオンになっています" role="textbox">
  //
  // Note: in Pattern 2, aria-label reflects the history SETTING, not the
  //       action ("send message"), so selectors like aria-label*="メッセージを送信"
  //       do NOT match it.  jsname and g_editable are the reliable identifiers.
  messageInput: [
    // Classic Meet (old UI, stable internal attribute)
    '[jsname="r4nke"]',
    // Pattern 1 – Google Chat history OFF / textarea (stable internal attribute)
    '[jsname="YPqjbf"]',
    // Pattern 2 – Google Chat history ON / contenteditable div (stable internal attribute)
    '[jsname="yrriRe"]',
    // Pattern 2 – Google Chat editable marker (g_editable on all GChat message inputs)
    'div[g_editable="true"][contenteditable="true"]',
    // Pattern 2 – aria-label reflects history state (ja)
    'div[contenteditable="true"][aria-label*="履歴がオンになっています"]',
    'div[contenteditable="true"][aria-label*="履歴がオフになっています"]',
    // Pattern 2 – aria-label reflects history state (en)
    'div[contenteditable="true"][aria-label*="History is on"]',
    'div[contenteditable="true"][aria-label*="History is off"]',
    // Classic Meet / generic contenteditable with message aria-label (en / ja)
    'div[contenteditable="true"][aria-label*="message"]',
    'div[contenteditable="true"][aria-label*="メッセージ"]',
    // Embedded Google Chat – send-message aria-label variants (ja / en)
    'div[contenteditable][aria-label*="メッセージを送信"]',
    'div[contenteditable][aria-label*="全員にメッセージ"]',
    'div[contenteditable][aria-label*="Send a message"]',
    'div[contenteditable][aria-label*="Message everyone"]',
    // Pattern 1 – textarea with send-message aria-label (ja / en)
    'textarea[aria-label*="メッセージを送信"]',
    'textarea[aria-label*="Send a message"]',
    'textarea[aria-label*="message"]',
    'textarea[aria-label*="メッセージ"]',
  ].join(', '),

  // Send button adjacent to the message input.
  sendButton: [
    'button[jsname="c6xSqd"]',          // Mode A (internal attr)
    'button[aria-label="Send message"]', // en exact
    'button[aria-label="メッセージを送信"]', // ja exact
    'button[aria-label*="送信"]',        // ja partial fallback
  ].join(', '),
};

const SPEAKER_TILE_SEL = 'div[jscontroller="gu0YGc"]';
const ACTIVE_SPEAKER_BORDER_SEL = '.tC2Wod.fdKMD';
const ACTIVE_SPEAKER_GLOW_SEL = `${ACTIVE_SPEAKER_BORDER_SEL}.v5h6Xc`;
const ACTIVE_SPEAKER_VISIBLE_SEL = `${ACTIVE_SPEAKER_BORDER_SEL}.kssMZb`;
const FEEDBACK_ROOT_ID = 'meet-translator-feedback';
const FEEDBACK_FORM_ID = 'mt-feedback-form';
const feedbackState = {
  isOpen: false,
  statusText: '',
  statusError: false,
  speakerName: '',
  original: '',
  translation: '',
};

// ---------------------------------------------------------------------------
// Helper: check element visibility (not hidden, not zero-size)
// ---------------------------------------------------------------------------
function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (el.hidden) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

// ---------------------------------------------------------------------------
// Helper: detect embedded Google Chat mode
//
// When Meet uses the embedded Google Chat ("履歴がオンになっています" / "History is on"),
// the chat UI is loaded in a cross-origin iframe from chat.google.com.
// The content script cannot reach it from the meet.google.com frame –
// instead, the content script running INSIDE that iframe handles posting.
// ---------------------------------------------------------------------------
function isEmbeddedChatMode() {
  return !!document.querySelector('iframe[src*="chat.google.com"]');
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: detect the active speaker tile in the Meet main frame
// ---------------------------------------------------------------------------
function extractSpeakerNameFromTile(tile) {
  if (!tile) return null;

  const seen = new Set();
  for (const el of tile.querySelectorAll('[aria-label]')) {
    const label = normalizeSpeakerName(el.getAttribute('aria-label'));
    if (!label || seen.has(label)) continue;
    seen.add(label);

    const parsed = parseSpeakerNameFromAriaLabel(label);
    if (parsed) return parsed;
  }

  const textFallbacks = [
    tile.querySelector('.P245vb')?.textContent,
    tile.querySelector('[jsname="YQuObe"]')?.textContent,
  ];
  for (const text of textFallbacks) {
    const candidate = normalizeSpeakerName(text);
    if (candidate && !/(固定|ミュート|History|履歴)/i.test(candidate)) return candidate;
  }

  return null;
}

function findActiveSpeakerTile() {
  for (const selector of [ACTIVE_SPEAKER_GLOW_SEL, ACTIVE_SPEAKER_VISIBLE_SEL]) {
    for (const border of document.querySelectorAll(selector)) {
      if (!isElementVisible(border)) continue;
      const tile = border.closest(SPEAKER_TILE_SEL);
      if (tile) return tile;
    }
  }
  return null;
}

function getActiveSpeakerName() {
  if (location.hostname !== 'meet.google.com' || window !== window.top) return null;
  return extractSpeakerNameFromTile(findActiveSpeakerTile());
}

// ---------------------------------------------------------------------------
// Helper: find the message input in the CURRENT document
// ---------------------------------------------------------------------------
function findMessageInput() {
  // Fast path: CSS selectors
  for (const el of document.querySelectorAll(SEL.messageInput)) {
    if (isElementVisible(el)) return el;
  }

  // Fallback: search inside Google Chat's d-view panel component
  for (const dview of document.querySelectorAll('d-view')) {
    for (const el of dview.querySelectorAll('div[contenteditable]:not([contenteditable="false"])')) {
      if (!isElementVisible(el)) continue;
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      // Skip search box ("Chat を検索…" / "Search Chat")
      if (label.includes('検索') || label.includes('search')) continue;
      return el;
    }
  }

  // Last resort: any visible Google Chat editable div
  for (const el of document.querySelectorAll('div[g_editable="true"][contenteditable]')) {
    if (isElementVisible(el)) return el;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: wait for findMessageInput() to return a non-null element
// ---------------------------------------------------------------------------
function waitForMessageInput(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const existing = findMessageInput();
    if (existing) { resolve(existing); return; }

    const observer = new MutationObserver(() => {
      const el = findMessageInput();
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Helper: ensure the chat panel is visible
// ---------------------------------------------------------------------------
async function ensureChatPanelOpen() {
  // If the message input is already visible, no need to open the panel
  if (findMessageInput()) return;

  const chatBtn = document.querySelector(SEL.chatPanelButton);
  if (chatBtn) {
    chatBtn.click();
    // Wait for the panel to render (covers both UI modes)
    await waitForMessageInput(3000);
  }
}

// ---------------------------------------------------------------------------
// Core: post translated text to the Meet chat
// ---------------------------------------------------------------------------
async function postToChat(text) {
  // 1. Make sure the chat panel is open
  await ensureChatPanelOpen();

  // 2. Locate the message input (handles both classic Meet and embedded Chat)
  const input = findMessageInput();
  if (!input) {
    throw new Error('チャット入力欄が見つかりませんでした。チャットパネルを開いてください。');
  }

  // 3. Focus and fill the input
  input.focus();

  // isContentEditable is true for both contenteditable="true" and contenteditable=""
  if (input.isContentEditable) {
    // contenteditable div (Google Meet classic / embedded Google Chat)
    // execCommand('insertText') triggers both native and Closure Library events.
    input.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  } else {
    // Plain <textarea> (Google Chat history-off pattern: jsname="YPqjbf")
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    ).set;
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 4. Small delay so the UI can process the input event
  await new Promise((r) => setTimeout(r, 150));

  // 5. Click the send button (preferred) or press Enter
  const sendBtn = document.querySelector(SEL.sendButton);
  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    // Fallback: simulate Enter key (works in both classic Meet and embedded Google Chat)
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keypress', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
  }
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'GET_ACTIVE_SPEAKER':
      if (location.hostname === 'meet.google.com' && window === window.top) {
        sendResponse({ speakerName: getActiveSpeakerName() });
      }
      return false;

    case 'UPDATE_FEEDBACK_CONTEXT':
      if (location.hostname === 'meet.google.com' && window === window.top) {
        updateFeedbackContext(message);
      }
      sendResponse({ success: true });
      return false;

    case 'POST_TRANSLATION': {
      // With all_frames:true, this script runs in both the meet.google.com
      // main frame AND the chat.google.com iframe.
      //
      // Embedded Chat mode: the input lives in the chat.google.com iframe.
      //   • meet.google.com frame  → isEmbeddedChatMode()=true, no input here
      //                              → return false (let iframe handle it)
      //   • chat.google.com iframe → location.hostname='chat.google.com'
      //                              → handle it here
      //
      // Classic Meet mode: input is in the meet.google.com frame itself.
      //   • isEmbeddedChatMode()=false → handle it here
      if (location.hostname !== 'chat.google.com' && isEmbeddedChatMode()) {
        // Embedded Chat mode and we're in the main Meet frame – delegate to iframe
        return false;
      }
      postToChat(message.text)
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          console.error('[Meet Translator] チャット投稿エラー:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true; // keep channel open for async response
    }

    case 'TRANSLATION_STOPPED':
      console.log('[Meet Translator] 自動翻訳チャットを停止しました。');
      destroyOverlay();
      destroyFeedbackUi();
      sendResponse({ success: true });
      return false;

    case 'SHOW_OVERLAY':
      // Only the meet.google.com top frame renders the overlay.
      if (location.hostname === 'meet.google.com' && window === window.top) {
        showOverlay(message.original, message.translation, message.scroll, message.speakerName || null);
      }
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

console.log('[Meet Translator] content script loaded on', location.href);

// ---------------------------------------------------------------------------
// Overlay display (subtitle mode / scroll mode)
// ---------------------------------------------------------------------------

const OVERLAY_ID       = 'meet-translator-overlay';
const SUBTITLE_HIDE_MS = 8000; // fixed subtitle: hide after this long with no new text

// Selector for the Google Meet video area (the main stage, not the full viewport).
//
// DOM analysis of the Google Meet HTML (2025/2026):
//   <main class="axUSnc ..." jscontroller="izfDQc"
//         style="inset: 70px 392px 132px 16px;">
//     ...video tiles...
//   </main>
//
// The <main> element is position:absolute with its inset driven dynamically
// by Meet JS to match the area between the toolbar (top), control bar (bottom)
// and side panels (right).  It has NO overflow:hidden so overlays are not
// clipped.  Children with position:absolute;inset:0 fill exactly this region.
//
// Note: div[jscontroller="h8UR3d"] (class="tTdl5d") is an individual video
// tile overlay control INSIDE a tile wrapper (div.p2hjYe) that has
// overflow:hidden — appending the overlay there clips the subtitle/scroll text.
//
// Selector priority:
//   1. main[jscontroller="izfDQc"]  — current Meet build (verified 2025-04)
//   2. main                         — semantic fallback (one <main> per page)
//   3. document.body                — last-resort fallback
const VIDEO_AREA_SEL = 'main[jscontroller="izfDQc"], main';

// --- Scroll mode constants -------------------------------------------------
// Number of horizontal lanes distributed vertically across the screen.
const LANE_COUNT  = 5;
// Minimum vertical margin (fraction of viewport height) from top and bottom.
const LANE_MARGIN = 0.08;
// How long (ms) each entry takes to scroll across the full viewport width.
// Scales with text length so longer lines don't feel rushed.
const BASE_SCROLL_MS = 7000;
const MS_PER_CHAR    = 60;
// How long to keep the entry visible after the animation completes.
const FADE_DELAY_MS  = 300;

// Track which lanes are occupied so we can avoid collisions.
const laneOccupied = new Array(LANE_COUNT).fill(false);
let lanePointer = 0; // round-robin pointer

// --- Subtitle mode state --------------------------------------------------
let subtitleHideTimer = null;

// ResizeObserver that keeps --mt-cw in sync with the video container width.
// Disconnected in destroyOverlay().
let containerResizeObserver = null;

/** Inject shared CSS once. */
function ensureOverlayStyles() {
  if (document.getElementById('meet-translator-overlay-style')) return;
  const style = document.createElement('style');
  style.id = 'meet-translator-overlay-style';
  style.textContent = `
    #${OVERLAY_ID} {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
      overflow: hidden;
      /* --mt-cw is set dynamically to the video container width.
         Falls back to 100vw when the overlay is on document.body. */
      --mt-cw: 100vw;
    }

    #${FEEDBACK_ROOT_ID} {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2147483646;
    }
    #${FEEDBACK_ROOT_ID}.mt-body-anchor {
      position: fixed;
    }
    #mt-feedback-widget {
      position: absolute;
      right: 16px;
      bottom: 16px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      pointer-events: none;
    }
    #mt-feedback-toggle,
    #mt-feedback-panel,
    #mt-feedback-panel * {
      pointer-events: auto;
    }
    #mt-feedback-toggle {
      border: 0;
      border-radius: 9999px;
      background: rgba(17, 17, 17, 0.86);
      color: #fff;
      font-size: 13px;
      font-weight: 700;
      padding: 8px 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
      cursor: pointer;
    }
    #mt-feedback-toggle:disabled {
      cursor: default;
      opacity: 0.55;
    }
    #mt-feedback-widget.mt-open #mt-feedback-toggle {
      background: rgba(31, 31, 31, 0.95);
    }
    #mt-feedback-panel {
      display: none;
      width: min(360px, calc(100vw - 32px));
      box-sizing: border-box;
      padding: 12px;
      border-radius: 12px;
      background: rgba(17, 17, 17, 0.94);
      color: #f5f5f5;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(6px);
    }
    #mt-feedback-widget.mt-open #mt-feedback-panel {
      display: block;
    }
    .mt-feedback-title {
      margin: 0 0 6px;
      font-size: 15px;
      font-weight: 700;
    }
    .mt-feedback-meta {
      margin-bottom: 10px;
      color: #b9d6ff;
      font-size: 12px;
      font-weight: 600;
    }
    .mt-feedback-context {
      display: grid;
      gap: 8px;
      margin-bottom: 10px;
    }
    .mt-feedback-row {
      display: grid;
      gap: 4px;
    }
    .mt-feedback-label {
      color: #aab4c8;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .mt-feedback-value {
      max-height: 4.8em;
      overflow: hidden;
      color: #f5f5f5;
      font-size: 12px;
      line-height: 1.4;
      word-break: break-word;
    }
    .mt-feedback-form {
      display: grid;
      gap: 10px;
    }
    .mt-feedback-field {
      display: grid;
      gap: 4px;
    }
    .mt-feedback-field > span {
      color: #d5d9e1;
      font-size: 12px;
      font-weight: 600;
    }
    .mt-feedback-input,
    .mt-feedback-select {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      padding: 8px 10px;
      font-size: 13px;
    }
    .mt-feedback-input::placeholder {
      color: rgba(255, 255, 255, 0.45);
    }
    .mt-feedback-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .mt-feedback-button {
      border: 0;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      padding: 8px 12px;
    }
    .mt-feedback-button-secondary {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
    }
    .mt-feedback-button-primary {
      background: #8ab4f8;
      color: #11203f;
    }
    .mt-feedback-status {
      min-height: 1.2em;
      color: #9ae6b4;
      font-size: 12px;
      font-weight: 600;
    }
    .mt-feedback-status.error {
      color: #ffb4ab;
    }

    /* ---- Scroll mode ---- */
    .mt-entry {
      position: absolute;
      right: -100%;
      display: inline-flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      max-width: min(calc(var(--mt-cw) - 32px), 72vw);
      animation: mt-scroll linear forwards;
    }
    @keyframes mt-scroll {
      from { transform: translateX(0); }
      to   { transform: translateX(calc(-1 * var(--mt-cw) - 100%)); }
    }

    /* ---- Subtitle (fixed) mode ---- */
    #mt-subtitle-panel {
      position: absolute;
      bottom: 8%;
      left: 50%;
      transform: translateX(-50%);
      max-width: min(calc(var(--mt-cw) - 32px), 80%);
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      padding: 8px 16px;
      background: rgba(0, 0, 0, 0.55);
      border-radius: 6px;
      transition: opacity 0.4s ease;
    }
    #mt-subtitle-panel.mt-hidden {
      opacity: 0;
    }

    /* ---- Shared text styles ---- */
    .mt-speaker {
      display: block;
      max-width: 100%;
      font-size: 13px;
      font-weight: 700;
      color: #b9d6ff;
      text-shadow:
        1px  1px 3px rgba(0,0,0,0.9),
        -1px -1px 3px rgba(0,0,0,0.9);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      line-height: 1.2;
    }
    .mt-original {
      display: block;
      max-width: 100%;
      font-size: 18px;
      font-weight: 600;
      color: #e8e8e8;
      text-shadow:
        1px  1px 3px rgba(0,0,0,0.9),
        -1px -1px 3px rgba(0,0,0,0.9);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      line-height: 1.3;
    }
    .mt-translation {
      display: block;
      max-width: 100%;
      font-size: 22px;
      font-weight: 700;
      color: #ffe066;
      text-shadow:
        1px  1px 3px rgba(0,0,0,0.9),
        -1px -1px 3px rgba(0,0,0,0.9);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      line-height: 1.3;
    }
    #mt-subtitle-panel .mt-speaker,
    #mt-subtitle-panel .mt-original,
    #mt-subtitle-panel .mt-translation {
      text-align: center;
    }
    .mt-entry .mt-speaker,
    .mt-entry .mt-original,
    .mt-entry .mt-translation {
      text-align: left;
    }
  `;
  document.head.appendChild(style);
}

/** Get or create the overlay container div, anchored to the Meet video area. */
function getOverlayContainer() {
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = OVERLAY_ID;

    // <main> is already position:absolute (CSS class axUSnc), so it
    // establishes a containing block.  No need to set position:relative.
    const videoArea = document.querySelector(VIDEO_AREA_SEL);
    if (videoArea) {
      // Initialise the CSS variable and keep it in sync with container resizes.
      const updateCw = (width) => el.style.setProperty('--mt-cw', `${width}px`);
      updateCw(videoArea.getBoundingClientRect().width);
      containerResizeObserver = new ResizeObserver(entries => {
        updateCw(entries[0].contentRect.width);
      });
      containerResizeObserver.observe(videoArea);

      videoArea.appendChild(el);
    } else {
      // Fallback: anchor to body (--mt-cw defaults to 100vw via CSS).
      document.body.appendChild(el);
    }
  }
  return el;
}

function feedbackPreview(text) {
  if (!text) return '\u2014';
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '\u2014';
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function getFeedbackAnchor() {
  return document.querySelector(VIDEO_AREA_SEL) || document.body;
}

function getFeedbackRoot() {
  ensureOverlayStyles();

  let root = document.getElementById(FEEDBACK_ROOT_ID);
  const anchor = getFeedbackAnchor();

  if (!root) {
    root = document.createElement('div');
    root.id = FEEDBACK_ROOT_ID;
    root.innerHTML = `
      <div id="mt-feedback-widget">
        <button type="button" id="mt-feedback-toggle">辞書修正</button>
        <div id="mt-feedback-panel">
          <div class="mt-feedback-title">誤認識 / 誤訳を登録</div>
          <div id="mt-feedback-meta" class="mt-feedback-meta"></div>
          <div class="mt-feedback-context">
            <div class="mt-feedback-row">
              <div class="mt-feedback-label">直近の文字起こし</div>
              <div id="mt-feedback-original" class="mt-feedback-value"></div>
            </div>
            <div class="mt-feedback-row">
              <div class="mt-feedback-label">直近の翻訳</div>
              <div id="mt-feedback-translation" class="mt-feedback-value"></div>
            </div>
          </div>
          <form id="${FEEDBACK_FORM_ID}" class="mt-feedback-form">
            <label class="mt-feedback-field">
              <span>登録先</span>
              <select id="mt-feedback-kind" class="mt-feedback-select">
                <option value="correction">文字起こし補正</option>
                <option value="term">翻訳用語</option>
              </select>
            </label>
            <label class="mt-feedback-field">
              <span id="mt-feedback-source-label">誤っていた語句</span>
              <input id="mt-feedback-source" class="mt-feedback-input" type="text" autocomplete="off">
            </label>
            <label class="mt-feedback-field">
              <span id="mt-feedback-target-label">正しい語句</span>
              <input id="mt-feedback-target" class="mt-feedback-input" type="text" autocomplete="off">
            </label>
            <div id="mt-feedback-status" class="mt-feedback-status"></div>
            <div class="mt-feedback-actions">
              <button type="button" id="mt-feedback-close" class="mt-feedback-button mt-feedback-button-secondary">閉じる</button>
              <button type="submit" id="mt-feedback-submit" class="mt-feedback-button mt-feedback-button-primary">辞書に追加</button>
            </div>
          </form>
        </div>
      </div>
    `;
    anchor.appendChild(root);

    root.querySelector('#mt-feedback-toggle')?.addEventListener('click', () => {
      if (!(feedbackState.original || feedbackState.translation)) return;
      feedbackState.isOpen = !feedbackState.isOpen;
      syncFeedbackUi();
    });
    root.querySelector('#mt-feedback-close')?.addEventListener('click', () => {
      feedbackState.isOpen = false;
      syncFeedbackUi();
    });
    root.querySelector('#mt-feedback-kind')?.addEventListener('change', syncFeedbackFormCopy);
    root.querySelector(`#${FEEDBACK_FORM_ID}`)?.addEventListener('submit', submitGlossaryFeedback);
  } else if (root.parentElement !== anchor) {
    anchor.appendChild(root);
  }

  root.classList.toggle('mt-body-anchor', anchor === document.body);
  syncFeedbackFormCopy();
  syncFeedbackUi();
  return root;
}

function syncFeedbackFormCopy() {
  const root = document.getElementById(FEEDBACK_ROOT_ID);
  if (!root) return;
  const kind = root.querySelector('#mt-feedback-kind')?.value || 'correction';
  const sourceLabel = root.querySelector('#mt-feedback-source-label');
  const targetLabel = root.querySelector('#mt-feedback-target-label');
  const sourceInput = root.querySelector('#mt-feedback-source');
  const targetInput = root.querySelector('#mt-feedback-target');
  if (kind === 'term') {
    sourceLabel.textContent = '誤っていた翻訳語句';
    targetLabel.textContent = '正しい翻訳語句';
    sourceInput.placeholder = '例: プールリクエスト';
    targetInput.placeholder = '例: プルリクエスト';
  } else {
    sourceLabel.textContent = '誤っていた聞き取り語句';
    targetLabel.textContent = '正しい語句';
    sourceInput.placeholder = '例: get hub';
    targetInput.placeholder = '例: GitHub';
  }
}

function syncFeedbackUi() {
  const root = document.getElementById(FEEDBACK_ROOT_ID);
  if (!root) return;

  const widget = root.querySelector('#mt-feedback-widget');
  const toggle = root.querySelector('#mt-feedback-toggle');
  const meta = root.querySelector('#mt-feedback-meta');
  const original = root.querySelector('#mt-feedback-original');
  const translation = root.querySelector('#mt-feedback-translation');
  const status = root.querySelector('#mt-feedback-status');
  const hasContext = Boolean(feedbackState.original || feedbackState.translation);

  toggle.disabled = !hasContext;
  widget.classList.toggle('mt-open', feedbackState.isOpen && hasContext);
  meta.textContent = feedbackState.speakerName
    ? `話者: ${feedbackState.speakerName}`
    : '直近の発話から辞書へ反映します';
  original.textContent = feedbackPreview(feedbackState.original);
  translation.textContent = feedbackPreview(feedbackState.translation);
  status.textContent = feedbackState.statusText || '';
  status.classList.toggle('error', feedbackState.statusError);
}

function updateFeedbackContext(message) {
  if (!message.original && !message.translation) return;
  feedbackState.speakerName = normalizeSpeakerName(message.speakerName);
  feedbackState.original = message.original || feedbackState.original || '';
  feedbackState.translation = message.translation || '';
  feedbackState.statusText = '';
  feedbackState.statusError = false;
  getFeedbackRoot();
}

function resetFeedbackState() {
  feedbackState.isOpen = false;
  feedbackState.statusText = '';
  feedbackState.statusError = false;
  feedbackState.speakerName = '';
  feedbackState.original = '';
  feedbackState.translation = '';
}

function destroyFeedbackUi() {
  const root = document.getElementById(FEEDBACK_ROOT_ID);
  if (root) root.remove();
  resetFeedbackState();
}

async function submitGlossaryFeedback(event) {
  event.preventDefault();

  const root = getFeedbackRoot();
  const kind = root.querySelector('#mt-feedback-kind')?.value || 'correction';
  const sourceInput = root.querySelector('#mt-feedback-source');
  const targetInput = root.querySelector('#mt-feedback-target');
  const submitButton = root.querySelector('#mt-feedback-submit');
  const source = sourceInput.value.trim();
  const target = targetInput.value.trim();

  if (!source || !target) {
    feedbackState.statusText = '誤りと正しい語句の両方を入力してください。';
    feedbackState.statusError = true;
    syncFeedbackUi();
    return;
  }

  submitButton.disabled = true;
  feedbackState.statusText = '辞書を更新しています...';
  feedbackState.statusError = false;
  syncFeedbackUi();

  try {
    const response = await sendRuntimeMessage({
      type: 'SUBMIT_GLOSSARY_FEEDBACK',
      feedback: {
        kind,
        source,
        target,
        speakerName: feedbackState.speakerName || null,
        original: feedbackState.original || null,
        translation: feedbackState.translation || null,
      },
    });
    if (!response?.success) {
      throw new Error(response?.error || '辞書更新に失敗しました。');
    }

    feedbackState.statusText = kind === 'term'
      ? '翻訳辞書を更新しました。'
      : '文字起こし補正を更新しました。';
    feedbackState.statusError = false;
    sourceInput.value = '';
    targetInput.value = '';
    feedbackState.isOpen = true;
    syncFeedbackUi();
  } catch (err) {
    feedbackState.statusText = err?.message || '辞書更新に失敗しました。';
    feedbackState.statusError = true;
    syncFeedbackUi();
  } finally {
    submitButton.disabled = false;
  }
}

/** Destroy the overlay and clean up all state. */
function destroyOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
  if (containerResizeObserver) {
    containerResizeObserver.disconnect();
    containerResizeObserver = null;
  }
  laneOccupied.fill(false);
  lanePointer = 0;
  if (subtitleHideTimer) { clearTimeout(subtitleHideTimer); subtitleHideTimer = null; }
}

/** Pick the next available scroll lane (round-robin, skip occupied). */
function pickLane() {
  for (let i = 0; i < LANE_COUNT; i++) {
    const idx = (lanePointer + i) % LANE_COUNT;
    if (!laneOccupied[idx]) {
      lanePointer = (idx + 1) % LANE_COUNT;
      return idx;
    }
  }
  // All lanes occupied – use round-robin anyway to avoid stalling
  const idx = lanePointer;
  lanePointer = (lanePointer + 1) % LANE_COUNT;
  return idx;
}

/** Build a text span for either .mt-original or .mt-translation. */
function makeTextSpan(text, cssClass) {
  const span = document.createElement('span');
  span.className = cssClass;
  span.textContent = text;
  return span;
}

function makeSpeakerSpan(speakerName) {
  if (!speakerName) return null;
  return makeTextSpan(speakerName, 'mt-speaker');
}

/**
 * Show overlay in fixed subtitle mode (default).
 * Content is replaced with each new utterance and auto-hides after SUBTITLE_HIDE_MS.
 */
function showSubtitle(original, translation, speakerName) {
  const container = getOverlayContainer();

  let panel = document.getElementById('mt-subtitle-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'mt-subtitle-panel';
    container.appendChild(panel);
  }

  // Replace content
  panel.innerHTML = '';
  const speaker = makeSpeakerSpan(speakerName);
  if (speaker) panel.appendChild(speaker);
  if (original)    panel.appendChild(makeTextSpan(original,    'mt-original'));
  if (translation) panel.appendChild(makeTextSpan(translation, 'mt-translation'));

  // Show
  panel.classList.remove('mt-hidden');

  // Reset auto-hide timer
  if (subtitleHideTimer) clearTimeout(subtitleHideTimer);
  subtitleHideTimer = setTimeout(() => {
    panel.classList.add('mt-hidden');
    subtitleHideTimer = null;
  }, SUBTITLE_HIDE_MS);
}

/**
 * Show overlay in Niconico scroll mode.
 * Each utterance spawns a new entry that scrolls right→left.
 */
function showScrolling(original, translation, speakerName) {
  const container = getOverlayContainer();

  const lane     = pickLane();
  const laneStep = (1 - LANE_MARGIN * 2) / (LANE_COUNT - 1);
  const topPct   = (LANE_MARGIN + laneStep * lane) * 100;

  const maxLen   = Math.max(original?.length ?? 0, translation?.length ?? 0, speakerName?.length ?? 0);
  const duration = BASE_SCROLL_MS + maxLen * MS_PER_CHAR;

  const entry = document.createElement('div');
  entry.className = 'mt-entry';
  entry.style.top               = `${topPct}%`;
  entry.style.animationDuration = `${duration}ms`;

  const speaker = makeSpeakerSpan(speakerName);
  if (speaker) entry.appendChild(speaker);
  if (original)    entry.appendChild(makeTextSpan(original,    'mt-original'));
  if (translation) entry.appendChild(makeTextSpan(translation, 'mt-translation'));

  laneOccupied[lane] = true;
  container.appendChild(entry);

  entry.addEventListener('animationend', () => {
    setTimeout(() => {
      entry.remove();
      laneOccupied[lane] = false;
    }, FADE_DELAY_MS);
  });
}

/**
 * Dispatch to subtitle or scroll mode based on the scroll flag.
 * @param {string|null} original
 * @param {string|null} translation
 * @param {boolean} scroll
 * @param {string|null} speakerName
 */
function showOverlay(original, translation, scroll, speakerName) {
  if (!original && !translation) return;
  ensureOverlayStyles();
  if (scroll) {
    showScrolling(original, translation, speakerName);
  } else {
    showSubtitle(original, translation, speakerName);
  }
}
