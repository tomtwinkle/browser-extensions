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

test('audio metadata requires a current session and stream generation', () => {
  const { context } = loadBackgroundScript();
  const generations = { mic: 3, tab: 7 };
  const event = { sessionId: 'session-a', streamId: 'mic', streamGeneration: 3 };

  assert.equal(context.isCurrentAudioMetadata(event, 'session-a', generations), true);
  assert.equal(context.isCurrentAudioMetadata({ ...event, sessionId: 'session-old' }, 'session-a', generations), false);
  assert.equal(context.isCurrentAudioMetadata({ ...event, streamGeneration: 2 }, 'session-a', generations), false);
  assert.equal(context.isCurrentAudioMetadata({ ...event, streamId: 'mixed' }, 'session-a', generations), false);
});

test('audio queue bounds pending audio and reports stale or overloaded drops', async () => {
  const { context } = loadBackgroundScript();
  let releaseBlocker;
  const blocker = context.enqueueAudioTask(() => new Promise((resolve) => {
    releaseBlocker = resolve;
  }));
  await Promise.resolve();

  const queued = Array.from({ length: 4 }, (_, index) => context.enqueueAudioTask(
    () => index,
    { audioMs: 2500, queuedAtMs: Date.now() }
  ));
  let overloadedTaskRan = false;
  const overloadedPromise = context.enqueueAudioTask(() => {
    overloadedTaskRan = true;
  }, { audioMs: 100, queuedAtMs: Date.now() });

  let staleTaskRan = false;
  const stalePromise = context.enqueueAudioTask(() => {
    staleTaskRan = true;
  }, { audioMs: 250, queuedAtMs: Date.now() - 5001 });

  releaseBlocker();
  const [overloaded, stale] = await Promise.all([blocker, ...queued, overloadedPromise, stalePromise])
    .then((results) => results.slice(-2));
  assert.equal(overloaded?.accepted, false);
  assert.equal(overloaded?.code, 'OVERLOAD');
  assert.equal(overloaded?.droppedCount, 1);
  assert.equal(overloaded?.droppedAudioMs, 100);
  assert.equal(overloadedTaskRan, false);
  assert.equal(stale.code, 'STALE');
  assert.equal(staleTaskRan, false);
  assert.equal(context.__testState.audioQueueStatus.code, 'STALE');
});

test('audio queue rejects aggregate duration overflow', async () => {
  const { context } = loadBackgroundScript();
  let releaseBlocker;
  const blocker = context.enqueueAudioTask(() => new Promise((resolve) => {
    releaseBlocker = resolve;
  }));
  await Promise.resolve();

  const accepted = Array.from({ length: 3 }, () => context.enqueueAudioTask(
    () => true,
    { audioMs: 3000, queuedAtMs: Date.now() }
  ));
  let overflowTaskRan = false;
  const overflow = context.enqueueAudioTask(() => {
    overflowTaskRan = true;
  }, { audioMs: 1500, queuedAtMs: Date.now() });

  releaseBlocker();
  const results = await Promise.all([blocker, ...accepted, overflow]);
  const overflowResult = results.at(-1);
  assert.equal(overflowResult.code, 'OVERLOAD');
  assert.equal(overflowResult.droppedAudioMs, 1500);
  assert.equal(overflowTaskRan, false);
});

test('audio queue rechecks staleness before running queued work', async () => {
  const { context } = loadBackgroundScript();
  let now = 1_000;
  context.Date = class TestDate extends Date {
    static now() { return now; }
  };
  let releaseBlocker;
  const blocker = context.enqueueAudioTask(() => new Promise((resolve) => {
    releaseBlocker = resolve;
  }));
  await Promise.resolve();

  let staleTaskRan = false;
  const queued = context.enqueueAudioTask(() => {
    staleTaskRan = true;
  }, { audioMs: 1000, queuedAtMs: now });
  now += 5001;
  releaseBlocker();

  const [, result] = await Promise.all([blocker, queued]);
  assert.equal(result.code, 'STALE');
  assert.equal(result.droppedAudioMs, 1000);
  assert.equal(staleTaskRan, false);
});

test('concurrent capture start is rejected before health check resolves', async () => {
  let resolveHealth;
  const { context } = loadBackgroundScript({
    fetchImpl: () => new Promise((resolve) => { resolveHealth = resolve; }),
  });

  const first = context.startCapture(7);
  assert.equal(context.__testState.isStarting, true);
  context.__testState.isActive = true;
  await assert.rejects(context.startCapture(8), /開始処理中/);
  context.__testState.isActive = false;

  resolveHealth({ ok: false, status: 503 });
  await assert.rejects(first, /サーバーに接続/);
  assert.equal(context.__testState.isStarting, false);
  assert.equal(context.__testState.sessionId, null);
});

function loadBackgroundScript({ fetchImpl, storageSettings = {}, setTimeoutImpl, clearTimeoutImpl } = {}) {
  const listeners = {
    onAlarm: null,
    onMessage: null,
  };
  let storageAccessLevel = null;
  const tabMessages = [];

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
        async get(keys) {
          return Object.fromEntries(keys
            .filter((key) => Object.prototype.hasOwnProperty.call(storageSettings, key))
            .map((key) => [key, storageSettings[key]]));
        },
        setAccessLevel(options) {
          storageAccessLevel = options.accessLevel;
          return Promise.resolve();
        },
      },
    },
    tabCapture: {
      getMediaStreamId(_opts, callback) {
        callback('stream-id');
      },
    },
    tabs: {
      sendMessage(_tabId, message) {
        tabMessages.push(message);
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
    clearTimeout: clearTimeoutImpl || clearTimeout,
    setInterval() {
      return 1;
    },
    setTimeout: setTimeoutImpl || setTimeout,
  };

  context.globalThis = context;
  context.MeetTranslatorShared = shared;

  vm.runInNewContext(backgroundScriptSource, context, {
    filename: 'background.js',
  });
  context.__testState = vm.runInNewContext('state', context);

  return { chrome, context, listeners, tabMessages, get storageAccessLevel() { return storageAccessLevel; } };
}

test('local API request timeout aborts a stalled fetch', async () => {
  let observedSignal;
  const { context } = loadBackgroundScript({
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    setTimeoutImpl(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeoutImpl() {},
  });

  await assert.rejects(context.fetchWithTimeout('http://localhost:17070/translate', {}, 1), {
    name: 'AbortError',
  });
  assert.equal(observedSignal.aborted, true);
});

test('translateOnly sends the local API token only as a bearer header', async () => {
  const requests = [];
  const token = 'local-test-token-0123456789012345';
  const { context } = loadBackgroundScript({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, async json() { return { translation: 'こんにちは' }; } };
    },
  });

  await context.translateOnly('hello', 'en', 'ja', {
    serverUrl: 'http://localhost:17070',
    apiToken: token,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].url.includes(token), false);
  assert.equal(String(requests[0].options.body).includes(token), false);
});

test('refuses to send the bearer token to a non-loopback server URL', async () => {
  const requests = [];
  const { context } = loadBackgroundScript({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, async json() { return { translation: 'translated' }; } };
    },
  });

  await assert.rejects(
    context.translateOnly('private text', 'en', 'ja', {
      serverUrl: 'https://attacker.example',
      apiToken: 'sensitive-test-token',
    }),
    /loopback/
  );
  assert.equal(requests.length, 0);
});

test('server health request reads the token from extension storage', async () => {
  const requests = [];
  const token = 'stored-token-012345678901234567890123';
  const { context } = loadBackgroundScript({
    storageSettings: {
      serverUrl: 'http://localhost:17070',
      apiToken: token,
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, async json() { return { status: 'ok' }; } };
    },
  });

  const result = await context.checkServerHealth();
  assert.equal(result.ok, true);
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
});

test('restricts extension storage to trusted extension contexts', () => {
  const { storageAccessLevel } = loadBackgroundScript();
  assert.equal(storageAccessLevel, 'TRUSTED_CONTEXTS');
});

test('legacy chatEnabled setting never posts recognized or translated text to chat', async () => {
  const { context, tabMessages } = loadBackgroundScript({
    storageSettings: {
      chatEnabled: true,
      chatFormat: 'both',
      overlayEnabled: true,
    },
    fetchImpl: async (url) => ({
      ok: true,
      async json() {
        if (String(url).endsWith('/transcribe')) {
          return { transcription: 'The meeting starts now', detected_language: 'en' };
        }
        return { translation: '会議は今始まります' };
      },
    }),
  });

  await context.processAudioChunk('AQID', 'Test Speaker', 7, 2000);

  assert.equal(tabMessages.some((message) => message.type === 'POST_TRANSLATION'), false);
});

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
  assert.equal(requests[0].url, 'http://127.0.0.1:17070/glossary/corrections');

  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.source, 'get hub');
  assert.equal(payload.target, 'GitHub');
  assert.equal(payload.description, 'user-feedback | kind=correction');
});

test('resolveTranscriptionSourceLang keeps Whisper on auto-detect for bidirectional meetings', () => {
  const { context } = loadBackgroundScript();

  assert.equal(
    context.resolveTranscriptionSourceLang({
      sourceLang: 'en',
      targetLang: 'ja',
      bidirectional: true,
    }),
    ''
  );
  assert.equal(
    context.resolveTranscriptionSourceLang({
      sourceLang: 'en',
      targetLang: 'ja',
      bidirectional: false,
    }),
    'en'
  );
  assert.equal(
    context.resolveTranscriptionSourceLang({
      sourceLang: 'en',
      targetLang: 'en',
      bidirectional: true,
    }),
    'en'
  );
});

test('shouldRequestTranscription requires positive VAD evidence instead of a duration floor', () => {
  const { context } = loadBackgroundScript();

  const evidence = {
    vadKind: 'energy',
    speechDetected: true,
    voicedDurationMs: 320,
    utteranceDurationMs: 960,
    clippingRatio: 0,
  };
  assert.equal(context.shouldRequestTranscription(320, evidence), true);
  assert.equal(context.shouldRequestTranscription(999), false);
  assert.equal(context.shouldRequestTranscription(320, { ...evidence, speechDetected: false }), false);
  assert.equal(context.shouldRequestTranscription(320, { ...evidence, clippingRatio: 2 }), false);
});

test('transcribeOnly forwards speech evidence and preserves model diagnostics', async () => {
  const requests = [];
  const { context } = loadBackgroundScript({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            transcription: 'ご視聴ありがとうございました',
            raw_text: 'Thank you for watching',
            detected_language: 'ja',
            backend: 'whisper.cpp',
            segments: [{ start_ms: 0, end_ms: 900, avg_logprob: -0.91, no_speech_probability: 0.81 }],
            quality_flags: ['LOW_LOGPROB', 'HIGH_NO_SPEECH', 'KNOWN_HALLUCINATION_PHRASE'],
          };
        },
      };
    },
  });

  const result = await context.transcribeOnly(Buffer.from('RIFF').toString('base64'), {
    serverUrl: 'http://localhost:17070',
    sourceLang: '',
    targetLang: 'ja',
    bidirectional: false,
  }, 5123.8, {
    vadKind: 'energy',
    speechDetected: true,
    clippingRatio: 0.002,
    voicedDurationMs: 5123.8,
    utteranceDurationMs: 6000,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://localhost:17070/transcribe');
  assert.equal(requests[0].options.body.get('speech_ms'), '5124');
  assert.equal(requests[0].options.body.get('vad_kind'), 'energy');
  assert.equal(requests[0].options.body.get('speech_detected'), 'true');
  assert.equal(requests[0].options.body.get('clipping_ratio'), '0.002');
  assert.equal(result.rawText, 'Thank you for watching');
  assert.equal(result.backend, 'whisper.cpp');
  assert.deepEqual(Array.from(result.qualityFlags), ['LOW_LOGPROB', 'HIGH_NO_SPEECH', 'KNOWN_HALLUCINATION_PHRASE']);
  assert.equal(result.segments[0].avg_logprob, -0.91);
});

test('suspicious ASR output becomes a private candidate with its diagnostics', async () => {
  const rpcMessages = [];
  const { context } = loadBackgroundScript({
    fetchImpl: async (url) => ({
      ok: true,
      async json() {
        if (String(url).endsWith('/transcribe')) {
          return {
            transcription: 'ご視聴ありがとうございました',
            raw_text: 'Thank you for watching',
            detected_language: 'ja',
            backend: 'whisper.cpp',
            segments: [{ start_ms: 0, end_ms: 900, avg_logprob: -0.91, no_speech_probability: 0.81 }],
            quality_flags: ['LOW_LOGPROB', 'HIGH_NO_SPEECH', 'KNOWN_HALLUCINATION_PHRASE'],
          };
        }
        return { translation: 'ご視聴ありがとうございました' };
      },
    }),
  });
  const state = context.__testState;
  state.isActive = true;
  state.tabId = 7;
  state.sessionId = 'session-a';
  state.streamGenerations = { mic: 0, tab: 2 };
  const port = {
    postMessage(message) {
      if (message.type !== 'CAPTION_RPC') return;
      rpcMessages.push(message);
      const result = message.action === 'upsert-candidate'
        ? { ok: true, record: { ...message.payload.candidate, revision: 1 } }
        : { ok: true, record: { segmentId: message.payload.segmentId } };
      context.handleOffscreenPortMessage(port, {
        type: 'CAPTION_RPC_RESULT',
        requestId: message.requestId,
        result,
      });
    },
  };
  state.offscreenPort = port;

  await context.processAudioChunk('UklGRg==', null, 7, 900, {
    sessionId: 'session-a', streamId: 'tab', streamGeneration: 2,
    evidence: { vadKind: 'energy', speechDetected: true, voicedDurationMs: 900, utteranceDurationMs: 1100, clippingRatio: 0 },
  });

  const candidateRequest = rpcMessages.find((message) => message.action === 'upsert-candidate');
  assert.ok(candidateRequest, 'ASR output should be stored for host review');
  assert.equal(candidateRequest.payload.candidate.sourceText, 'ご視聴ありがとうございました');
  assert.equal(candidateRequest.payload.candidate.rawText, 'Thank you for watching');
  assert.ok(candidateRequest.payload.candidate.reasonCodes.includes('KNOWN_HALLUCINATION_PHRASE'));
  assert.ok(candidateRequest.payload.candidate.reasonCodes.includes('LOW_LOGPROB'));
  assert.equal(candidateRequest.payload.candidate.evidence.asrSegments[0].avgLogprob, -0.91);
});

test('resolveTranscriptLanguage rejects transcriptions outside the configured language set', () => {
  const { context } = loadBackgroundScript();

  const fixedSource = context.resolveTranscriptLanguage(
    {
      sourceLang: 'en',
      targetLang: 'ja',
      bidirectional: false,
    },
    'コンテンツ',
    'ja'
  );
  assert.equal(fixedSource.accepted, false);
  assert.equal(fixedSource.language, null);
  assert.equal(fixedSource.reason, 'unexpected language ja');

  const bidirectional = context.resolveTranscriptLanguage(
    {
      sourceLang: 'en',
      targetLang: 'ja',
      bidirectional: true,
    },
    'こんにちは',
    ''
  );
  assert.equal(bidirectional.accepted, true);
  assert.equal(bidirectional.language, 'ja');
});

test('resolveTranscriptLanguage prefers text heuristics when ASR detection is misleading', () => {
  const { context } = loadBackgroundScript();

  const result = context.resolveTranscriptLanguage(
    {
      sourceLang: 'en',
      targetLang: 'ja',
      bidirectional: false,
    },
    'Hello everyone',
    'ja'
  );
  assert.equal(result.accepted, true);
  assert.equal(result.language, 'en');
});
