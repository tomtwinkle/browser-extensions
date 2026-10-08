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
    getElementById() {
      return null;
    },
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
  const runtimeMessageListeners = [];
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
        addListener(listener) { runtimeMessageListeners.push(listener); },
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
  context.__runtimeMessageListeners = runtimeMessageListeners;

  vm.runInNewContext(contentScriptSource, context, {
    filename: 'content.js',
  });

  return context;
}

test('feedback toggle stays open and keeps the locked utterance after new speech arrives', () => {
  const context = loadContentScript();

  assert.equal(context.handleFeedbackToggleClick(), false);
  assert.equal(context.applyFeedbackContextUpdate({
    speakerName: 'Test Speaker',
    original: 'first original',
    translation: 'first translation',
  }), true);
  assert.equal(context.handleFeedbackToggleClick(), true);
  assert.deepEqual(context.getVisibleFeedbackContext(), {
    speakerName: 'Test Speaker',
    original: 'first original',
    translation: 'first translation',
  });

  assert.equal(context.applyFeedbackContextUpdate({
    speakerName: 'Test Speaker',
    original: 'second original',
    translation: 'second translation',
  }), true);
  assert.equal(context.handleFeedbackToggleClick(), true);
  assert.deepEqual(context.getVisibleFeedbackContext(), {
    speakerName: 'Test Speaker',
    original: 'first original',
    translation: 'first translation',
  });
});

test('Meet overlay ignores stale session and stream-generation results', () => {
  const context = loadContentScript();
  const messageListener = context.__runtimeMessageListeners[0];
  let shown = 0;
  let destroyed = 0;
  context.showOverlay = () => { shown += 1; };
  context.destroyOverlay = () => { destroyed += 1; };
  context.destroyFeedbackUi = () => {};

  const send = (message) => {
    let response;
    messageListener(message, {}, (value) => { response = value; });
    return response;
  };
  const assertResponse = (message, expected) => {
    assert.deepEqual(JSON.parse(JSON.stringify(send(message))), expected);
  };
  assertResponse({
    type: 'TRANSLATION_STARTED',
    sessionId: 'session-new',
    streamGenerations: { mic: 4, tab: 8 },
  }, { success: true });
  assertResponse({
    type: 'SHOW_OVERLAY',
    sessionId: 'session-old',
    streamId: 'mic',
    streamGeneration: 3,
    original: 'stale',
  }, { success: false, stale: true });
  assertResponse({
    type: 'SHOW_OVERLAY',
    sessionId: 'session-new',
    streamId: 'mic',
    streamGeneration: 3,
    original: 'old generation',
  }, { success: false, stale: true });
  assertResponse({
    type: 'SHOW_OVERLAY',
    sessionId: 'session-new',
    streamId: 'mic',
    streamGeneration: 4,
    original: 'current',
  }, { success: true });
  assert.equal(shown, 1);
  assertResponse({ type: 'TRANSLATION_STOPPED', sessionId: 'session-old' }, { success: false, stale: true });
  assertResponse({ type: 'TRANSLATION_STOPPED', sessionId: 'session-new' }, { success: true });
  assert.equal(destroyed, 1);
});
