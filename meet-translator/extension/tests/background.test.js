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

function makeWavBase64(durationMs) {
  const sampleRate = 16_000;
  const byteRate = sampleRate * 2;
  const dataBytes = Math.floor(durationMs * byteRate / 1_000);
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav.toString('base64');
}

function sendAudioData(context, durationMs, audioEndedAtMs = null) {
  const message = {
    type: 'AUDIO_DATA',
    sessionId: 'session-a',
    streamId: 'tab',
    streamGeneration: 1,
    wavB64: makeWavBase64(durationMs),
    speechMs: durationMs,
    evidence: {
      vadKind: 'energy',
      speechDetected: true,
      voicedDurationMs: durationMs,
      utteranceDurationMs: durationMs,
      clippingRatio: 0,
    },
  };
  if (Number.isFinite(audioEndedAtMs)) message.audioEndedAtMs = audioEndedAtMs;
  context.handleOffscreenPortMessage({}, message);
}

function setFakeClock(context, startMs) {
  let now = startMs;
  context.Date = class TestDate extends Date {
    static now() { return now; }
  };
  return {
    now: () => now,
    set(value) { now = value; },
    advance(delta) { now += delta; },
  };
}

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

  const accepted = [
    ...Array.from({ length: 3 }, () => context.enqueueAudioTask(
      () => true,
      { audioMs: 3000, queuedAtMs: Date.now() }
    )),
    context.enqueueAudioTask(() => true, { audioMs: 1000, queuedAtMs: Date.now() }),
  ];
  let overflowTaskRan = false;
  const overflow = context.enqueueAudioTask(() => {
    overflowTaskRan = true;
  }, { audioMs: 1, queuedAtMs: Date.now() });

  releaseBlocker();
  const results = await Promise.all([blocker, ...accepted, overflow]);
  const overflowResult = results.at(-1);
  assert.equal(overflowResult.code, 'OVERLOAD');
  assert.equal(overflowResult.droppedAudioMs, 1);
  assert.equal(overflowTaskRan, false);
});

test('translation wait and audio-age deadlines use strict fake-clock boundaries', async () => {
  const cases = [
    { name: 'wait D-1', waitMs: 2_999, audioAgeBeforeWaitMs: 0, accepted: true },
    { name: 'wait D', waitMs: 3_000, audioAgeBeforeWaitMs: 0, accepted: true },
    { name: 'wait D+1', waitMs: 3_001, audioAgeBeforeWaitMs: 0, accepted: false },
    { name: 'audio age D-1', waitMs: 1_999, audioAgeBeforeWaitMs: 6_000, accepted: true },
    { name: 'audio age D', waitMs: 2_000, audioAgeBeforeWaitMs: 6_000, accepted: true },
    { name: 'audio age D+1', waitMs: 2_001, audioAgeBeforeWaitMs: 6_000, accepted: false },
  ];

  for (const tc of cases) {
    const { context } = loadBackgroundScript();
    const clock = setFakeClock(context, 10_000);
    let releaseActive;
    let markActiveStarted;
    const activeStarted = new Promise((resolve) => { markActiveStarted = resolve; });
    const active = context.enqueueTranslationTask(() => new Promise((resolve) => {
      releaseActive = resolve;
      markActiveStarted();
    }), { segmentId: 'active', sourceRevision: 1 });
    await activeStarted;

    let queuedTaskRan = false;
    const queued = context.enqueueTranslationTask(() => {
      queuedTaskRan = true;
      return 'queued';
    }, {
      segmentId: tc.name,
      sourceRevision: 1,
      queuedAtMs: clock.now(),
      audioEndedAtMs: clock.now() - tc.audioAgeBeforeWaitMs,
    });
    const queuedOutcome = queued.then(
      (value) => ({ value }),
      (error) => ({ error })
    );

    clock.advance(tc.waitMs);
    releaseActive('active');
    await active;
    const outcome = await queuedOutcome;
    assert.equal(queuedTaskRan, tc.accepted, `${tc.name}: task execution`);
    if (tc.accepted) {
      assert.equal(outcome.value, 'queued', `${tc.name}: result`);
    } else {
      assert.equal(outcome.error?.code, 'TRANSLATION_STALE', `${tc.name}: drop reason`);
    }
  }
});

test('translation queue holds eight pending jobs and keeps only a newer pending source revision', async () => {
  const { context } = loadBackgroundScript();
  let releaseActive;
  let markActiveStarted;
  const activeStarted = new Promise((resolve) => { markActiveStarted = resolve; });
  const active = context.enqueueTranslationTask(() => new Promise((resolve) => {
    releaseActive = resolve;
    markActiveStarted();
  }), { segmentId: 'active', sourceRevision: 1 });
  await activeStarted;

  const oldRevisionOutcome = context.enqueueTranslationTask(() => 'old revision', {
    segmentId: 'replace-me', sourceRevision: 1,
  }).then(() => null, (error) => error);
  const newRevision = context.enqueueTranslationTask(() => 'new revision', {
    segmentId: 'replace-me', sourceRevision: 2,
  });
  assert.equal(context.__testState.translationQueue.length, 1);
  assert.equal((await oldRevisionOutcome)?.code, 'TRANSLATION_STALE');

  const pending = Array.from({ length: 7 }, (_, index) => context.enqueueTranslationTask(
    () => index,
    { segmentId: `segment-${index}`, sourceRevision: 1 }
  ));
  const overflow = context.enqueueTranslationTask(() => 'overflow', {
    segmentId: 'segment-overflow', sourceRevision: 1,
  }).then(() => null, (error) => error);
  assert.equal(context.__testState.translationQueue.length, 8);
  assert.equal((await overflow)?.code, 'TRANSLATION_OVERLOAD');

  releaseActive('active');
  await active;
  const pendingResults = await Promise.all(pending);
  assert.deepEqual(pendingResults, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(await newRevision, 'new revision');
  assert.equal(context.__testState.translationQueue.length, 0);
});

test('stale pending translations release capacity before a new admission', async () => {
  const { context } = loadBackgroundScript();
  const clock = setFakeClock(context, 10_000);
  let releaseActive;
  let markActiveStarted;
  const activeStarted = new Promise((resolve) => { markActiveStarted = resolve; });
  const active = context.enqueueTranslationTask(() => new Promise((resolve) => {
    releaseActive = resolve;
    markActiveStarted();
  }), { segmentId: 'active', sourceRevision: 1 });
  await activeStarted;

  const oldPending = Array.from({ length: 8 }, (_, index) => context.enqueueTranslationTask(
    () => `old-${index}`,
    { segmentId: `old-${index}`, sourceRevision: 1 }
  ).then(() => null, (error) => error));
  assert.equal(context.__testState.translationQueue.length, 8);
  clock.advance(3_001);
  const fresh = context.enqueueTranslationTask(() => 'fresh', {
    segmentId: 'fresh',
    sourceRevision: 1,
  });

  assert.equal(context.__testState.translationQueue.length, 1);
  const staleResults = await Promise.all(oldPending);
  assert.ok(staleResults.every((error) => error?.code === 'TRANSLATION_STALE'));
  releaseActive('done');
  await active;
  assert.equal(await fresh, 'fresh');
});

test('runnable translation work progresses around a correction waiting for the audio lane', async () => {
  const { context } = loadBackgroundScript();
  const state = context.__testState;
  const order = [];
  const correction = context.enqueueTranslationTask(() => {
    order.push('correction');
    return 'corrected';
  }, {
    segmentId: 'correction',
    sourceRevision: 1,
    ready: false,
  });
  const live = context.enqueueTranslationTask(() => {
    order.push('live');
    return 'live';
  }, {
    segmentId: 'live',
    sourceRevision: 1,
  });

  assert.equal(await live, 'live');
  assert.deepEqual(order, ['live']);
  assert.equal(state.translationQueue.length, 1);
  state.translationQueue[0].ready = true;
  context.runNextTranslationTask();
  assert.equal(await correction, 'corrected');
  assert.deepEqual(order, ['live', 'correction']);
});

test('correction inference holds the serial audio lane until translation completes', async () => {
  let releaseTranslation;
  let markTranslationStarted;
  let transcribeStarted = false;
  const translationStarted = new Promise((resolve) => { markTranslationStarted = resolve; });
  const pendingTranslation = new Promise((resolve) => { releaseTranslation = resolve; });
  const { context } = loadBackgroundScript({
    storageSettings: {
      serverUrl: 'http://localhost:17070',
      apiToken: 'local-test-token',
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/translate')) {
        markTranslationStarted();
        return await pendingTranslation;
      }
      transcribeStarted = true;
      return { ok: true, async json() { return { transcription: 'ASR result' }; } };
    },
  });
  const state = context.__testState;
  const port = {
    postMessage(message) {
      if (message.type !== 'CAPTION_RPC') return;
      const record = message.action === 'correct'
        ? {
            segmentId: 'corrected-segment',
            sessionId: 'session-a',
            streamId: 'tab',
            streamGeneration: 2,
            sourceRevision: 3,
            sourceText: 'corrected source',
            sourceLanguage: 'en',
            translations: [{ targetLanguage: 'ja' }],
          }
        : { segmentId: 'corrected-segment' };
      context.handleOffscreenPortMessage(port, {
        type: 'CAPTION_RPC_RESULT',
        requestId: message.requestId,
        result: { ok: true, record },
      });
    },
  };
  state.offscreenPort = port;

  const correction = context.handleCaptionClientMessage(port, 'private', {
    type: 'CAPTION_ACTION',
    action: 'correct',
    requestId: 'correct-1',
    payload: { segmentId: 'corrected-segment' },
  });
  for (let spin = 0; state.translationQueue.length === 0 && spin < 100; spin += 1) {
    await Promise.resolve();
  }
  assert.equal(state.translationQueue.length, 1);
  await translationStarted;

  const followingAudioTask = context.enqueueAudioTask(async () => {
    await context.transcribeOnly('UklGRg==', {
      serverUrl: 'http://localhost:17070',
      apiToken: 'local-test-token',
      sourceLang: 'en',
      targetLang: 'ja',
      bidirectional: false,
    }, 1_000, {
      vadKind: 'energy',
      speechDetected: true,
      voicedDurationMs: 1_000,
      utteranceDurationMs: 1_200,
      clippingRatio: 0,
    });
  });
  await new Promise((resolve) => setImmediate(resolve));
  const transcribedDuringCorrection = transcribeStarted;
  releaseTranslation({ ok: true, async json() { return { translation: '翻訳済み' }; } });
  await Promise.all([correction, followingAudioTask]);
  assert.equal(transcribedDuringCorrection, false,
    'the next ASR item must wait for correction inference to settle');
  assert.equal(transcribeStarted, true);
});

test('correction translations reserve bounded queue capacity and expire from action time', async () => {
  const apiRequests = [];
  const rpcActions = [];
  const actionResults = [];
  const { context } = loadBackgroundScript({
    storageSettings: {
      serverUrl: 'http://localhost:17070',
      apiToken: 'local-test-token',
      targetLang: 'ja',
    },
    fetchImpl: async (url, options) => {
      apiRequests.push({ url, options });
      return { ok: true, async json() { return { translation: 'translated' }; } };
    },
  });
  const clock = setFakeClock(context, 10_000);
  const state = context.__testState;
  let releaseAudioLane;
  let markAudioLaneStarted;
  const audioLaneStarted = new Promise((resolve) => { markAudioLaneStarted = resolve; });
  const audioLaneBlocker = context.enqueueAudioTask(() => new Promise((resolve) => {
    releaseAudioLane = resolve;
    markAudioLaneStarted();
  }));
  await audioLaneStarted;

  const port = {
    postMessage(message) {
      if (message.type === 'CAPTION_RPC') {
        rpcActions.push(message.action);
        const record = {
          segmentId: message.payload.segmentId,
          sessionId: 'session-a',
          streamId: 'tab',
          streamGeneration: 2,
          sourceRevision: 1,
          sourceText: `source ${message.payload.segmentId}`,
          sourceLanguage: 'en',
          translations: [{ targetLanguage: 'ja' }],
        };
        context.handleOffscreenPortMessage(port, {
          type: 'CAPTION_RPC_RESULT',
          requestId: message.requestId,
          result: message.action === 'correct'
            ? { ok: true, record }
            : { ok: true, record },
        });
      } else if (message.type === 'CAPTION_ACTION_RESULT') {
        actionResults.push(message);
      }
    },
  };
  state.offscreenPort = port;

  const corrections = Array.from({ length: 9 }, (_, index) => context.handleCaptionClientMessage(
    port,
    'private',
    {
      type: 'CAPTION_ACTION',
      action: 'correct',
      requestId: `correction-${index}`,
      payload: { segmentId: `segment-${index}` },
    }
  ));

  for (let spin = 0; (state.translationQueue.length < 8 ||
      rpcActions.filter((action) => action === 'set-translation').length < 1) && spin < 100; spin += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(state.translationQueue.length, 8, 'corrections waiting for the audio lane count toward capacity');
  assert.equal(state.correctionLanePendingCallbacks, 8,
    'serial-lane activation callbacks have an independent hard bound');
  assert.equal(apiRequests.length, 0, 'corrections do not infer before their serial-lane turn');
  assert.equal(rpcActions.filter((action) => action === 'set-translation').length, 1,
    'the ninth correction is failed immediately when the pending limit is full');

  clock.advance(3_001);
  const retryCorrections = Array.from({ length: 8 }, (_, index) => context.handleCaptionClientMessage(
    port,
    'private',
    {
      type: 'CAPTION_ACTION',
      action: 'correct',
      requestId: `correction-retry-${index}`,
      payload: { segmentId: `retry-segment-${index}` },
    }
  ));
  await Promise.all(retryCorrections);
  assert.equal(state.translationQueue.length, 0,
    'new jobs are rejected while expired activation callbacks still occupy the bounded lane backlog');
  assert.equal(state.correctionLanePendingCallbacks, 8);

  releaseAudioLane();
  await audioLaneBlocker;
  await Promise.all(corrections);
  await state.audioQueue;
  assert.equal(state.correctionLanePendingCallbacks, 0,
    'the activation bound is released after the serial lane consumes the callbacks');

  assert.equal(apiRequests.filter(({ url }) => String(url).endsWith('/translate')).length, 0,
    'expired corrections are never dispatched');
  assert.equal(state.translationQueue.length, 0);
  assert.equal(state.translationQueueStatus.code, 'TRANSLATION_OVERLOAD');
  assert.equal(rpcActions.filter((action) => action === 'set-translation').length, 17,
    'all correction records retain their source and receive translation failure state');
  assert.equal(actionResults.length, 17);
  assert.ok(actionResults.every(({ result }) => result.translationFailed === true));
  assert.equal(actionResults.some(({ result }) => result.translationStale === true), false,
    'queue deadline must not be reported as a newer source revision');
});

test('stale live translation is not sent and marks only its translation failed', async () => {
  const requests = [];
  const { context } = loadBackgroundScript({
    storageSettings: { targetLang: 'ja' },
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith('/transcribe')) {
        return {
          ok: true,
          async json() {
            return {
              transcription: 'hello there',
              raw_text: 'hello there',
              detected_language: 'en',
              backend: 'test-double',
              segments: [],
              quality_flags: [],
            };
          },
        };
      }
      return { ok: true, async json() { return { translation: 'こんにちは' }; } };
    },
  });
  const clock = setFakeClock(context, 10_000);
  const state = context.__testState;
  state.isActive = true;
  state.tabId = 7;
  state.sessionId = 'session-a';
  state.streamGenerations = { mic: 0, tab: 2 };

  let releaseBlocker;
  let markBlockerStarted;
  const blockerStarted = new Promise((resolve) => { markBlockerStarted = resolve; });
  const blocker = context.enqueueTranslationTask(() => new Promise((resolve) => {
    releaseBlocker = resolve;
    markBlockerStarted();
  }), { segmentId: 'blocking', sourceRevision: 1 });
  await blockerStarted;

  const rpcMessages = [];
  const port = {
    postMessage(message) {
      if (message.type !== 'CAPTION_RPC') return;
      rpcMessages.push(message);
      const record = message.action === 'upsert-candidate'
        ? { ...message.payload.candidate, revision: 1 }
        : {
            segmentId: message.payload.segmentId,
            sourceRevision: message.payload.sourceRevision,
            translations: [{
              targetLanguage: message.payload.targetLanguage,
              sourceRevision: message.payload.sourceRevision,
              state: message.payload.state,
              text: message.payload.text,
            }],
          };
      context.handleOffscreenPortMessage(port, {
        type: 'CAPTION_RPC_RESULT',
        requestId: message.requestId,
        result: { ok: true, record },
      });
    },
  };
  state.offscreenPort = port;

  const processing = context.processAudioChunk('UklGRg==', null, 7, 900, {
    sessionId: 'session-a',
    streamId: 'tab',
    streamGeneration: 2,
    audioEndedAtMs: clock.now() - 1_000,
    evidence: {
      vadKind: 'energy',
      speechDetected: true,
      voicedDurationMs: 900,
      utteranceDurationMs: 1100,
      clippingRatio: 0,
    },
  });
  for (let attempt = 0; attempt < 20 && state.translationQueue.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(state.translationQueue.length, 1);
  clock.advance(3_001);
  releaseBlocker('released');
  await blocker;
  await processing;

  const candidate = rpcMessages.find((message) => message.action === 'upsert-candidate');
  const failedTranslation = rpcMessages.find((message) => message.action === 'set-translation');
  assert.equal(candidate.payload.candidate.sourceText, 'hello there');
  assert.equal(failedTranslation.payload.state, 'failed');
  assert.equal(failedTranslation.payload.text, null);
  assert.equal(requests.some((url) => url.endsWith('/translate')), false);
  assert.equal(state.translationQueueStatus.code, 'TRANSLATION_STALE');
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

test('speaker batches retain their audio reservation and delayed flushes drop stale audio', async () => {
  let flushBatch;
  const { context } = loadBackgroundScript({
    setTimeoutImpl(callback) {
      flushBatch = callback;
      return 1;
    },
    clearTimeoutImpl() {},
  });
  let now = 1_000;
  context.Date = class TestDate extends Date {
    static now() { return now; }
  };
  const state = context.__testState;
  state.isActive = true;
  state.tabId = 7;
  state.sessionId = 'session-a';
  state.streamGenerations = { mic: 0, tab: 1 };
  context.getActiveSpeaker = async () => 'Test Speaker';
  let processed = 0;
  context.processAudioChunk = async () => { processed += 1; };

  sendAudioData(context, 1_500);
  await state.audioQueue;

  assert.equal(state.audioQueuePendingItems, 1);
  assert.equal(state.audioQueuePendingMs, 1_500);
  assert.equal(state.pendingSpeakerBatches.size, 1);

  now += 5_001;
  assert.equal(typeof flushBatch, 'function');
  flushBatch();
  await state.audioQueue;

  assert.equal(processed, 0);
  assert.equal(state.pendingSpeakerBatches.size, 0);
  assert.equal(state.audioQueuePendingItems, 0);
  assert.equal(state.audioQueuePendingMs, 0);
  assert.equal(state.audioQueueStatus.code, 'STALE');
});

test('speaker batch translation deadline uses the end time of its newest audio chunk', async () => {
  const { context } = loadBackgroundScript({
    setTimeoutImpl() { return 1; },
    clearTimeoutImpl() {},
  });
  const state = context.__testState;
  state.isActive = true;
  state.tabId = 7;
  state.sessionId = 'session-a';
  state.streamGenerations = { mic: 0, tab: 1 };
  context.getActiveSpeaker = async () => 'Test Speaker';

  sendAudioData(context, 1_000, 1_000);
  await state.audioQueue;
  sendAudioData(context, 1_000, 2_250);
  await state.audioQueue;

  const batch = [...state.pendingSpeakerBatches.values()][0];
  assert.equal(batch.audioMetadata.audioEndedAtMs, 2_250);
  context.clearPendingSpeakerBatches();
});

test('speaker-batched audio stays within aggregate item and duration limits', async () => {
  const { context } = loadBackgroundScript();
  const state = context.__testState;
  state.isActive = true;
  state.tabId = 7;
  state.sessionId = 'session-a';
  state.streamGenerations = { mic: 0, tab: 1 };
  context.getActiveSpeaker = async () => 'Test Speaker';

  for (let index = 0; index < 4; index += 1) sendAudioData(context, 2_500);
  await state.audioQueue;
  sendAudioData(context, 100);

  assert.equal(state.audioQueueStatus.code, 'OVERLOAD');
  assert.equal(state.audioQueuePendingItems, 4);
  assert.equal(state.audioQueuePendingMs, 10_000);
  assert.equal([...state.pendingSpeakerBatches.values()][0].chunks.length, 4);

  context.clearPendingSpeakerBatches();
  assert.equal(state.audioQueuePendingItems, 0);
  assert.equal(state.audioQueuePendingMs, 0);
});

test('stopping during a speaker-change flush does not rebuffer the incoming chunk', async () => {
  let releaseInference;
  let markInferenceStarted;
  const inferenceStarted = new Promise((resolve) => { markInferenceStarted = resolve; });
  const blockedInference = new Promise((resolve) => { releaseInference = resolve; });
  const speakerNames = ['Speaker A', 'Speaker B'];
  const { context } = loadBackgroundScript({
    sendMessageImpl() { return { speakerName: speakerNames.shift() }; },
    setTimeoutImpl() { return 1; },
    clearTimeoutImpl() {},
  });
  const state = context.__testState;
  state.isActive = true;
  state.tabId = 7;
  state.sessionId = 'session-a';
  state.activeStreamIds = ['tab'];
  state.streamGenerations = { mic: 0, tab: 1 };
  context.processAudioChunk = () => {
    markInferenceStarted();
    return blockedInference;
  };
  state.offscreenPort = {
    postMessage(message) {
      if (message.type === 'CAPTION_RPC') {
        context.handleOffscreenPortMessage(this, {
          type: 'CAPTION_RPC_RESULT',
          requestId: message.requestId,
          result: { ok: true },
        });
      }
    },
  };

  sendAudioData(context, 1_000);
  await state.audioQueue;
  sendAudioData(context, 1_000);
  await inferenceStarted;

  const stopping = context.stopCapture();
  assert.equal(state.isActive, false);
  assert.equal(state.sessionId, null);
  releaseInference();
  await stopping;

  assert.equal(state.pendingSpeakerBatches.size, 0);
  assert.equal(state.audioQueuePendingItems, 0);
  assert.equal(state.audioQueuePendingMs, 0);
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

function loadBackgroundScript({ fetchImpl, storageSettings = {}, setTimeoutImpl, clearTimeoutImpl, sendMessageImpl } = {}) {
  const listeners = {
    onMessage: null,
  };
  let storageAccessLevel = null;
  const tabMessages = [];

  const chrome = {
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
        return Promise.resolve(sendMessageImpl ? sendMessageImpl(message) : { success: true });
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

test('translateOnly sends revision identity without adding transcript data to logs', async () => {
  const requests = [];
  const logs = [];
  const { context } = loadBackgroundScript({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, async json() { return { translation: 'こんにちは' }; } };
    },
  });
  context.console.info = (...args) => logs.push(args.join(' '));

  await context.translateOnly('translation input', 'en', 'ja', {
    serverUrl: 'http://localhost:17070',
    apiToken: 'local-test-token',
  }, {
    sessionId: 'session-a',
    streamId: 'tab',
    streamGeneration: 4,
    segmentId: 'segment-a',
    sourceRevision: 2,
    sourceText: 'original reviewed source',
  });

  const body = new URLSearchParams(requests[0].options.body);
  assert.equal(body.get('session_id'), 'session-a');
  assert.equal(body.get('audio_source'), 'tab');
  assert.equal(body.get('stream_generation'), '4');
  assert.equal(body.get('segment_id'), 'segment-a');
  assert.equal(body.get('source_revision'), '2');
  assert.equal(body.get('source_text'), 'original reviewed source');
  assert.equal(logs.join(' ').includes('original reviewed source'), false);
  assert.equal(logs.join(' ').includes('translation input'), false);
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
