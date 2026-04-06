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
    '[data-panel-id="2"]',
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
  // In the current Meet UI (2025+), the input is role="textbox" contenteditable.
  messageInput: [
    '[role="textbox"][contenteditable="true"]',  // new Meet UI (primary)
    '[jsname="r4nke"]',                          // older Meet UI
    'div[contenteditable="true"][aria-label*="message" i]',
    'div[contenteditable="true"][aria-label*="メッセージ" i]',
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
  if (!chatBtn) {
    // Diagnostic: list all toolbar buttons with aria-label so we can find the right one
    const allBtns = [...document.querySelectorAll('button[aria-label]')]
      .map(b => `"${b.getAttribute('aria-label')}"`)
      .slice(0, 20);
    reportChatError('チャットパネルボタンが見つかりません。ツールバーボタン: [' + allBtns.join(', ') + ']');
    return;
  }

  const btnLabel = chatBtn.getAttribute('aria-label') || '';
  const btnExpanded = chatBtn.getAttribute('aria-expanded');
  const btnPressed = chatBtn.getAttribute('aria-pressed');

  // Only check aria-expanded (not aria-pressed) to detect panel state.
  // aria-pressed can be true for keyboard navigation focus, not panel open state.
  const isExpanded = btnExpanded === 'true';
  reportChatError(`DEBUG ensureChatPanelOpen: btn="${btnLabel}" aria-expanded="${btnExpanded}" aria-pressed="${btnPressed}" isExpanded=${isExpanded}`);

  if (!isExpanded) {
    chatBtn.click();
    await waitForElement(SEL.messageInput, 3000);
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

  // 2. Locate the message input (specific selectors first)
  let input = document.querySelector(SEL.messageInput);

  // 3. Fallback: scan inside the chat panel container
  if (!input) {
    const panel = document.querySelector(SEL.chatPanelContainer);
    if (panel) {
      input = panel.querySelector(
        '[role="textbox"], [contenteditable="true"], textarea'
      );
    }
  }

  if (!input) {
    // Diagnostic: report ALL visible contenteditable / textbox elements
    const candidates = [
      ...document.querySelectorAll('[role="textbox"], [contenteditable="true"], textarea'),
    ].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0; // visible elements only
    }).map((el) =>
      `<${el.tagName.toLowerCase()} role="${el.getAttribute('role') || ''}" ` +
      `contenteditable="${el.contentEditable}" ` +
      `aria-label="${el.getAttribute('aria-label') || ''}" ` +
      `placeholder="${el.getAttribute('placeholder') || ''}" ` +
      `jsname="${el.getAttribute('jsname') || ''}"/>`
    );
    const msg = 'チャット入力欄が見つかりません。visible candidates: ' +
      (candidates.length ? candidates.join(' | ') : 'none');
    console.warn('[Meet Translator]', msg);
    reportChatError(msg);
    return;
  }

  // 3. Focus and fill the input
  input.focus();

  if (input.contentEditable === 'true') {
    // contenteditable div (Google Meet / React)
    // execCommand('insertText') fires React's synthetic input event.
    input.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  } else {
    // Plain <textarea> – use native value setter to bypass React batching
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    ).set;
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 4. Small delay so the UI can process the input event
  await new Promise((r) => setTimeout(r, 150));

  // 5. Click the send button (preferred) or press Enter
  const sendBtn = document.querySelector(SEL.sendButton);
  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    // Fallback: simulate Enter key
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
