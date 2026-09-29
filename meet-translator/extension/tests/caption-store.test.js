'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaptionStore } = require('../caption-store.js');

function candidate(overrides = {}) {
  return {
    sessionId: 'session-a',
    streamId: 'tab',
    streamGeneration: 2,
    segmentId: 'segment-a',
    startMs: 100,
    endMs: 700,
    rawText: 'Do not ship it.',
    sourceText: 'Do not ship it.',
    sourceLanguage: 'en',
    decision: 'uncertain',
    reasonCodes: ['INSUFFICIENT_EVIDENCE'],
    translations: [{ targetLanguage: 'ja', sourceRevision: 1, state: 'pending', text: null }],
    ...overrides,
  };
}

test('private candidates never enter the public snapshot until explicit approval', () => {
  const publicEvents = [];
  const store = createCaptionStore({ onPublicEvent: (event) => publicEvents.push(event) });
  store.beginSession('session-a', { mic: 0, tab: 2 });
  store.upsertCandidate(candidate());

  assert.deepEqual(store.publicSnapshot().records, []);
  assert.equal(store.privateSnapshot().records.length, 1);
  assert.equal(publicEvents.length, 0);

  assert.equal(store.approve('segment-a').ok, true);
  assert.equal(store.publicSnapshot().records[0].sourceText, 'Do not ship it.');
  assert.equal(publicEvents.at(-1).type, 'upsert');
});

test('empty ASR output with positive speech evidence stays private and needs correction', () => {
  const store = createCaptionStore();
  store.beginSession('session-a', { mic: 0, tab: 2 });
  const result = store.upsertCandidate(candidate({
    rawText: '',
    sourceText: '',
    reasonCodes: ['INSUFFICIENT_EVIDENCE', 'EMPTY_WITH_SPEECH'],
    evidence: { speechDetected: true, voicedDurationMs: 320 },
    translations: [],
  }));

  assert.equal(result.ok, true);
  assert.equal(store.privateSnapshot().records[0].sourceText, '');
  assert.equal(store.publicSnapshot().records.length, 0);
  assert.deepEqual(store.approve('segment-a'), { ok: false, reason: 'empty-source' });
  assert.equal(store.correct('segment-a', 'I disagree.').ok, true);
  assert.equal(store.approve('segment-a').ok, true);
  assert.equal(store.publicSnapshot().records[0].sourceText, 'I disagree.');
});

test('a corrected source invalidates the old translation and stale translation results', () => {
  const store = createCaptionStore();
  store.beginSession('session-a', { mic: 0, tab: 2 });
  store.upsertCandidate(candidate({
    translations: [{ targetLanguage: 'ja', sourceRevision: 1, state: 'ready', text: '出荷しないでください。' }],
  }));
  store.approve('segment-a');

  const revised = store.correct('segment-a', 'Do not ship this package.', { expectedRevision: 2 });
  assert.equal(revised.ok, true);
  assert.equal(revised.record.sourceRevision, 2);
  assert.equal(revised.record.rawText, 'Do not ship it.');
  assert.equal(revised.record.translations[0].state, 'pending');
  assert.equal(store.publicSnapshot().records.length, 0);
  assert.equal(store.setTranslation('segment-a', 1, 'ja', '古い訳').ok, false);

  assert.equal(store.approve('segment-a').ok, true);
  assert.equal(store.publicSnapshot().records[0].translations[0].text, null);
});

test('undo restores the prior approved text without reusing a stale revision', () => {
  const store = createCaptionStore();
  store.beginSession('session-a', { mic: 0, tab: 2 });
  store.upsertCandidate(candidate({
    translations: [{ targetLanguage: 'ja', sourceRevision: 1, state: 'ready', text: '出荷しないでください。' }],
  }));
  store.approve('segment-a');
  store.correct('segment-a', 'Do not ship this package.', { expectedRevision: 2 });

  const undone = store.undo('segment-a');
  assert.equal(undone.ok, true);
  assert.equal(undone.record.sourceText, 'Do not ship it.');
  assert.equal(undone.record.sourceRevision, 3);
  assert.equal(undone.record.translations[0].sourceRevision, 3);
  assert.equal(store.publicSnapshot().records[0].sourceText, 'Do not ship it.');
});

test('microphone captions stay private by default and re-enabling does not publish old records', () => {
  const store = createCaptionStore();
  store.beginSession('session-a', { mic: 3, tab: 0 });
  store.upsertCandidate(candidate({ streamId: 'mic', streamGeneration: 3 }));
  store.approve('segment-a');

  assert.deepEqual(store.publicSnapshot().records, []);
  store.setMicPublication(true);
  assert.deepEqual(store.publicSnapshot().records, []);
  assert.equal(store.approve('segment-a').ok, true);
  assert.equal(store.publicSnapshot().records.length, 1);
});

test('stale sessions and stream generations cannot update the current store', () => {
  const store = createCaptionStore();
  store.beginSession('session-a', { mic: 0, tab: 2 });
  assert.equal(store.upsertCandidate(candidate({ sessionId: 'session-old' })).ok, false);
  assert.equal(store.upsertCandidate(candidate({ streamGeneration: 1 })).ok, false);
  store.endSession('session-a');
  assert.deepEqual(store.publicSnapshot().records, []);
  assert.equal(store.upsertCandidate(candidate()).ok, false);
});

test('private candidate and translation text respect the public protocol text bound', () => {
  const store = createCaptionStore();
  store.beginSession('session-a', { mic: 0, tab: 2 });
  assert.equal(store.upsertCandidate(candidate({ rawText: 'x'.repeat(8193) })).ok, false);
  assert.equal(store.upsertCandidate(candidate({ sourceText: 'x'.repeat(8193) })).ok, false);
  assert.equal(store.upsertCandidate(candidate()).ok, true);
  assert.equal(store.setTranslation('segment-a', 1, 'ja', '訳'.repeat(8193)).ok, false);
});

test('caption state prunes oldest records before exceeding its serialized storage budget', () => {
  let now = 0;
  const store = createCaptionStore({ now: () => ++now, maxSerializedBytes: 10_000 });
  store.beginSession('session-a', { mic: 0, tab: 2 });
  for (let index = 0; index < 12; index += 1) {
    const id = `segment-${index}`;
    store.upsertCandidate(candidate({
      segmentId: id,
      rawText: 'r'.repeat(2048),
      sourceText: 's'.repeat(2048),
      translations: [{ targetLanguage: 'ja', sourceRevision: 1, state: 'ready', text: 't'.repeat(2048) }],
    }));
  }

  const state = store.state();
  assert.ok(Buffer.byteLength(JSON.stringify(state), 'utf8') <= 10_000);
  assert.ok(state.records.length < 12);
  assert.equal(state.records.some((record) => record.segmentId === 'segment-11'), true);
});

test('ended meeting history remains correctable and cannot be republished', () => {
  const events = [];
  const store = createCaptionStore({ onPublicEvent: (event) => events.push(event) });
  store.beginSession('session-a', { mic: 0, tab: 2 });
  store.upsertCandidate(candidate());
  store.approve('segment-a');
  assert.equal(store.endSession('session-a').ok, true);

  const corrected = store.correct('segment-a', 'Do not dispatch it.', { expectedRevision: 3 });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.record.sourceRevision, 2);
  assert.equal(store.setTranslation('segment-a', 2, 'ja', '出荷しないでください。', 'ready', { allowHistorical: true }).ok, true);
  const approved = store.approve('segment-a');
  assert.equal(approved.ok, true);
  assert.equal(approved.record.published, false);
  assert.deepEqual(store.publicSnapshot().records, []);
  assert.equal(events.slice(3).some((event) => event.type === 'upsert'), false);
});
