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
// Selector cache – LLM-discovered selector is stored here to avoid repeated calls
// ---------------------------------------------------------------------------
let _cachedSelector = null; // CSS selector returned by /find-chat-input

// ---------------------------------------------------------------------------
// Helper: find the visible message input (returns null if panel is closed)
// ---------------------------------------------------------------------------

// XPath to the Google Meet/Chat message input div (2025+ embedded UI).
// Derived from DevTools inspection; update if Meet changes its structure.
const CHAT_INPUT_XPATH = '/html/body/c-wiz[1]/div/div/div/div/div[1]/div[2]/div/div[4]/div/d-view/div/div/div[7]/div[4]/div/c-wiz/div[4]/div[2]/div[4]/div/div[2]/div/div[2]/div';

/** 同期的にメッセージ入力欄を探す（キャッシュ済みセレクタを含む）。 */
function findMessageInput() {
  // 1. LLM キャッシュ済みセレクタ（最優先）
  if (_cachedSelector) {
    try {
      const cached = document.querySelector(_cachedSelector);
      if (cached && !isSearchInput(cached)) return cached;
    } catch (_) { /* invalid selector */ }
    // キャッシュが無効になっていたらクリアして再探索
    _cachedSelector = null;
  }

  // 2. XPath – most specific, targets the exact Google Chat input div
  try {
    const xpResult = document.evaluate(
      CHAT_INPUT_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    );
    const xpEl = xpResult.singleNodeValue;
    if (xpEl && !isSearchInput(xpEl)) return xpEl;
  } catch (_) { /* XPath not found */ }

  // 3. CSS fast path: specific selectors
  const quick = document.querySelector(SEL.messageInput);
  if (quick && !isSearchInput(quick)) return quick;

  // 4. Deep search: shadow DOM + iframes
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

/**
 * DOM フラグメントを抽出してサーバーに送り、LLM にセレクタを問い合わせる。
 * キャッシュに保存して次回以降は同期パスで見つかるようにする。
 * @returns {Promise<Element|null>}
 */
async function findMessageInputWithLLM() {
  const html = extractChatAreaHTML();
  if (!html) return null;

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'FIND_CHAT_INPUT', html },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[Meet Translator] FIND_CHAT_INPUT error:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        const sel = response?.selector;
        if (!sel) { resolve(null); return; }

        _cachedSelector = sel;
        console.info('[Meet Translator] LLM-discovered selector cached:', sel);
        try {
          const el = document.querySelector(sel);
          resolve(el && !isSearchInput(el) ? el : null);
        } catch (_) {
          resolve(null);
        }
      }
    );
  });
}

/**
 * d-view / c-wiz 要素を中心にチャットパネル周辺の HTML を取り出す。
 * スクリプト・スタイルを除去しサイズを抑える。
 */
function extractChatAreaHTML() {
  // チャットパネルのルートと思われる要素を候補として収集
  const candidates = [
    // 既知の Google Meet チャット統合ルート
    ...Array.from(document.querySelectorAll('d-view')),
    // contenteditable 要素の祖先を辿る（最大 5 段）
    ...Array.from(document.querySelectorAll('[contenteditable]'))
      .filter(el => !isSearchInput(el))
      .map(el => {
        let node = el;
        for (let i = 0; i < 5; i++) {
          if (!node.parentElement) break;
          node = node.parentElement;
        }
        return node;
      }),
  ];

  if (candidates.length === 0) {
    // フォールバック: body 全体の先頭 8000 文字
    return cleanHTML(document.body.innerHTML).slice(0, 8000);
  }

  // 最初の有望な候補を直列化
  const parts = [];
  const seen = new WeakSet();
  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    const fragment = shallowSerialize(el, 4);
    if (fragment) parts.push(fragment);
    if (parts.join('').length > 8000) break;
  }

  const result = parts.join('\n');
  return cleanHTML(result).slice(0, 8000);
}

/** el を最大 depth 段まで outerHTML 風にシリアライズする（重いコンテンツは除去）。 */
function shallowSerialize(el, depth) {
  if (depth <= 0) return `<${el.tagName.toLowerCase()}/>`;
  const tag = el.tagName.toLowerCase();
  if (['script', 'style', 'svg', 'img', 'video', 'audio'].includes(tag)) return '';

  const attrs = Array.from(el.attributes)
    .filter(a => ['id', 'class', 'role', 'aria-label', 'contenteditable',
                   'placeholder', 'type', 'jsname', 'data-panel-id'].includes(a.name))
    .map(a => `${a.name}="${a.value.replace(/"/g, '')}"`)
    .join(' ');

  const children = Array.from(el.children)
    .map(c => shallowSerialize(c, depth - 1))
    .filter(Boolean)
    .join('');

  return `<${tag}${attrs ? ' ' + attrs : ''}>${children}</${tag}>`;
}

/** script/style/イベントハンドラ属性などを除去して文字列をクリーンアップ。 */
function cleanHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Helper: React-compatible text insertion for Google Chat embedded component
// ---------------------------------------------------------------------------
function insertTextToReactInput(el, text) {
  el.focus();

  // Strategy 1: clipboard paste simulation (most reliable for React contenteditable)
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const pasted = el.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
    );
    // If the paste event was not cancelled and content changed, assume success
    if (el.textContent.includes(text)) return true;
  } catch (_) { /* ClipboardEvent not supported */ }

  // Strategy 2: execCommand insertText (works in most browsers)
  el.focus();
  // Clear existing content first
  document.execCommand('selectAll', false, null);
  if (document.execCommand('insertText', false, text)) return true;

  // Strategy 3: textContent + input/change events (last resort)
  el.textContent = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// ---------------------------------------------------------------------------
// Core: post translated text to the Meet chat
// ---------------------------------------------------------------------------
async function postToChat(text) {
  // 同期検索（キャッシュ + 既知セレクタ）
  let input = findMessageInput();

  // 同期検索で見つからなければ LLM フォールバック
  if (!input) {
    console.info('[Meet Translator] 既知セレクタで見つからず → LLM で検索中...');
    input = await findMessageInputWithLLM();
  }

  if (!input) {
    // チャットパネルが閉じている or DOM 未解析 → サイレントスキップ
    console.info('[Meet Translator] チャットパネルが閉じているためスキップ');
    return;
  }

  const ce = input.getAttribute('contenteditable');
  if (ce === 'true' || ce === 'plaintext-only') {
    insertTextToReactInput(input, text);
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

  // Wait for React to process the input and enable the send button
  await new Promise((r) => setTimeout(r, 200));

  // Send: click the send button, or press Enter as fallback
  const sendBtn = document.querySelector(SEL.sendButton) ||
    deepQueryAll(SEL.sendButton).find(b => !b.disabled);
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
