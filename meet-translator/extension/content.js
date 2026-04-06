/**
 * content.js  –  Content Script (injected into https://meet.google.com/*)
 *
 * Responsibilities:
 *  1. Listen for POST_TRANSLATION messages from the background worker.
 *  2. Locate the Google Meet chat textarea and send button in the DOM.
 *  3. Programmatically fill the input and submit the message.
 *
 * DOM selector notes
 * ------------------
 * Google Meet's internal DOM can change without notice. The selectors below
 * are based on the current (2024-2025) Meet UI. If posting stops working,
 * open Meet DevTools and update the constants at the top of this file.
 *
 * The chat panel must be open before a message can be posted. This script
 * will attempt to open it automatically if it is closed.
 */

'use strict';

// ---------------------------------------------------------------------------
// DOM selectors  (update these if Meet changes its markup)
// ---------------------------------------------------------------------------
const SEL = {
  // Toolbar button that opens the in-call chat panel.
  chatPanelButton: [
    'button[aria-label*="Chat with everyone"]',
    'button[aria-label*="チャット"]',
    'button[aria-label*="In-call messages"]',
    'button[aria-label*="通話内のメッセージ"]',
    'button[aria-label*="通話内メッセージ"]',
    'button[aria-label*="messages" i]',
    // NOTE: '[data-panel-id="2"]' removed – matched wrong element in current Meet UI
  ].join(', '),

  // Chat panel container – used to scope the input search as a fallback.
  chatPanelContainer: [
    '[data-panel-id="chat"]',
    '[jsname="xct4fd"]',
    'section[aria-label*="chat" i]',
    'section[aria-label*="チャット"]',
    'aside[aria-label*="chat" i]',
    'aside[aria-label*="チャット"]',
  ].join(', '),

  // The contenteditable div / textarea used for message composition.
  // Google Meet 2025+ may use contenteditable="plaintext-only" instead of "true".
  messageInput: [
    '[role="textbox"][contenteditable="true"]',
    '[role="textbox"][contenteditable="plaintext-only"]',
    '[jsname="r4nke"]',                          // older Meet UI
    'div[contenteditable="true"][aria-label*="message" i]',
    'div[contenteditable="plaintext-only"][aria-label*="message" i]',
    'div[contenteditable="true"][aria-label*="メッセージ" i]',
    'div[contenteditable="plaintext-only"][aria-label*="メッセージ" i]',
    'div[contenteditable="true"][aria-label*="chat" i]',
    'div[contenteditable="true"][aria-label*="チャット" i]',
    'textarea[aria-label*="message" i]',
    'textarea[aria-label*="メッセージ" i]',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="メッセージ" i]',
  ].join(', '),

  // Send button adjacent to the message input.
  sendButton: [
    'button[jsname="c6xSqd"]',
    'button[aria-label*="Send message"]',
    'button[aria-label*="メッセージを送信"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="送信" i]',
  ].join(', '),
};

// ---------------------------------------------------------------------------
// Helper: deep querySelectorAll that pierces shadow DOMs and same-origin iframes
// Supports both open shadow roots (el.shadowRoot) and closed shadow roots
// via chrome.dom.openOrClosedShadowRoot (available in MV3 content scripts).
// ---------------------------------------------------------------------------
function getShadowRoot(el) {
  if (el.shadowRoot) return el.shadowRoot;
  try {
    // chrome.dom.openOrClosedShadowRoot pierces closed shadow roots
    if (typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
      return chrome.dom.openOrClosedShadowRoot(el);
    }
  } catch (_) { /* not available */ }
  return null;
}

function deepQueryAll(selector, root = document) {
  const results = [];
  const seen = new WeakSet();
  const search = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    try {
      results.push(...node.querySelectorAll(selector));
      node.querySelectorAll('*').forEach(el => {
        const shadow = getShadowRoot(el);
        if (shadow) search(shadow);
      });
      node.querySelectorAll('iframe').forEach(frame => {
        try { if (frame.contentDocument) search(frame.contentDocument); }
        catch (_) { /* cross-origin */ }
      });
    } catch (_) { /* ignore */ }
  };
  search(root);
  return results;
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// ---------------------------------------------------------------------------
// Serialization queue – prevent concurrent postToChat calls from racing
// ---------------------------------------------------------------------------
let _chatQueue = Promise.resolve();
function enqueueChat(fn) {
  _chatQueue = _chatQueue.then(fn).catch(() => {});
  return _chatQueue;
}

// ---------------------------------------------------------------------------
// Helper: report error back to background service worker
// ---------------------------------------------------------------------------
function reportChatError(msg) {
  chrome.runtime.sendMessage({ type: 'CHAT_ERROR', error: msg }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Helper: ensure the chat panel is visible
// ---------------------------------------------------------------------------
async function ensureChatPanelOpen() {
  // If the message input is already visible, no need to open the panel
  if (document.querySelector(SEL.messageInput)) return;

  const chatBtn = document.querySelector(SEL.chatPanelButton);
  const allBtnLabels = () =>
    [...document.querySelectorAll('button[aria-label]')]
      .map(b => `"${b.getAttribute('aria-label')}"`)
      .slice(0, 20).join(', ');

  if (!chatBtn) {
    reportChatError('チャットパネルボタンが見つかりません。ツールバーボタン: [' + allBtnLabels() + ']');
    return;
  }

  const btnLabel = chatBtn.getAttribute('aria-label') || '';
  const btnExpanded = chatBtn.getAttribute('aria-expanded');
  const btnPressed = chatBtn.getAttribute('aria-pressed');

  if (!btnLabel) {
    reportChatError('チャットパネルボタンのaria-labelが空（誤マッチの可能性）。ツールバーボタン: [' + allBtnLabels() + ']');
    return;
  }

  const isExpanded = btnExpanded === 'true';
  reportChatError(`DEBUG ensureChatPanelOpen: btn="${btnLabel}" aria-expanded="${btnExpanded}" aria-pressed="${btnPressed}" isExpanded=${isExpanded}`);

  if (!isExpanded) {
    chatBtn.click();
    await waitForElement(SEL.messageInput, 2000);
  }

  // In the new Meet UI, clicking the chat panel button opens a chat LIST view
  // (with a "Chat を検索…" search box) rather than directly opening the message input.
  // We need to find and click the "group chat with everyone in this call" item.
  if (!document.querySelector(SEL.messageInput) && !deepQueryAll(SEL.messageInput)[0]) {
    await openGroupChatConversation();
  }
}

// Find and click the "everyone in this call" conversation item in the chat list.
async function openGroupChatConversation() {
  // Keywords that identify the group/meeting chat entry
  const groupKeywords = ['全員', 'everyone', 'group', 'meeting', 'call', '通話'];

  // Candidate selectors for conversation list items / buttons
  const CONV_SEL = [
    '[role="listitem"]',
    '[role="option"]',
    '[role="row"]',
    'li',
    'button',
    '[data-room-type]',
    '[data-conversation-id]',
    '[data-group-id]',
  ].join(', ');

  const allItems = deepQueryAll(CONV_SEL).filter(isVisible);
  const groupItem = allItems.find(el => {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    const text = (el.textContent || '').trim().toLowerCase().slice(0, 80);
    // Exclude the search input itself
    if (el.tagName === 'INPUT') return false;
    // Exclude the toolbar buttons we already know about
    if (el === document.querySelector(SEL.chatPanelButton)) return false;
    return groupKeywords.some(kw => label.includes(kw) || text.includes(kw));
  });

  if (groupItem) {
    reportChatError(`DEBUG openGroupChatConversation: clicking "${groupItem.getAttribute('aria-label') || groupItem.textContent.trim().slice(0, 40)}"`);
    groupItem.click();
    await waitForElement(SEL.messageInput, 3000);
  } else {
    // Diagnostic: list visible items in the chat panel to find the right selector
    const panelItems = allItems.slice(0, 15).map(el =>
      `<${el.tagName.toLowerCase()} role="${el.getAttribute('role')||''}" aria-label="${el.getAttribute('aria-label')||''}" text="${(el.textContent||'').trim().slice(0,30)}">`
    );
    reportChatError('DEBUG openGroupChatConversation: no group item found. panel items: ' + panelItems.join(' | '));
  }
}

// ---------------------------------------------------------------------------
// Helper: wait for a DOM element to appear
// ---------------------------------------------------------------------------
function waitForElement(selector, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) { resolve(existing); return; }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null); // timed out
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Core: post translated text to the Meet chat
// ---------------------------------------------------------------------------
async function postToChat(text) {
  // 1. Make sure the chat panel is open
  await ensureChatPanelOpen();

  const INPUT_SEL = [
    SEL.messageInput,
    // Also catch contenteditable="plaintext-only" without role or aria-label
    '[contenteditable="plaintext-only"]',
    // Broad contenteditable (exclude explicitly non-editable)
    '[contenteditable]:not([contenteditable="false"])',
    'input[type="text"]',
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])',
  ].join(', ');

  // Selector for broad diagnostics (all input-like elements including hidden)
  const DIAG_SEL = [
    '[role="textbox"]',
    '[contenteditable]:not([contenteditable="false"])',
    'textarea',
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])',
  ].join(', ');

  // 2. Regular querySelector (fast path)
  let input = document.querySelector(SEL.messageInput);

  // 3. Fallback: scan inside the chat panel container
  if (!input) {
    const panel = document.querySelector(SEL.chatPanelContainer);
    if (panel) {
      input = panel.querySelector(INPUT_SEL) || null;
    }
  }

  // 4. Deep fallback: pierce shadow DOM and same-origin iframes
  if (!input) {
    const chatSearchPlaceholders = ['chat を検索', 'search chat', 'search people'];
    const found = deepQueryAll(INPUT_SEL).filter(el => {
      // Exclude the chat search box
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const lb = (el.getAttribute('aria-label') || '').toLowerCase();
      return !chatSearchPlaceholders.some(s => ph.includes(s) || lb.includes(s));
    });
    // Prefer visible, fall back to any
    const visible = found.filter(isVisible);
    const candidate = visible[0] || found[0];
    if (candidate) {
      input = candidate;
      console.info('[Meet Translator] Found input via deep search:', input.tagName,
        input.getAttribute('aria-label'), input.getAttribute('role'),
        'contenteditable=' + input.getAttribute('contenteditable'));
    }
  }

  if (!input) {
    // Diagnostic: check ALL input-like elements (visible and hidden) via deep search
    // Exclude the chat search box (placeholder "Chat を検索") from count
    const allFound = deepQueryAll(DIAG_SEL).map(el => {
      const vis = isVisible(el) ? 'VISIBLE' : 'hidden';
      const ce = el.getAttribute('contenteditable') || '';
      return `[${vis}] <${el.tagName.toLowerCase()} role="${el.getAttribute('role')||''}" ` +
        `contenteditable="${ce}" aria-label="${el.getAttribute('aria-label')||''}" ` +
        `type="${el.getAttribute('type')||''}" placeholder="${el.getAttribute('placeholder')||''}" ` +
        `jsname="${el.getAttribute('jsname')||''}">`;
    });
    const msg = 'チャット入力欄が見つかりません。all candidates: ' +
      (allFound.length ? allFound.slice(0, 10).join(' | ') : 'none');
    console.warn('[Meet Translator]', msg);
    reportChatError(msg);
    return;
  }

  // 5. Focus and fill the input
  input.focus();

  const ce = input.getAttribute('contenteditable');
  if (ce === 'true' || ce === 'plaintext-only') {
    // contenteditable div / React rich text editor
    input.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  } else if (input.tagName === 'TEXTAREA') {
    // Plain <textarea> – use native value setter to bypass React batching
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // <input type="text"> or similar
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 6. Small delay so the UI can process the input event
  await new Promise((r) => setTimeout(r, 150));

  // 7. Click the send button (preferred) or press Enter
  const sendBtn = document.querySelector(SEL.sendButton) || deepQueryAll(SEL.sendButton).find(isVisible);
  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
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
    case 'POST_TRANSLATION':
      // Serialize via queue to prevent concurrent DOM manipulation
      enqueueChat(() =>
        postToChat(message.text)
          .then(() => sendResponse({ success: true }))
          .catch((err) => {
            reportChatError(err.message);
            sendResponse({ success: false, error: err.message });
          })
      );
      return true; // keep channel open for async response

    case 'TRANSLATION_STOPPED':
      console.log('[Meet Translator] 自動翻訳チャットを停止しました。');
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

console.log('[Meet Translator] content script loaded on', location.href);
