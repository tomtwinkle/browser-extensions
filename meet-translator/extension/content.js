/**
 * content.js  –  Content Script (injected into https://meet.google.com/*)
 *
 * Responsibilities:
 *  1. Listen for POST_TRANSLATION messages from the background worker.
 *  2. Locate the Google Meet chat textarea and send button in the DOM.
 *  3. Detect the currently highlighted speaker in the Meet DOM.
 *  4. Programmatically fill the input and submit the message.
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

// ---------------------------------------------------------------------------
// Helper: detect the active speaker tile in the Meet main frame
// ---------------------------------------------------------------------------
function normalizeSpeakerName(name) {
  return name ? name.replace(/\s+/g, ' ').trim() : '';
}

function parseSpeakerNameFromAriaLabel(label) {
  const normalized = normalizeSpeakerName(label);
  if (!normalized) return null;

  const patterns = [
    /^メイン画面の (.+?) さんの共有画面の固定を解除します$/,
    /^(.+?) さんをメイン画面に固定します$/,
    /^(.+?) さんの共有画面をミュート$/,
    /^(.+?) さんのマイクをミュート$/,
    /^Pin (.+?) to the main screen$/i,
    /^Unpin (.+?) from the main screen$/i,
    /^Mute (.+?)(?:['’]s)? microphone$/i,
    /^Mute (.+?)(?:['’]s)? screen share$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return normalizeSpeakerName(match[1]);
  }
  return null;
}

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

    /* ---- Scroll mode ---- */
    .mt-entry {
      position: absolute;
      right: -100%;
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
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
      max-width: 80%;
      display: flex;
      flex-direction: column;
      align-items: center;
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
      font-size: 13px;
      font-weight: 700;
      color: #b9d6ff;
      text-shadow:
        1px  1px 3px rgba(0,0,0,0.9),
       -1px -1px 3px rgba(0,0,0,0.9);
      white-space: nowrap;
      line-height: 1.2;
    }
    .mt-original {
      font-size: 18px;
      font-weight: 600;
      color: #e8e8e8;
      text-shadow:
        1px  1px 3px rgba(0,0,0,0.9),
       -1px -1px 3px rgba(0,0,0,0.9);
      white-space: nowrap;
      line-height: 1.3;
    }
    .mt-translation {
      font-size: 22px;
      font-weight: 700;
      color: #ffe066;
      text-shadow:
        1px  1px 3px rgba(0,0,0,0.9),
       -1px -1px 3px rgba(0,0,0,0.9);
      white-space: nowrap;
      line-height: 1.3;
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
