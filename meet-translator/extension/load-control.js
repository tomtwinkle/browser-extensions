'use strict';

(function exposeLoadControl(root) {
  const SLOW_WAIT_MS = 2_000;
  const SLOW_WAIT_COUNT = 3;
  const SAMPLE_INTERVAL_MIN_MS = 900;
  const SAMPLE_INTERVAL_MAX_MS = 1_500;
  const PAUSE_AFTER_DIAGNOSTICS_MS = 10_000;
  const MEMORY_LIMIT_GIB = 10;
  const MEMORY_LIMIT_SAMPLES = 2;
  const CRITICAL_ASR_STOP_MS = 5_000;
  const NORMAL_RECOVERY_MS = 30_000;
  const ASR_RESUME_WAIT_MS = 500;

  function hasExpectedSampleSpacing(nowMs, lastSampleAtMs) {
    if (lastSampleAtMs === null) return false;
    const elapsedMs = nowMs - lastSampleAtMs;
    return elapsedMs >= SAMPLE_INTERVAL_MIN_MS && elapsedMs <= SAMPLE_INTERVAL_MAX_MS;
  }

  function createAdaptiveLoadController() {
    let consecutiveSlowWaits = 0;
    let experimentsStoppedAtMs = null;
    let queueWaitSamples = [];
    let memoryOverLimitSamples = [];
    let inferenceBlocked = false;
    let releaseIssued = false;
    let criticalSinceMs = null;
    let asrStopped = false;
    let translationsPaused = false;
    let lastSampleAtMs = null;
    let normalSinceMs = null;
    let resumeEligible = false;

    function snapshot(transition = null, effects = {}) {
      return {
        transition,
        experimentsStopped: experimentsStoppedAtMs !== null,
        experimentsStoppedAtMs,
        consecutiveSlowWaits,
        translationsPaused,
        inferenceBlocked,
        releaseTranslationModel: effects.releaseTranslationModel === true,
        stopAsr: asrStopped,
        resumeEligible,
        requeueOldTranslations: false,
      };
    }

    function observeQueueWait(queueWaitMs, nowMs) {
      if (!Number.isFinite(queueWaitMs) || queueWaitMs <= SLOW_WAIT_MS) {
        consecutiveSlowWaits = 0;
        return snapshot();
      }
      consecutiveSlowWaits += 1;
      if (consecutiveSlowWaits >= SLOW_WAIT_COUNT && experimentsStoppedAtMs === null) {
        experimentsStoppedAtMs = nowMs;
        return snapshot('stop_experiments_and_diagnostics');
      }
      return snapshot();
    }

    function sample({ nowMs, queueWaitMs = 0, asrQueueWaitMs = 0, memoryPressure = 'unknown', processGroupMemoryGiB = null } = {}) {
      if (!Number.isFinite(nowMs)) return snapshot();
      let transition = null;
      let releaseTranslationModel = false;
      const wasResumeEligible = resumeEligible;
      const sequentialSample = hasExpectedSampleSpacing(nowMs, lastSampleAtMs);
      lastSampleAtMs = nowMs;

      if (!sequentialSample) queueWaitSamples = [];
      queueWaitSamples.push({ atMs: nowMs, waitMs: Number.isFinite(queueWaitMs) ? Math.max(0, queueWaitMs) : 0 });
      queueWaitSamples = queueWaitSamples.slice(-3);
      const threeConsecutiveSlowSamples = queueWaitSamples.length === 3 &&
        queueWaitSamples.every((sampled) => sampled.waitMs > SLOW_WAIT_MS);
      if (!translationsPaused && experimentsStoppedAtMs !== null &&
          nowMs - experimentsStoppedAtMs >= PAUSE_AFTER_DIAGNOSTICS_MS && threeConsecutiveSlowSamples) {
        translationsPaused = true;
        transition = 'pause_translation_admission';
      }

      const highMemory = Number.isFinite(processGroupMemoryGiB) && processGroupMemoryGiB > MEMORY_LIMIT_GIB;
      if (highMemory && sequentialSample) {
        memoryOverLimitSamples.push(nowMs);
      } else if (highMemory) {
        memoryOverLimitSamples = [nowMs];
      } else {
        memoryOverLimitSamples = [];
      }
      memoryOverLimitSamples = memoryOverLimitSamples.slice(-MEMORY_LIMIT_SAMPLES);
      const repeatedHighMemory = memoryOverLimitSamples.length === MEMORY_LIMIT_SAMPLES;
      const criticalPressure = memoryPressure === 'critical';
      const memoryLimitReached = criticalPressure || repeatedHighMemory;

      if (memoryLimitReached) {
        if (criticalSinceMs === null) criticalSinceMs = nowMs;
        if (!inferenceBlocked) {
          inferenceBlocked = true;
          releaseTranslationModel = !releaseIssued;
          releaseIssued = true;
          translationsPaused = true;
          transition = transition || (criticalPressure ? 'critical_memory_pressure' : 'process_group_memory_limit');
        }
        if (!asrStopped && nowMs - criticalSinceMs >= CRITICAL_ASR_STOP_MS) {
          asrStopped = true;
          transition = transition || 'stop_asr_after_critical_pressure';
        }
      } else {
        criticalSinceMs = null;
      }

      const memoryNormal = memoryPressure === 'normal' && !highMemory;
      if (memoryNormal) {
        if (normalSinceMs === null || !sequentialSample) normalSinceMs = nowMs;
      } else {
        normalSinceMs = null;
      }
      resumeEligible = translationsPaused && memoryNormal && normalSinceMs !== null &&
        nowMs - normalSinceMs >= NORMAL_RECOVERY_MS &&
        Number.isFinite(asrQueueWaitMs) && asrQueueWaitMs < ASR_RESUME_WAIT_MS;
      if (!wasResumeEligible && resumeEligible && !transition) transition = 'memory_recovery_ready';

      return snapshot(transition, { releaseTranslationModel });
    }

    function resumeByUserAction() {
      if (!resumeEligible) return { ...snapshot(), resumed: false };
      translationsPaused = false;
      inferenceBlocked = false;
      asrStopped = false;
      criticalSinceMs = null;
      releaseIssued = false;
      resumeEligible = false;
      return { ...snapshot('user_resume'), resumed: true };
    }

    return Object.freeze({ observeQueueWait, resumeByUserAction, sample, snapshot: () => snapshot() });
  }

  root.MeetTranslatorLoadControl = Object.freeze({ createAdaptiveLoadController });
})(globalThis);
