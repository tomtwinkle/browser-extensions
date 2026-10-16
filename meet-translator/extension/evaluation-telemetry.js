'use strict';

(function exposeEvaluationTelemetry(root) {
  const META_KEY = 'meetTranslatorEvaluationTelemetryMeta';
  const EVENT_KEY_PREFIX = 'meetTranslatorEvaluationTelemetryEvent:';
  const DEFAULT_MAX_EVENTS = 10_000;
  const EVENT_TYPES = new Set([
    'run_started', 'run_stopped', 'audio_enqueued', 'audio_started', 'audio_finished', 'audio_dropped', 'audio_discarded',
    'asr_started', 'asr_finished', 'translation_enqueued', 'translation_started', 'translation_finished',
    'translation_dropped', 'translation_deduplicated', 'translation_held', 'translation_admission_rejected',
    'candidate_generated', 'approval_requested', 'approval_finished',
    'caption_publication_event', 'caption_retracted', 'correction_saved', 'correction_undone',
    'backend_error', 'retry', 'load_control_transition', 'adaptive_work_stopped',
    'translation_paused', 'translation_resumed', 'inference_rejected', 'memory_recovery_ready',
  ]);
  const STRING_FIELDS = new Set([
    'caseId', 'sessionId', 'observedConfigId', 'configCoverage', 'streamId', 'queueName', 'reason', 'errorClass', 'outcome',
  ]);
  const NUMBER_FIELDS = new Set([
    'streamGeneration', 'audioEndedAtMs', 'audioDurationMs', 'queueLength', 'queueWaitMs', 'executionMs',
    'durationMs', 'attempt', 'droppedCount', 'droppedAudioMs', 'pendingCount', 'activeCount',
  ]);
  const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
  const REASON_PATTERN = /^[A-Z][A-Z0-9_:-]{0,63}$/;
  const ERROR_CLASS_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
  const CONFIG_KEYS = [
    'asrModel', 'translationModel', 'runtimeRevision', 'quantization', 'templateId',
    'decodeOptions', 'publicationGateId', 'sourceLang', 'targetLang', 'bidirectional', 'asrHintsMode',
  ];
  const SECRET_KEY_PATTERN = /(api|token|secret|password|prompt|text|transcript|audio|url|endpoint|path)/i;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function safeId(value) {
    return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
  }

  function safeReason(value) {
    return typeof value === 'string' && REASON_PATTERN.test(value) ? value : null;
  }

  function cleanDecodeOptions(value, key = '') {
    if (SECRET_KEY_PATTERN.test(key)) return undefined;
    if (value == null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      return typeof value === 'string' ? value.slice(0, 128) : value;
    }
    if (Array.isArray(value)) return value.slice(0, 32).map((item) => cleanDecodeOptions(item)).filter((item) => item !== undefined);
    if (typeof value !== 'object') return undefined;
    const output = {};
    for (const childKey of Object.keys(value).sort().slice(0, 64)) {
      const childValue = cleanDecodeOptions(value[childKey], childKey);
      if (childValue !== undefined) output[childKey] = childValue;
    }
    return output;
  }

  function configurationId(configuration = {}) {
    const material = {};
    for (const key of CONFIG_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(configuration, key)) continue;
      const value = key === 'decodeOptions'
        ? cleanDecodeOptions(configuration[key])
        : cleanDecodeOptions(configuration[key], key);
      if (value !== undefined) material[key] = value;
    }
    const serialized = JSON.stringify(material);
    let hash = 0x811c9dc5;
    for (let index = 0; index < serialized.length; index += 1) {
      hash ^= serialized.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `cfg-observed-fnv1a32-v1-${hash.toString(16).padStart(8, '0')}`;
  }

  function normalizeEvent(input) {
    if (!input || !EVENT_TYPES.has(input.type) || !Number.isSafeInteger(input.sequence) ||
        !Number.isFinite(input.atMs) || !safeId(input.runId)) return null;
    const event = {
      sequence: input.sequence,
      type: input.type,
      atMs: input.atMs,
      runId: input.runId,
    };
    for (const field of STRING_FIELDS) {
      if (field === 'reason') {
        const value = safeReason(input[field]);
        if (value) event[field] = value;
        continue;
      }
      if (field === 'errorClass') {
        if (typeof input[field] === 'string' && ERROR_CLASS_PATTERN.test(input[field])) event[field] = input[field];
        continue;
      }
      const value = safeId(input[field]);
      if (value) event[field] = value;
    }
    if (event.streamId && !['mic', 'tab'].includes(event.streamId)) delete event.streamId;
    for (const field of NUMBER_FIELDS) {
      const value = input[field];
      if (Number.isSafeInteger(value) && value >= 0) event[field] = value;
    }
    if (Array.isArray(input.relatedCaseIds)) {
      event.relatedCaseIds = input.relatedCaseIds.map(safeId).filter(Boolean).slice(0, 32);
    }
    return event;
  }

  function createEvaluationTelemetry({ now = () => Date.now(), idFactory, maxEvents = DEFAULT_MAX_EVENTS, storage = null } = {}) {
    const capacity = Number.isSafeInteger(maxEvents) && maxEvents > 0 ? maxEvents : DEFAULT_MAX_EVENTS;
    const makeId = idFactory || (() => root.crypto?.randomUUID?.() || `run-${now().toString(36)}`);
    let activeRunId = null;
    let nextSequence = 1;
    let droppedEventCount = 0;
    let persistenceErrorCount = 0;
    let events = [];
    let persistenceQueue = Promise.resolve();

    function appendStoredEvent(event, removed) {
      if (!storage || typeof storage.set !== 'function') return;
      persistenceQueue = persistenceQueue.then(async () => {
        await storage.set({ [`${EVENT_KEY_PREFIX}${event.sequence}`]: event });
        if (removed && typeof storage.remove === 'function') {
          await storage.remove(`${EVENT_KEY_PREFIX}${removed.sequence}`);
        }
        await storage.set({ [META_KEY]: { activeRunId, nextSequence, droppedEventCount } });
      }).catch(() => {
        persistenceErrorCount += 1;
      });
    }

    function record(type, fields = {}) {
      if (!EVENT_TYPES.has(type)) return null;
      const raw = {
        ...fields,
        type,
        sequence: nextSequence++,
        atMs: now(),
        runId: activeRunId || fields.runId || makeId(),
      };
      const event = normalizeEvent(raw);
      if (!event) return null;
      let removed = null;
      if (events.length === capacity) {
        removed = events.shift();
        droppedEventCount += 1;
      }
      events.push(event);
      appendStoredEvent(event, removed);
      return clone(event);
    }

    async function restore() {
      if (!storage || typeof storage.get !== 'function') return;
      try {
        const stored = await storage.get(null);
        const meta = stored?.[META_KEY];
        const restored = Object.entries(stored || {})
          .filter(([key]) => key.startsWith(EVENT_KEY_PREFIX))
          .map(([, value]) => normalizeEvent(value))
          .filter(Boolean)
          .sort((left, right) => left.sequence - right.sequence);
        events = restored.slice(-capacity);
        droppedEventCount = Number.isSafeInteger(meta?.droppedEventCount) && meta.droppedEventCount >= 0
          ? meta.droppedEventCount + Math.max(0, restored.length - capacity)
          : Math.max(0, restored.length - capacity);
        activeRunId = safeId(meta?.activeRunId) || events.at(-1)?.runId || null;
        nextSequence = Math.max(
          Number.isSafeInteger(meta?.nextSequence) ? meta.nextSequence : 1,
          (events.at(-1)?.sequence || 0) + 1,
        );
      } catch (_) {
        persistenceErrorCount += 1;
      }
    }

    function beginRun({ runId = makeId(), sessionId = null, observedConfigId = null, configCoverage = 'partial' } = {}) {
      activeRunId = safeId(runId) || makeId();
      return record('run_started', { sessionId, observedConfigId, configCoverage });
    }

    function endRun(fields = {}) {
      const event = record('run_stopped', fields);
      activeRunId = null;
      if (storage?.set) {
        persistenceQueue = persistenceQueue.then(() => storage.set({
          [META_KEY]: { activeRunId, nextSequence, droppedEventCount },
        })).catch(() => { persistenceErrorCount += 1; });
      }
      return event;
    }

    function snapshot() {
      return {
        schemaVersion: 1,
        activeRunId,
        nextSequence,
        droppedEventCount,
        persistenceErrorCount,
        events: clone(events),
      };
    }

    function caseTimings() {
      const cases = new Map();
      for (const event of events) {
        if (!event.caseId) continue;
        let value = cases.get(event.caseId);
        if (!value) {
          value = { caseId: event.caseId };
          cases.set(event.caseId, value);
        }
        if (event.audioEndedAtMs != null && value.audioEndedAtMs == null) value.audioEndedAtMs = event.audioEndedAtMs;
        if (event.type === 'candidate_generated' && value.candidateAtMs == null) value.candidateAtMs = event.atMs;
        if (event.type === 'translation_finished' && event.outcome === 'success') value.translationAtMs = event.atMs;
        if (event.type === 'approval_requested' && value.approvalAtMs == null) value.approvalAtMs = event.atMs;
        if (event.type === 'caption_publication_event' && value.publicationEventAtMs == null) {
          value.publicationEventAtMs = event.atMs;
        }
      }
      return [...cases.values()].map((value) => {
        const timing = { caseId: value.caseId };
        if (value.audioEndedAtMs != null && value.candidateAtMs != null) {
          timing.audioToCandidateMs = Math.max(0, value.candidateAtMs - value.audioEndedAtMs);
        }
        if (value.audioEndedAtMs != null && value.translationAtMs != null) {
          timing.audioToTranslationMs = Math.max(0, value.translationAtMs - value.audioEndedAtMs);
        }
        if (value.candidateAtMs != null && value.approvalAtMs != null) {
          timing.humanApprovalWaitMs = Math.max(0, value.approvalAtMs - value.candidateAtMs);
        }
        if (value.approvalAtMs != null && value.publicationEventAtMs != null) {
          timing.approvalToPublicationEventMs = Math.max(0, value.publicationEventAtMs - value.approvalAtMs);
        }
        return timing;
      }).sort((left, right) => left.caseId.localeCompare(right.caseId));
    }

    async function flush() {
      await persistenceQueue;
    }

    return { beginRun, caseTimings, endRun, flush, record, restore, snapshot };
  }

  root.MeetTranslatorEvaluationTelemetry = Object.freeze({
    createEvaluationTelemetry,
    configurationId,
  });
})(globalThis);
