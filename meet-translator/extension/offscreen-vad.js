'use strict';

(function exposeEnergyVad(root) {
  const RMS_EMA_ALPHA = 0.5;
  const SPEECH_RMS_THRESHOLD = 3e-3;
  const SILENCE_RMS_THRESHOLD = 8e-4;
  const NOISE_FLOOR_RISE_ALPHA = 0.05;
  const NOISE_FLOOR_FALL_ALPHA = 0.01;
  const NOISE_FLOOR_UPDATE_GATE = 0.75;
  const MIN_NOISE_FLOOR_RMS = 1e-4;
  const SPEECH_TO_NOISE_RATIO = 1.8;
  const SPEECH_TO_NOISE_MARGIN = 8e-4;
  const SILENCE_TO_NOISE_RATIO = 1.25;
  const MIN_ACTIVE_SPEECH_TO_NOISE_RATIO = 1.35;
  const MIN_PEAK_SPEECH_TO_NOISE_RATIO = 1.8;
  const SPEECH_CONFIRM_MS = 200;
  const SILENCE_AFTER_SPEECH_MS = 800;
  const MAX_SPEECH_DURATION_MS = 15_000;

  function calcRms(samples) {
    let sumSq = 0;
    for (const sample of samples) sumSq += sample * sample;
    return samples.length ? Math.sqrt(sumSq / samples.length) : 0;
  }

  function createEnergyVad({ streamId, onUtterance, onDiscard = () => {} }) {
    if (streamId !== 'mic' && streamId !== 'tab') {
      throw new TypeError('streamId must be mic or tab');
    }
    if (typeof onUtterance !== 'function') {
      throw new TypeError('onUtterance callback is required');
    }

    let vadState = 'SILENCE';
    let speechSamples = [];
    let confirmSamples = [];
    let confirmMs = 0;
    let silenceMs = 0;
    let speechMs = 0;
    let utteranceMs = 0;
    let smoothedRms = 0;
    let noiseFloorRms = 0;
    let speechActiveRmsSum = 0;
    let speechActiveChunks = 0;
    let speechPeakRms = 0;
    let speechNoiseFloorRms = 0;
    let clippedSamples = 0;
    let sampleCount = 0;
    let voicedMs = 0;
    let currentSampleRate = null;
    let audioEndedAtMs = null;

    function updateNoiseFloor(rms) {
      const clamped = Math.max(rms, MIN_NOISE_FLOOR_RMS);
      if (noiseFloorRms === 0) {
        noiseFloorRms = clamped;
        return;
      }
      const alpha = clamped > noiseFloorRms ? NOISE_FLOOR_RISE_ALPHA : NOISE_FLOOR_FALL_ALPHA;
      noiseFloorRms = alpha * clamped + (1 - alpha) * noiseFloorRms;
    }

    function speechStartThreshold() {
      return Math.max(
        SPEECH_RMS_THRESHOLD,
        noiseFloorRms * SPEECH_TO_NOISE_RATIO,
        noiseFloorRms + SPEECH_TO_NOISE_MARGIN
      );
    }

    function silenceThreshold() {
      return Math.max(SILENCE_RMS_THRESHOLD, noiseFloorRms * SILENCE_TO_NOISE_RATIO);
    }

    function resetSpeech() {
      speechSamples = [];
      silenceMs = 0;
      speechMs = 0;
      utteranceMs = 0;
      speechActiveRmsSum = 0;
      speechActiveChunks = 0;
      speechPeakRms = 0;
      speechNoiseFloorRms = 0;
      clippedSamples = 0;
      sampleCount = 0;
      voicedMs = 0;
      audioEndedAtMs = null;
    }

    function observe(samples, threshold, durationMs) {
      const rms = calcRms(samples);
      speechPeakRms = Math.max(speechPeakRms, rms);
      sampleCount += samples.length;
      for (const sample of samples) {
        if (Math.abs(sample) >= 0.999) clippedSamples += 1;
      }
      if (rms >= threshold) {
        speechActiveRmsSum += rms;
        speechActiveChunks += 1;
        voicedMs += durationMs;
      }
      return rms;
    }

    function finish(reason) {
      const baselineNoise = Math.max(speechNoiseFloorRms, MIN_NOISE_FLOOR_RMS);
      const averageActiveRms = speechActiveChunks ? speechActiveRmsSum / speechActiveChunks : 0;
      const minAverageRms = Math.max(SILENCE_RMS_THRESHOLD, baselineNoise * MIN_ACTIVE_SPEECH_TO_NOISE_RATIO);
      const minPeakRms = Math.max(SPEECH_RMS_THRESHOLD, baselineNoise * MIN_PEAK_SPEECH_TO_NOISE_RATIO);
      const durationMs = utteranceMs;
      const clippingRatio = sampleCount ? clippedSamples / sampleCount : 0;

      if (voicedMs > 0 && speechPeakRms >= minPeakRms && averageActiveRms >= minAverageRms) {
        onUtterance({
          streamId,
          samples: speechSamples,
          audioEndedAtMs: audioEndedAtMs ?? Date.now(),
          speechMs: voicedMs,
          sampleRate: currentSampleRate,
          evidence: {
            vadKind: 'energy',
            speechDetected: true,
            voicedDurationMs: voicedMs,
            utteranceDurationMs: durationMs,
            clippingRatio,
          },
        });
      } else {
        onDiscard({
          streamId,
          reason: voicedMs <= 0 ? 'no voiced frames' : 'signal too close to noise floor',
          speechMs: voicedMs,
          peakRms: speechPeakRms,
          averageActiveRms,
          baselineNoise,
          finishReason: reason,
        });
      }
      vadState = 'SILENCE';
      confirmSamples = [];
      confirmMs = 0;
      resetSpeech();
    }

    function process(samples, sampleRate) {
      if (!(samples instanceof Float32Array) || samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
        return;
      }
      currentSampleRate = sampleRate;
      const frame = new Float32Array(samples);
      const frameMs = (frame.length / sampleRate) * 1000;
      const rms = calcRms(frame);
      smoothedRms = RMS_EMA_ALPHA * rms + (1 - RMS_EMA_ALPHA) * smoothedRms;
      const startThreshold = speechStartThreshold();
      const quietThreshold = silenceThreshold();

      if (vadState === 'SILENCE') {
        if (smoothedRms > startThreshold) {
          vadState = 'CONFIRMING';
          confirmMs = frameMs;
          confirmSamples = [frame];
        }
      } else if (vadState === 'CONFIRMING') {
        if (smoothedRms > startThreshold) {
          confirmSamples.push(frame);
          confirmMs += frameMs;
          if (confirmMs >= SPEECH_CONFIRM_MS) {
            vadState = 'SPEAKING';
            speechSamples = confirmSamples;
            confirmSamples = [];
            utteranceMs = confirmMs;
            speechNoiseFloorRms = noiseFloorRms;
            speechActiveRmsSum = 0;
            speechActiveChunks = 0;
            speechPeakRms = 0;
            clippedSamples = 0;
            sampleCount = 0;
            voicedMs = 0;
            speechMs = 0;
            for (const chunk of speechSamples) {
              const chunkRms = observe(chunk, quietThreshold, (chunk.length / sampleRate) * 1000);
              if (chunkRms >= quietThreshold) {
                speechMs += (chunk.length / sampleRate) * 1000;
                audioEndedAtMs = Date.now();
              }
            }
            silenceMs = 0;
            confirmMs = 0;
          }
        } else {
          vadState = 'SILENCE';
          confirmSamples = [];
          confirmMs = 0;
        }
      } else {
        speechSamples.push(frame);
        utteranceMs += frameMs;
        const frameRms = observe(frame, quietThreshold, frameMs);
        if (frameRms >= quietThreshold) {
          speechMs += frameMs;
          audioEndedAtMs = Date.now();
        }

        if (smoothedRms < quietThreshold) {
          silenceMs += frameMs;
          if (silenceMs >= SILENCE_AFTER_SPEECH_MS) finish('silence');
        } else {
          silenceMs = 0;
        }
        if (speechMs >= MAX_SPEECH_DURATION_MS) finish('max-duration');
      }

      if (vadState === 'SILENCE' && smoothedRms <= startThreshold * NOISE_FLOOR_UPDATE_GATE) {
        updateNoiseFloor(smoothedRms);
      }
    }

    return {
      process,
      stop() {
        if (vadState === 'SPEAKING' && speechSamples.length) finish('stop');
        vadState = 'SILENCE';
        confirmSamples = [];
        confirmMs = 0;
        smoothedRms = 0;
        noiseFloorRms = 0;
        currentSampleRate = null;
        resetSpeech();
      },
    };
  }

  const api = { createEnergyVad };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MeetTranslatorVad = api;
})(globalThis);
