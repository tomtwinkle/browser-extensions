'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnergyVad } = require('../offscreen-vad.js');

const sampleRate = 48_000;
const frameLength = 4_096;
const silence = () => new Float32Array(frameLength);
const speech = () => new Float32Array(frameLength).fill(0.08);

function feed(vad, frame, count) {
  for (let i = 0; i < count; i += 1) vad.process(frame(), sampleRate);
}

test('tab and microphone VAD pipelines retain separate speech state', () => {
  const captured = [];
  const tabVad = createEnergyVad({ streamId: 'tab', onUtterance: (item) => captured.push(item) });
  const micVad = createEnergyVad({ streamId: 'mic', onUtterance: (item) => captured.push(item) });

  feed(tabVad, silence, 18);
  feed(micVad, speech, 8);
  feed(tabVad, silence, 12);
  feed(micVad, silence, 18);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].streamId, 'mic');
  assert.ok(Number.isFinite(captured[0].audioEndedAtMs));
  assert.ok(captured[0].speechMs >= 500);
  assert.ok(captured[0].samples.length > 0);
});

test('overlapping tab and microphone speech flush as separate utterances', () => {
  const captured = [];
  const tabVad = createEnergyVad({ streamId: 'tab', onUtterance: (item) => captured.push(item) });
  const micVad = createEnergyVad({ streamId: 'mic', onUtterance: (item) => captured.push(item) });

  for (let i = 0; i < 8; i += 1) {
    tabVad.process(speech(), sampleRate);
    micVad.process(speech(), sampleRate);
  }
  feed(tabVad, silence, 18);
  feed(micVad, silence, 18);

  assert.deepEqual(captured.map((item) => item.streamId).sort(), ['mic', 'tab']);
  assert.notEqual(captured[0].samples, captured[1].samples);
});

test('preserves a short voiced phrase below the former 500 ms cutoff', () => {
  const captured = [];
  const vad = createEnergyVad({ streamId: 'mic', onUtterance: (item) => captured.push(item) });

  feed(vad, speech, 4);
  feed(vad, silence, 18);

  assert.equal(captured.length, 1);
  assert.ok(captured[0].speechMs < 500);
  assert.equal(captured[0].evidence.speechDetected, true);
});
