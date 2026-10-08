'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublicEvent, projectPublicRecord, applyPublicEvent } = require('../caption-protocol.js');

test('public projection contains only approved caption fields and excludes private data', () => {
  const projected = projectPublicRecord({
    sessionId: 'session-a',
    streamId: 'tab',
    streamGeneration: 1,
    segmentId: 'segment-a',
    revision: 4,
    sourceRevision: 2,
    rawText: 'private raw text',
    sourceText: 'Public source',
    decision: 'accepted',
    publishEligible: true,
    published: true,
    userApproved: true,
    speakerName: 'Private name',
    meetingUrl: 'https://meet.google.com/private',
    diagnostics: { token: 'private-token' },
    translations: [
      { targetLanguage: 'ja', sourceRevision: 1, state: 'ready', text: 'old translation' },
      { targetLanguage: 'ja', sourceRevision: 2, state: 'ready', text: '公開訳' },
    ],
  });

  assert.deepEqual(projected, {
    segmentId: 'segment-a',
    revision: 4,
    sourceRevision: 2,
    streamId: 'tab',
    sourceText: 'Public source',
    translations: [{ targetLanguage: 'ja', state: 'ready', text: '公開訳' }],
    decision: 'accepted',
  });
  assert.equal(JSON.stringify(projected).includes('private'), false);
});

test('unapproved records and microphone records without permission have no public projection', () => {
  const base = { segmentId: 's', revision: 1, sourceRevision: 1, streamId: 'tab', sourceText: 'text', translations: [], decision: 'uncertain', publishEligible: false, published: false };
  assert.equal(projectPublicRecord(base), null);
  assert.equal(projectPublicRecord({ ...base, streamId: 'mic', decision: 'accepted', publishEligible: true, published: true }), null);
});

test('public projection never exposes the private translation-paused state', () => {
  const projected = projectPublicRecord({
    segmentId: 'segment-private-state', revision: 2, sourceRevision: 1, streamId: 'tab',
    sourceText: 'Public source', decision: 'accepted', publishEligible: true, published: true,
    translations: [{ targetLanguage: 'ja', sourceRevision: 1, state: 'paused', text: null }],
  });
  assert.deepEqual(projected.translations, []);
  assert.doesNotMatch(JSON.stringify(projected), /paused/i);
});

test('public event reducer ignores duplicate or old sequence numbers and other sessions', () => {
  const state = { sessionId: 'session-a', lastSeq: 0, records: new Map(), ended: false };
  const first = createPublicEvent('upsert', 'session-a', 1, { record: {
    segmentId: 'segment-a', revision: 1, sourceRevision: 1, streamId: 'tab', sourceText: 'hello', translations: [], decision: 'accepted',
  } });
  assert.equal(applyPublicEvent(state, first), true);
  assert.equal(applyPublicEvent(state, first), false);
  assert.equal(applyPublicEvent(state, { ...first, sessionId: 'session-b', sessionSeq: 2 }), false);
  assert.equal(state.records.get('segment-a').sourceText, 'hello');
});

test('public event constructor rejects oversized and malformed events', () => {
  assert.throws(() => createPublicEvent('upsert', 'session-a', 1, { record: { segmentId: 'x' } }), /invalid/);
  assert.throws(() => createPublicEvent('upsert', 'session-a', 1, { record: {
    segmentId: 'x', revision: 1, sourceRevision: 1, streamId: 'tab', sourceText: 'x', decision: 'accepted',
    translations: Array.from({ length: 9 }, (_, index) => ({ targetLanguage: `lang-${index}`, state: 'ready', text: 'x'.repeat(8_000) })),
  } }), /64 KiB/);
});
