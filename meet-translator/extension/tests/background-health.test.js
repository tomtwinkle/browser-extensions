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

function loadBackgroundScript() {
  const intervalCallbacks = [];
  const chrome = {
    alarms: {
      create() {},
      clear() {},
      onAlarm: {
        addListener() {},
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
        addListener() {},
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
      getMediaStreamId(_options, callback) {
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
    fetch: async () => ({ ok: true, async json() { return {}; } }),
    globalThis: null,
    importScripts() {},
    clearInterval() {},
    clearTimeout() {},
    setInterval(fn) {
      intervalCallbacks.push(fn);
      return intervalCallbacks.length;
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

  return { chrome, context, intervalCallbacks };
}

test('assessHealthCheckFailures only stops after the configured threshold', () => {
  const { context } = loadBackgroundScript();

  let assessment = context.assessHealthCheckFailures(0, false);
  assert.equal(assessment.failureCount, 1);
  assert.equal(assessment.recovered, false);
  assert.equal(assessment.shouldStop, false);

  assessment = context.assessHealthCheckFailures(2, false);
  assert.equal(assessment.failureCount, 3);
  assert.equal(assessment.recovered, false);
  assert.equal(assessment.shouldStop, true);

  assessment = context.assessHealthCheckFailures(2, true);
  assert.equal(assessment.failureCount, 0);
  assert.equal(assessment.recovered, true);
  assert.equal(assessment.shouldStop, false);
});

test('runPeriodicHealthCheck stops only after sustained failures plus confirmation', async () => {
  const sentMessages = [];
  const { chrome, context } = loadBackgroundScript();

  const healthResults = [
    { ok: true, whisperModel: 'base', llamaModel: 'qwen3' }, // startCapture
    { ok: false },
    { ok: false },
    { ok: false },
    { ok: false }, // confirmation before stop
  ];

  context.checkServerHealth = async () => healthResults.shift() || { ok: false };

  let stopCalls = 0;
  context.stopCapture = async () => {
    stopCalls += 1;
  };
  chrome.runtime.sendMessage = (message) => {
    sentMessages.push(message);
    return Promise.resolve({});
  };

  await context.startCapture(123);

  await context.runPeriodicHealthCheck();
  assert.equal(stopCalls, 0);

  await context.runPeriodicHealthCheck();
  assert.equal(stopCalls, 0);

  await context.runPeriodicHealthCheck();
  assert.equal(stopCalls, 1);
  assert.ok(sentMessages.some((message) => message.type === 'SERVER_UNREACHABLE'));
});

test('runPeriodicHealthCheck resets the failure streak after a recovery', async () => {
  const { context } = loadBackgroundScript();

  const healthResults = [
    { ok: true, whisperModel: 'base', llamaModel: 'qwen3' }, // startCapture
    { ok: false },
    { ok: true, whisperModel: 'base', llamaModel: 'qwen3' }, // recovery
    { ok: false },
    { ok: false },
  ];

  context.checkServerHealth = async () => healthResults.shift() || { ok: false };

  let stopCalls = 0;
  context.stopCapture = async () => {
    stopCalls += 1;
  };

  await context.startCapture(123);
  await context.runPeriodicHealthCheck();
  await context.runPeriodicHealthCheck();
  await context.runPeriodicHealthCheck();
  await context.runPeriodicHealthCheck();

  assert.equal(stopCalls, 0);
});
