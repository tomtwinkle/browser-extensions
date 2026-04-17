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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createWavBase64(
  samples,
  { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}
) {
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 4, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 4, 'ascii');
  buffer.write('fmt ', 12, 4, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 4, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  samples.forEach((sample, index) => {
    buffer.writeInt16LE(sample, 44 + index * bytesPerSample);
  });

  return buffer.toString('base64');
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

test('audio queue keeps sending later chunks while earlier translations are still running', async () => {
  const firstTranslation = createDeferred();
  const requests = [];
  let transcribeCount = 0;
  let translateCount = 0;
  const { context } = loadBackgroundScript({
    fetchImpl: async (url) => {
      if (url.endsWith('/transcribe')) {
        transcribeCount += 1;
        requests.push(`transcribe-${transcribeCount}`);
        return {
          ok: true,
          async json() {
            return {
              transcription: `utterance ${transcribeCount}`,
              detected_language: 'en',
            };
          },
        };
      }
      if (url.endsWith('/translate')) {
        translateCount += 1;
        requests.push(`translate-${translateCount}`);
        if (translateCount === 1) {
          await firstTranslation.promise;
        }
        return {
          ok: true,
          async json() {
            return { translation: `translation ${translateCount}` };
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  const wavB64 = createWavBase64(new Array(160).fill(0));
  context.enqueueAudioTask(() => context.handleAudioData(wavB64));
  context.enqueueAudioTask(() => context.handleAudioData(wavB64));

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transcribeCount, 2);
  assert.deepEqual(requests.slice(0, 3), ['transcribe-1', 'translate-1', 'transcribe-2']);

  firstTranslation.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

test('stopCapture waits for in-flight translations before notifying the tab', async () => {
  const pendingTranslation = createDeferred();
  const tabMessages = [];
  const { chrome, context } = loadBackgroundScript({
    fetchImpl: async (url) => {
      if (url.endsWith('/transcribe')) {
        return {
          ok: true,
          async json() {
            return {
              transcription: 'hello world',
              detected_language: 'en',
            };
          },
        };
      }
      if (url.endsWith('/translate')) {
        await pendingTranslation.promise;
        return {
          ok: true,
          async json() {
            return { translation: 'こんにちは世界' };
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  chrome.tabs.sendMessage = async (_tabId, message) => {
    tabMessages.push(message.type);
    return message.type === 'GET_ACTIVE_SPEAKER'
      ? { speakerName: null }
      : { success: true };
  };
  context.checkServerHealth = async () => ({
    ok: true,
    whisperModel: 'base',
    llamaModel: 'qwen3',
  });

  await context.startCapture(123);
  context.enqueueAudioTask(() => context.handleAudioData(createWavBase64(new Array(160).fill(0))));

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  let stopped = false;
  const stopPromise = context.stopCapture().then(() => {
    stopped = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopped, false);
  assert.equal(tabMessages.includes('TRANSLATION_STOPPED'), false);

  pendingTranslation.resolve();
  await stopPromise;

  assert.equal(tabMessages.includes('TRANSLATION_STOPPED'), true);
});
