'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const shared = require('../shared.js');

const contentScriptSource = fs.readFileSync(
  path.join(__dirname, '..', 'content.js'),
  'utf8'
);

function isMessageInputSelector(selector) {
  return (
    selector.includes('[jsname="r4nke"]') ||
    selector.includes('[jsname="YPqjbf"]') ||
    selector.includes('[jsname="yrriRe"]') ||
    selector.includes('div[g_editable="true"][contenteditable]') ||
    selector.includes('div[contenteditable')
  );
}

function isSendButtonSelector(selector) {
  return (
    selector.includes('button[jsname="c6xSqd"]') ||
    selector.includes('aria-label="Send message"') ||
    selector.includes('aria-label="メッセージを送信"') ||
    selector.includes('aria-label*="Send"') ||
    selector.includes('aria-label*="送信"')
  );
}

function createElement({
  tagName = 'div',
  attrs = {},
  visible = true,
  hidden = false,
  isContentEditable = false,
  queryAll = null,
} = {}) {
  return {
    tagName: tagName.toUpperCase(),
    parentElement: null,
    hidden,
    disabled: attrs.disabled === true,
    isContentEditable,
    focusCount: 0,
    clickCount: 0,
    dispatchedEvents: [],
    form: null,
    querySelectorAll(selector) {
      return queryAll ? queryAll(selector) : [];
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getBoundingClientRect() {
      return visible ? { width: 10, height: 10 } : { width: 0, height: 0 };
    },
    focus() {
      this.focusCount += 1;
    },
    click() {
      this.clickCount += 1;
    },
    dispatchEvent(event) {
      this.dispatchedEvents.push(event);
      return true;
    },
    closest() {
      return null;
    },
  };
}

function createDocument({ queryAll = () => [], execCommand = () => true } = {}) {
  const execCommands = [];
  return {
    body: {},
    documentElement: {},
    execCommands,
    querySelectorAll(selector) {
      return queryAll(selector);
    },
    querySelector(selector) {
      return queryAll(selector)[0] || null;
    },
    execCommand(command, ui, value) {
      execCommands.push([command, ui, value]);
      return execCommand(command, ui, value);
    },
  };
}

function loadContentScript({
  document,
  hostname = 'meet.google.com',
  topFrame = true,
} = {}) {
  const doc = document || createDocument();
  const win = {
    top: null,
    getComputedStyle() {
      return { display: 'block', visibility: 'visible' };
    },
  };
  win.top = topFrame ? win : {};

  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(_message, callback) {
        callback({ success: true, registered: true });
      },
      onMessage: {
        addListener() {},
      },
    },
  };

  const context = {
    console: {
      log() {},
      info() {},
      warn() {},
      error() {},
    },
    globalThis: null,
    window: win,
    document: doc,
    location: {
      hostname,
      href: `https://${hostname}/test`,
    },
    chrome,
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    Event: class Event {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    setTimeout(fn) {
      fn();
      return 0;
    },
    clearTimeout() {},
  };

  context.globalThis = context;
  context.MeetTranslatorShared = shared;

  vm.runInNewContext(contentScriptSource, context, {
    filename: 'content.js',
  });

  return context;
}

test('findMessageInput ignores the Google Chat search field and picks the composer', () => {
  const searchBox = createElement({
    isContentEditable: true,
    attrs: { 'aria-label': 'Chat を検索…' },
  });
  const composer = createElement({
    isContentEditable: true,
    attrs: { 'aria-label': '履歴がオンになっています' },
  });
  const dview = createElement({
    queryAll(selector) {
      if (selector === 'div[contenteditable]:not([contenteditable="false"])') {
        return [searchBox, composer];
      }
      return [];
    },
  });

  const document = createDocument({
    queryAll(selector) {
      if (isMessageInputSelector(selector)) return [];
      if (selector === 'd-view') return [dview];
      if (selector === 'div[g_editable="true"][contenteditable]') return [];
      return [];
    },
  });

  const context = loadContentScript({ document });
  assert.equal(context.findMessageInput(), composer);
});

test('findSendButton prefers the nearby visible enabled send button', () => {
  const localSendButton = createElement({ tagName: 'button' });
  const hiddenSendButton = createElement({ tagName: 'button', visible: false });
  const disabledSendButton = createElement({
    tagName: 'button',
    attrs: { 'aria-disabled': 'true' },
  });
  const globalSendButton = createElement({ tagName: 'button' });
  const input = createElement({ isContentEditable: true });
  const composer = createElement({
    queryAll(selector) {
      if (isSendButtonSelector(selector)) {
        return [hiddenSendButton, disabledSendButton, localSendButton];
      }
      return [];
    },
  });
  input.parentElement = composer;

  const document = createDocument({
    queryAll(selector) {
      if (isSendButtonSelector(selector)) return [globalSendButton];
      return [];
    },
  });

  const context = loadContentScript({ document });
  assert.equal(context.findSendButton(input), localSendButton);
});

test('getChatPostDestination returns the embedded chat iframe when no local input exists', () => {
  const iframe = createElement({ tagName: 'iframe' });

  const document = createDocument({
    queryAll(selector) {
      if (isMessageInputSelector(selector)) return [];
      if (selector === 'd-view') return [];
      if (selector === 'div[g_editable="true"][contenteditable]') return [];
      if (selector === 'iframe[src*="chat.google.com"]') return [iframe];
      return [];
    },
  });

  const context = loadContentScript({ document });
  const destination = context.getChatPostDestination();

  assert.equal(destination.kind, 'embedded-chat');
  assert.equal(destination.iframe, iframe);
});

test('postTextIntoInput fills a contenteditable composer and clicks its send button', async () => {
  const sendButton = createElement({ tagName: 'button' });
  const input = createElement({ isContentEditable: true });
  const composer = createElement({
    queryAll(selector) {
      if (isSendButtonSelector(selector)) return [sendButton];
      return [];
    },
  });
  input.parentElement = composer;

  const document = createDocument();
  const context = loadContentScript({ document });

  await context.postTextIntoInput(input, 'translated text');

  assert.deepEqual(document.execCommands, [
    ['selectAll', false, null],
    ['insertText', false, 'translated text'],
  ]);
  assert.equal(sendButton.clickCount, 1);
});
