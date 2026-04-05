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
  // aria-label contains 「チャット」 (ja) or "Chat with everyone" (en).
  chatPanelButton: [
    'button[aria-label*="Chat with everyone"]',
    'button[aria-label*="チャット"]',
    '[data-panel-id="2"]',
  ].join(', '),

  // The contenteditable div used for message composition.
  // jsname="r4nke" is stable across many Meet versions.
  messageInput: [
    '[jsname="r4nke"]',
    'div[contenteditable="true"][aria-label*="message"]',
    'div[contenteditable="true"][aria-label*="メッセージ"]',
    'textarea[aria-label*="message"]',
    'textarea[aria-label*="メッセージ"]',
  ].join(', '),

  // Send button adjacent to the message input.
  sendButton: [
    'button[jsname="c6xSqd"]',
    'button[aria-label*="Send message"]',
    'button[aria-label*="メッセージを送信"]',
  ].join(', '),
};

// ---------------------------------------------------------------------------
// Helper: ensure the chat panel is visible
// ---------------------------------------------------------------------------
async function ensureChatPanelOpen() {
  // If the message input is already visible, no need to open the panel
  if (document.querySelector(SEL.messageInput)) return;

  const chatBtn = document.querySelector(SEL.chatPanelButton);
  if (chatBtn) {
    chatBtn.click();
    // Wait for the panel to render
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

  // 2. Locate the message input
  const input = document.querySelector(SEL.messageInput);
  if (!input) {
    console.warn('[Meet Translator] チャット入力欄が見つかりませんでした。チャットパネルを開いてください。');
    return;
  }

  // 3. Focus and fill the input
  input.focus();

  if (input.contentEditable === 'true') {
    // contenteditable div (Google Meet / React)
    // execCommand('insertText') は \n を <br> として扱い、
    // React のイベントデリゲーションも正しく発火する。
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
