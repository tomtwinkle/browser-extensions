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

  // Message composition input – covers both UI modes.
  // NOTE: In embedded Google Chat, contenteditable may be "" (empty string),
  //       not "true", so we use [contenteditable] (attribute presence) here.
  messageInput: [
    // Mode A – Classic Meet (stable internal attribute)
    '[jsname="r4nke"]',
    // Mode A – Classic Meet with aria-label (en / ja)
    'div[contenteditable="true"][aria-label*="message"]',
    'div[contenteditable="true"][aria-label*="メッセージ"]',
    // Mode B – Embedded Google Chat, send-message aria-label (ja)
    'div[contenteditable][aria-label*="メッセージを送信"]',
    'div[contenteditable][aria-label*="全員にメッセージ"]',
    // Mode B – Embedded Google Chat, send-message aria-label (en)
    'div[contenteditable][aria-label*="Send a message"]',
    'div[contenteditable][aria-label*="Message everyone"]',
    // Mode A – Plain textarea fallback
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
// Helper: find the message input element
//
// Strategy:
//   1. Try CSS selectors (fast path).  Filter out hidden results.
//   2. Fallback: walk d-view subtrees and pick the first visible
//      div[contenteditable] that is NOT a search/history-header element.
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
// Helper: wait for a DOM element to appear (used for generic selectors)
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
      resolve(null);
    }, timeoutMs);
  });
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
    console.warn('[Meet Translator] チャット入力欄が見つかりませんでした。チャットパネルを開いてください。');
    return;
  }

  // 3. Focus and fill the input
  input.focus();

  // isContentEditable is true for both contenteditable="true" and contenteditable=""
  if (input.isContentEditable) {
    // contenteditable div (Google Meet classic / embedded Google Chat)
    // execCommand('insertText') triggers React synthetic events correctly.
    input.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  } else {
    // Plain <textarea>
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
    // Fallback: simulate Enter key (also works in embedded Google Chat)
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
      postToChat(message.text)
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          console.error('[Meet Translator] チャット投稿エラー:', err);
          sendResponse({ success: false, error: err.message });
        });
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
