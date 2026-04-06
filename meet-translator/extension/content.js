/**
 * content.js  –  Content Script (injected into https://meet.google.com/*)
 *
 * Responsibilities:
 *  1. Listen for POST_TRANSLATION messages from the background worker.
 *  2. Locate the Google Meet chat textarea in the DOM.
 *  3. Programmatically fill the input and submit the message.
 *
 * USAGE REQUIREMENT: The chat panel must already be open by the user before
 * messages can be posted. If the panel is closed, messages are silently skipped.
 *
 * DOM selector notes
 * ------------------
 * Google Meet's internal DOM can change without notice. The selectors below
 * target the message composition input. Search inputs (aria-label/placeholder
 * containing "search" / "検索") are explicitly excluded.
 */

'use strict';

// ---------------------------------------------------------------------------
// DOM selectors  (update these if Meet changes its markup)
// ---------------------------------------------------------------------------
const SEL = {
  // The contenteditable div / textarea / input used for message composition.
  messageInput: [
    '[role="textbox"][contenteditable="true"]',
    '[role="textbox"][contenteditable="plaintext-only"]',
    '[jsname="r4nke"]',
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
// Helper: deep querySelectorAll – pierces open and closed shadow DOMs
// ---------------------------------------------------------------------------
function getShadowRoot(el) {
  if (el.shadowRoot) return el.shadowRoot;
  try {
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

function isSearchInput(el) {
  const ph = (el.getAttribute('placeholder') || '').toLowerCase();
  const lb = (el.getAttribute('aria-label') || '').toLowerCase();
  const ty = (el.getAttribute('type') || '').toLowerCase();
  return ty === 'search' || ph.includes('検索') || ph.includes('search') ||
         lb.includes('検索') || lb.includes('search');
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
// Helper: find the visible message input (returns null if panel is closed)
// ---------------------------------------------------------------------------

// XPath to the Google Meet/Chat message input div (2025+ embedded UI).
// Derived from DevTools inspection; update if Meet changes its structure.
const CHAT_INPUT_XPATH = '/html/body/c-wiz[1]/div/div/div/div/div[1]/div[2]/div/div[4]/div/d-view/div/div/div[7]/div[4]/div/c-wiz/div[4]/div[2]/div[4]/div/div[2]/div/div[2]/div';

function findMessageInput() {
  // 1. XPath – most specific, targets the exact Google Chat input div
  try {
    const xpResult = document.evaluate(
      CHAT_INPUT_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    );
    const xpEl = xpResult.singleNodeValue;
    if (xpEl && !isSearchInput(xpEl)) return xpEl;
  } catch (_) { /* XPath not found */ }

  // 2. CSS fast path: specific selectors
  const quick = document.querySelector(SEL.messageInput);
  if (quick && !isSearchInput(quick)) return quick;

  // 3. Deep search: shadow DOM + iframes
  //    Prefer visible elements but fall back to any non-search input
  //    (empty contenteditable divs may have 0 height → isVisible returns false)
  const BROAD = [
    SEL.messageInput,
    '[contenteditable="plaintext-only"]',
    '[contenteditable]:not([contenteditable="false"])',
    'input[type="text"]',
  ].join(', ');

  const all = deepQueryAll(BROAD).filter(el => !isSearchInput(el));
  const visible = all.filter(isVisible);
  return visible[0] || all[0] || null;
}

// ---------------------------------------------------------------------------
// Core: post translated text to the Meet chat
// ---------------------------------------------------------------------------
async function postToChat(text) {
  const input = findMessageInput();

  if (!input) {
    // Chat panel is not open – skip silently (user must open it manually)
    console.info('[Meet Translator] チャットパネルが閉じているためスキップ');
    return;
  }

  // Fill the input
  input.focus();
  const ce = input.getAttribute('contenteditable');
  if (ce === 'true' || ce === 'plaintext-only') {
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  } else if (input.tagName === 'TEXTAREA') {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Wait for the UI to process the input event
  await new Promise((r) => setTimeout(r, 150));

  // Send: click the send button or press Enter
  const sendBtn = document.querySelector(SEL.sendButton) ||
    deepQueryAll(SEL.sendButton).find(isVisible);
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
      enqueueChat(() =>
        postToChat(message.text)
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err.message }))
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
