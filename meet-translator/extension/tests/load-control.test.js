'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'load-control.js'), 'utf8');

function loadLoadControl() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'load-control.js' });
  return context.MeetTranslatorLoadControl;
}

test('adaptive control stops experimental work after three consecutive waits strictly over two seconds', () => {
  const api = loadLoadControl();
  const control = api.createAdaptiveLoadController();
  assert.equal(control.observeQueueWait(2_000, 1_000).experimentsStopped, false);
  assert.equal(control.observeQueueWait(2_001, 2_000).experimentsStopped, false);
  assert.equal(control.observeQueueWait(2_000, 3_000).consecutiveSlowWaits, 0);
  assert.equal(control.observeQueueWait(2_001, 4_000).experimentsStopped, false);
  assert.equal(control.observeQueueWait(2_001, 5_000).experimentsStopped, false);
  const stopped = control.observeQueueWait(2_001, 6_000);
  assert.equal(stopped.experimentsStopped, true);
  assert.equal(stopped.transition, 'stop_experiments_and_diagnostics');
});

test('translation pause requires ten seconds after diagnostics stop and three one-second slow samples', () => {
  const api = loadLoadControl();
  const control = api.createAdaptiveLoadController();
  for (let i = 1; i <= 3; i += 1) control.observeQueueWait(2_001, i * 1_000);

  assert.equal(control.sample({ nowMs: 15_999, queueWaitMs: 2_100, asrQueueWaitMs: 2_100 }).translationsPaused, false);
  assert.equal(control.sample({ nowMs: 16_000, queueWaitMs: 2_100, asrQueueWaitMs: 2_100 }).translationsPaused, false);
  assert.equal(control.sample({ nowMs: 17_000, queueWaitMs: 2_100, asrQueueWaitMs: 2_100 }).translationsPaused, false);
  const paused = control.sample({ nowMs: 18_000, queueWaitMs: 2_100, asrQueueWaitMs: 2_100 });
  assert.equal(paused.translationsPaused, true);
  assert.equal(paused.transition, 'pause_translation_admission');
  assert.equal(paused.requeueOldTranslations, false);
});

test('adaptive sample sequences tolerate normal timer jitter for pause, memory protection, and recovery', () => {
  const api = loadLoadControl();
  const pause = api.createAdaptiveLoadController();
  for (let i = 1; i <= 3; i += 1) pause.observeQueueWait(2_001, i * 1_000);
  pause.sample({ nowMs: 13_000, queueWaitMs: 2_100 });
  pause.sample({ nowMs: 14_001, queueWaitMs: 2_100 });
  const paused = pause.sample({ nowMs: 15_401, queueWaitMs: 2_100 });
  assert.equal(paused.translationsPaused, true, '1001 ms and 1400 ms intervals are consecutive samples');

  for (const intervalMs of [1_001, 1_400]) {
    const memory = api.createAdaptiveLoadController();
    memory.sample({ nowMs: 0, processGroupMemoryGiB: 10.1, memoryPressure: 'normal' });
    const blocked = memory.sample({ nowMs: intervalMs, processGroupMemoryGiB: 10.1, memoryPressure: 'normal' });
    assert.equal(blocked.inferenceBlocked, true, `${intervalMs} ms high-memory samples trigger protection`);
  }

  const recovery = api.createAdaptiveLoadController();
  recovery.sample({ nowMs: 0, memoryPressure: 'critical', asrQueueWaitMs: 0 });
  let nowMs = 5_000;
  recovery.sample({ nowMs, memoryPressure: 'normal', asrQueueWaitMs: 499 });
  for (let index = 0; index < 13; index += 1) {
    nowMs += 1_001;
    recovery.sample({ nowMs, memoryPressure: 'normal', asrQueueWaitMs: 499 });
    nowMs += 1_400;
    recovery.sample({ nowMs, memoryPressure: 'normal', asrQueueWaitMs: 499 });
  }
  assert.equal(nowMs - 5_000 >= 30_000, true);
  assert.equal(recovery.snapshot().resumeEligible, true, 'normal recovery time accumulates across timer jitter');
});

test('memory protection only counts samples spaced 900 to 1500 ms apart', () => {
  const api = loadLoadControl();
  for (const { intervalMs, expectedBlocked } of [
    { intervalMs: 500, expectedBlocked: false },
    { intervalMs: 899, expectedBlocked: false },
    { intervalMs: 900, expectedBlocked: true },
    { intervalMs: 1_500, expectedBlocked: true },
    { intervalMs: 1_501, expectedBlocked: false },
  ]) {
    const control = api.createAdaptiveLoadController();
    control.sample({ nowMs: 0, processGroupMemoryGiB: 10.1, memoryPressure: 'normal' });
    const result = control.sample({ nowMs: intervalMs, processGroupMemoryGiB: 10.1, memoryPressure: 'normal' });
    assert.equal(result.inferenceBlocked, expectedBlocked, `${intervalMs} ms spacing`);
  }
});

test('sample gaps over 1500 ms reset pause, memory, and recovery sequences', () => {
  const api = loadLoadControl();
  const pause = api.createAdaptiveLoadController();
  for (let i = 1; i <= 3; i += 1) pause.observeQueueWait(2_001, i * 1_000);
  pause.sample({ nowMs: 13_000, queueWaitMs: 2_100 });
  pause.sample({ nowMs: 14_501, queueWaitMs: 2_100 });
  assert.equal(pause.snapshot().translationsPaused, false, '1501 ms gap resets the three-sample window');
  pause.sample({ nowMs: 15_501, queueWaitMs: 2_100 });
  assert.equal(pause.snapshot().translationsPaused, false);
  assert.equal(pause.sample({ nowMs: 16_501, queueWaitMs: 2_100 }).translationsPaused, true);

  const memory = api.createAdaptiveLoadController();
  memory.sample({ nowMs: 0, processGroupMemoryGiB: 10.1, memoryPressure: 'normal' });
  assert.equal(memory.sample({ nowMs: 1_501, processGroupMemoryGiB: 10.1, memoryPressure: 'normal' }).inferenceBlocked, false);
  assert.equal(memory.sample({ nowMs: 2_501, processGroupMemoryGiB: 10.1, memoryPressure: 'normal' }).inferenceBlocked, true);

  const recovery = api.createAdaptiveLoadController();
  recovery.sample({ nowMs: 0, memoryPressure: 'critical', asrQueueWaitMs: 0 });
  recovery.sample({ nowMs: 5_000, memoryPressure: 'normal', asrQueueWaitMs: 499 });
  assert.equal(recovery.sample({ nowMs: 6_501, memoryPressure: 'normal', asrQueueWaitMs: 499 }).resumeEligible, false);
  assert.equal(recovery.sample({ nowMs: 35_000, memoryPressure: 'normal', asrQueueWaitMs: 499 }).resumeEligible, false,
    'recovery timer restarts after an invalid sample gap');
  let nowMs = 35_000;
  for (let index = 0; index < 20; index += 1) {
    nowMs += 1_500;
    recovery.sample({ nowMs, memoryPressure: 'normal', asrQueueWaitMs: 499 });
  }
  assert.equal(nowMs, 65_000);
  assert.equal(recovery.snapshot().resumeEligible, true);
});

test('memory protection triggers above ten GiB on two one-second samples or immediately at critical pressure', () => {
  const api = loadLoadControl();
  const high = api.createAdaptiveLoadController();
  assert.equal(high.sample({ nowMs: 1_000, processGroupMemoryGiB: 10, memoryPressure: 'normal' }).inferenceBlocked, false);
  assert.equal(high.sample({ nowMs: 2_000, processGroupMemoryGiB: 10.1, memoryPressure: 'normal' }).inferenceBlocked, false);
  const blocked = high.sample({ nowMs: 3_000, processGroupMemoryGiB: 10.2, memoryPressure: 'normal' });
  assert.equal(blocked.inferenceBlocked, true);
  assert.equal(blocked.releaseTranslationModel, true);
  assert.equal(blocked.stopAsr, false);

  const critical = api.createAdaptiveLoadController();
  const immediate = critical.sample({ nowMs: 5_000, memoryPressure: 'critical', asrQueueWaitMs: 0 });
  assert.equal(immediate.inferenceBlocked, true);
  assert.equal(immediate.releaseTranslationModel, true);
  assert.equal(immediate.stopAsr, false);
  assert.equal(critical.sample({ nowMs: 9_999, memoryPressure: 'critical', asrQueueWaitMs: 0 }).stopAsr, false);
  assert.equal(critical.sample({ nowMs: 10_000, memoryPressure: 'critical', asrQueueWaitMs: 0 }).stopAsr, true);
});

test('recovery needs thirty seconds of normal pressure, ASR wait under 500 ms, and explicit user action', () => {
  const api = loadLoadControl();
  const control = api.createAdaptiveLoadController();
  control.sample({ nowMs: 0, memoryPressure: 'critical', asrQueueWaitMs: 0 });
  control.sample({ nowMs: 5_000, memoryPressure: 'normal', asrQueueWaitMs: 499 });
  for (let nowMs = 6_000; nowMs < 35_000; nowMs += 1_000) {
    assert.equal(control.sample({ nowMs, memoryPressure: 'normal', asrQueueWaitMs: 499 }).resumeEligible, false);
  }
  const eligible = control.sample({ nowMs: 35_000, memoryPressure: 'normal', asrQueueWaitMs: 499 });
  assert.equal(eligible.resumeEligible, true);
  assert.equal(eligible.inferenceBlocked, true, 'normal pressure alone never auto-resumes inference');
  const resumed = control.resumeByUserAction(35_001);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.inferenceBlocked, false);
  assert.equal(resumed.translationsPaused, false);
  assert.equal(resumed.requeueOldTranslations, false);
  assert.equal(control.resumeByUserAction(35_002).resumed, false);
});
