'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'evaluation-telemetry.js'),
  'utf8'
);

function loadTelemetry() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'evaluation-telemetry.js' });
  return context.MeetTranslatorEvaluationTelemetry;
}

test('evaluation telemetry keeps lifecycle timings and queue measurements separate', () => {
  const telemetry = loadTelemetry();
  let now = 10_000;
  const store = telemetry.createEvaluationTelemetry({ now: () => now, idFactory: () => 'run-1' });
  store.beginRun({ sessionId: 'session-1', observedConfigId: 'cfg-1', configCoverage: 'partial' });
  store.record('audio_enqueued', {
    caseId: 'case-1', sessionId: 'session-1', streamId: 'tab', streamGeneration: 4,
    observedConfigId: 'cfg-1', configCoverage: 'partial', queueName: 'audio', queueLength: 2, audioEndedAtMs: 9_800,
  });
  now = 10_100;
  store.record('asr_started', { caseId: 'case-1', sessionId: 'session-1', streamGeneration: 4, observedConfigId: 'cfg-1', queueWaitMs: 100 });
  now = 10_400;
  store.record('candidate_generated', { caseId: 'case-1', sessionId: 'session-1', streamGeneration: 4 });
  now = 11_900;
  store.record('approval_requested', { caseId: 'case-1', sessionId: 'session-1', streamGeneration: 4 });
  now = 12_050;
  store.record('caption_publication_event', { caseId: 'case-1', sessionId: 'session-1', streamGeneration: 4 });

  assert.equal(JSON.stringify(store.caseTimings()), JSON.stringify([{
    caseId: 'case-1',
    audioToCandidateMs: 600,
    humanApprovalWaitMs: 1_500,
    approvalToPublicationEventMs: 150,
  }]));
  assert.equal(store.snapshot().events.find((event) => event.type === 'asr_started').queueWaitMs, 100);
});

test('evaluation telemetry drops text, audio, credentials, URLs, and unknown event fields', () => {
  const telemetry = loadTelemetry();
  const store = telemetry.createEvaluationTelemetry({ now: () => 50, idFactory: () => 'run-privacy' });
  store.beginRun({ sessionId: 'session-1', observedConfigId: 'cfg-1', configCoverage: 'partial' });
  store.record('backend_error', {
    caseId: 'case-1', errorClass: 'TypeError', errorMessage: 'private transcript must not be stored',
    sourceText: '秘密の文字起こし', wavB64: 'UklGRg==', apiToken: 'secret-token',
    serverUrl: 'http://localhost/private', privatePayload: { sourceText: 'nested secret' },
  });

  const serialized = JSON.stringify(store.snapshot());
  for (const secret of ['private transcript', '秘密の文字起こし', 'UklGRg==', 'secret-token', 'localhost/private', 'nested secret']) {
    assert.equal(serialized.includes(secret), false, `telemetry must not retain ${secret}`);
  }
  assert.deepEqual(Object.keys(store.snapshot().events.at(-1)).sort(), [
    'atMs', 'caseId', 'errorClass', 'runId', 'sequence', 'type',
  ]);
});

test('evaluation telemetry is bounded and reports omitted metadata events', () => {
  const telemetry = loadTelemetry();
  let now = 0;
  const store = telemetry.createEvaluationTelemetry({ now: () => now++, idFactory: () => 'run-bounded', maxEvents: 3 });
  store.beginRun({ sessionId: 'session-1', observedConfigId: 'cfg-1', configCoverage: 'partial' });
  store.record('audio_enqueued', { caseId: 'case-1' });
  store.record('asr_started', { caseId: 'case-1' });
  store.record('asr_finished', { caseId: 'case-1', executionMs: 20 });
  store.record('candidate_generated', { caseId: 'case-1' });

  const snapshot = store.snapshot();
  assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.droppedEventCount, 2);
  assert.deepEqual(Array.from(snapshot.events, (event) => event.sequence), [3, 4, 5]);
});

test('evaluation configuration ID changes with inference settings but ignores local credentials', () => {
  const telemetry = loadTelemetry();
  const base = {
    asrModel: 'baseline-asr', translationModel: 'baseline-mt', sourceLang: 'ja', targetLang: 'en',
    runtimeRevision: 'abc123', templateId: 'mt-template-v1', decodeOptions: { temperature: 0 },
    apiToken: 'first-secret', serverUrl: 'http://localhost:17070',
  };
  const first = telemetry.configurationId(base);
  assert.equal(telemetry.configurationId({ ...base, apiToken: 'other-secret', serverUrl: 'http://127.0.0.1:9999' }), first);
  assert.notEqual(telemetry.configurationId({ ...base, templateId: 'mt-template-v2' }), first);
});

test('evaluation telemetry restores and persists metadata events in session storage', async () => {
  const telemetry = loadTelemetry();
  const saved = new Map();
  const storage = {
    async get(key) {
      if (key === null) return Object.fromEntries(saved);
      return { [key]: saved.get(key) };
    },
    async set(values) { for (const [key, value] of Object.entries(values)) saved.set(key, value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) saved.delete(key); },
  };
  const first = telemetry.createEvaluationTelemetry({ now: () => 7, idFactory: () => 'run-storage', storage });
  first.beginRun({ sessionId: 'session-1', observedConfigId: 'cfg-1', configCoverage: 'partial' });
  first.record('audio_enqueued', { caseId: 'case-1', queueName: 'audio', queueLength: 1 });
  await first.flush();

  const restored = telemetry.createEvaluationTelemetry({ now: () => 8, storage });
  await restored.restore();
  assert.deepEqual(restored.snapshot(), first.snapshot());
});
