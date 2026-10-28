/**
 * content.js – In-Meet overlay and feedback UI.
 *
 * Responsibilities:
 * Detect the active speaker, display the current legacy in-Meet overlay,
 * and provide a glossary feedback widget. This script does not operate chat.
 */

'use strict';

const {
  cloneFeedbackContext,
  hasFeedbackContext,
  mergeFeedbackContext,
  normalizeSpeakerName,
  parseSpeakerNameFromAriaLabel,
} = globalThis.MeetTranslatorShared;

// ---------------------------------------------------------------------------
// DOM selectors  (update these if Meet changes its markup)
// ---------------------------------------------------------------------------
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
  latestContext: cloneFeedbackContext(null),
  lockedContext: cloneFeedbackContext(null),
  hasPendingUpdate: false,
};
const activeAudioSession = {
  sessionId: null,
  streamGenerations: { mic: null, tab: null },
};

function beginAudioSession(sessionId, streamGenerations) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const generations = { mic: null, tab: null };
  for (const streamId of ['mic', 'tab']) {
    const value = streamGenerations?.[streamId];
    if (Number.isSafeInteger(value) && value >= 0) generations[streamId] = value;
  }
  if (generations.mic === null && generations.tab === null) return false;
  activeAudioSession.sessionId = sessionId;
  activeAudioSession.streamGenerations = generations;
  return true;
}

function isCurrentAudioMessage(message) {
  return message?.sessionId === activeAudioSession.sessionId &&
    (message?.streamId === 'mic' || message?.streamId === 'tab') &&
    Number.isSafeInteger(message?.streamGeneration) &&
    message.streamGeneration === activeAudioSession.streamGenerations[message.streamId];
}

function endAudioSession(sessionId) {
  if (!sessionId || sessionId !== activeAudioSession.sessionId) return false;
  activeAudioSession.sessionId = null;
  activeAudioSession.streamGenerations = { mic: null, tab: null };
  return true;
}

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
// Message listener
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'TRANSLATION_STARTED':
      sendResponse({ success: beginAudioSession(message.sessionId, message.streamGenerations) });
      return false;

    case 'GET_ACTIVE_SPEAKER':
      if (location.hostname === 'meet.google.com' && window === window.top) {
        sendResponse({ speakerName: getActiveSpeakerName() });
      }
      return false;

    case 'UPDATE_FEEDBACK_CONTEXT':
      if (location.hostname === 'meet.google.com' && window === window.top) {
        if (!isCurrentAudioMessage(message)) {
          sendResponse({ success: false, stale: true });
          return false;
        }
        updateFeedbackContext(message);
      }
      sendResponse({ success: true });
      return false;

    case 'TRANSLATION_STOPPED':
      if (!endAudioSession(message.sessionId)) {
        sendResponse({ success: false, stale: true });
        return false;
      }
      console.log('[Meet Translator] capture stopped.');
      destroyOverlay();
      destroyFeedbackUi();
      sendResponse({ success: true });
      return false;

    case 'CLEAR_OVERLAY':
      if (location.hostname === 'meet.google.com' && window === window.top &&
          message.sessionId === activeAudioSession.sessionId) {
        destroyOverlay();
      }
      sendResponse({ success: true });
      return false;

    case 'SHOW_OVERLAY':
      // Only the meet.google.com top frame renders the overlay.
      if (location.hostname === 'meet.google.com' && window === window.top) {
        if (!isCurrentAudioMessage(message)) {
          sendResponse({ success: false, stale: true });
          return false;
        }
        showOverlay(message.original, message.translation, message.scroll, message.speakerName || null);
      }
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

console.log('[Meet Translator] content script loaded.');

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
      handleFeedbackToggleClick();
    });
    root.querySelector('#mt-feedback-close')?.addEventListener('click', () => {
      closeFeedbackEditor();
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

function getVisibleFeedbackContext() {
  if (feedbackState.isOpen && hasFeedbackContext(feedbackState.lockedContext)) {
    return feedbackState.lockedContext;
  }
  return feedbackState.latestContext;
}

function openFeedbackEditor() {
  if (!hasFeedbackContext(feedbackState.latestContext)) return false;
  feedbackState.lockedContext = cloneFeedbackContext(feedbackState.latestContext);
  feedbackState.isOpen = true;
  feedbackState.hasPendingUpdate = false;
  feedbackState.statusText = '';
  feedbackState.statusError = false;
  return true;
}

function closeFeedbackEditor() {
  feedbackState.isOpen = false;
  feedbackState.lockedContext = cloneFeedbackContext(null);
  feedbackState.hasPendingUpdate = false;
}

function handleFeedbackToggleClick() {
  if (!feedbackState.isOpen && !openFeedbackEditor()) {
    syncFeedbackUi();
    return false;
  }
  syncFeedbackUi();
  return feedbackState.isOpen;
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
  const visibleContext = getVisibleFeedbackContext();
  const hasLatestContext = hasFeedbackContext(feedbackState.latestContext);
  const hasVisibleContext = hasFeedbackContext(visibleContext);

  toggle.disabled = !hasLatestContext;
  widget.classList.toggle('mt-open', feedbackState.isOpen && hasVisibleContext);

  const metaParts = [];
  if (visibleContext.speakerName) {
    metaParts.push(`話者: ${visibleContext.speakerName}`);
  } else if (feedbackState.isOpen) {
    metaParts.push('表示中の発話を編集中です');
  } else {
    metaParts.push('直近の発話から辞書へ反映します');
  }
  if (feedbackState.isOpen) {
    metaParts.push('編集中は内容を固定します');
  }
  if (feedbackState.isOpen && feedbackState.hasPendingUpdate) {
    metaParts.push('新しい発話あり');
  }
  meta.textContent = metaParts.join(' · ');
  original.textContent = feedbackPreview(visibleContext.original);
  translation.textContent = feedbackPreview(visibleContext.translation);
  status.textContent = feedbackState.statusText || '';
  status.classList.toggle('error', feedbackState.statusError);
}

function applyFeedbackContextUpdate(message) {
  const nextLatestContext = mergeFeedbackContext(feedbackState.latestContext, message);
  if (!hasFeedbackContext(nextLatestContext)) return false;
  feedbackState.latestContext = nextLatestContext;
  if (feedbackState.isOpen) {
    if (!hasFeedbackContext(feedbackState.lockedContext)) {
      feedbackState.lockedContext = cloneFeedbackContext(nextLatestContext);
      feedbackState.hasPendingUpdate = false;
    } else {
      feedbackState.hasPendingUpdate = true;
    }
  } else {
    feedbackState.statusText = '';
    feedbackState.statusError = false;
  }
  return true;
}

function updateFeedbackContext(message) {
  if (!applyFeedbackContextUpdate(message)) return;
  getFeedbackRoot();
}

function resetFeedbackState() {
  closeFeedbackEditor();
  feedbackState.statusText = '';
  feedbackState.statusError = false;
  feedbackState.latestContext = cloneFeedbackContext(null);
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
        speakerName: getVisibleFeedbackContext().speakerName || null,
        original: getVisibleFeedbackContext().original || null,
        translation: getVisibleFeedbackContext().translation || null,
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
