'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const shared = require('../shared.js');

const backgroundScriptSource = fs.readFileSync(
  path.join(__dirname, '..', 'background.js'),
  'utf8'
);

function loadBackgroundScript({ fetchImpl } = {}) {
  const listeners = {
    onAlarm: null,
    onMessage: null,
  };

  const chrome = {
    alarms: {
      create() {},
      clear() {},
      onAlarm: {
        addListener(listener) {
          listeners.onAlarm = listener;
        },
      },
    },
    offscreen: {
      async createDocument() {},
      async closeDocument() {},
    },
    runtime: {
      getURL(file) {
        return `chrome-extension://test/${file}`;
      },
      async getContexts() {
        return [];
      },
      lastError: null,
      onMessage: {
        addListener(listener) {
          listeners.onMessage = listener;
        },
      },
      sendMessage() {
        return Promise.resolve({});
      },
    },
    scripting: {
      async executeScript() {},
    },
    storage: {
      local: {
        async get() {
          return {};
        },
      },
    },
    tabCapture: {
      getMediaStreamId(_opts, callback) {
        callback('stream-id');
      },
    },
    tabs: {
      sendMessage() {
        return Promise.resolve({ success: true });
      },
    },
  };

  const context = {
    AbortController,
    Blob,
    FormData,
    URLSearchParams,
    chrome,
    console: {
      info() {},
      log() {},
      warn() {},
      error() {},
    },
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ status: 'ok' }) })),
    globalThis: null,
    importScripts() {},
    clearInterval() {},
    clearTimeout() {},
    setInterval() {
      return 1;
    },
    setTimeout() {
      return 1;
    },
  };

  context.globalThis = context;
  context.MeetTranslatorShared = shared;

  vm.runInNewContext(backgroundScriptSource, context, {
    filename: 'background.js',
  });

  return { chrome, context, listeners };
}

test('submitGlossaryFeedback trims source and target before posting to the server', async () => {
  const requests = [];
  const { context } = loadBackgroundScript({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        async json() {
          return { status: 'ok' };
        },
      };
    },
  });

  await context.submitGlossaryFeedback({
    kind: 'correction',
    source: '  get hub  ',
    target: ' GitHub ',
    speakerName: ' Test Speaker ',
    original: '  get hub  ',
    translation: '  translated  ',
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://localhost:17070/glossary/corrections');

  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.source, 'get hub');
  assert.equal(payload.target, 'GitHub');
  assert.match(payload.description, /^user-feedback \| speaker=Test Speaker \| original=get hub \| translation=translated$/);
});
