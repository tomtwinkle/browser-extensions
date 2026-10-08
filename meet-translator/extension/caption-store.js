'use strict';

(function exposeCaptionStore(root) {
  const protocol = root.MeetTranslatorCaptionProtocol || (typeof require === 'function' ? require('./caption-protocol.js') : null);

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function byteLength(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
    return unescape(encodeURIComponent(value)).length;
  }

  function createCaptionStore({
    now = () => Date.now(),
    onPrivateRecord = () => {},
    onPublicEvent = () => {},
    initialState = null,
    maxRecords = 500,
    maxAgeMs = 60 * 60 * 1000,
    maxSerializedBytes = 4 * 1024 * 1024,
  } = {}) {
    if (!protocol) throw new Error('caption protocol is required');

    const records = new Map((initialState?.records || []).map((record) => [record.segmentId, clone(record)]));
    const undoSnapshots = new Map();
    let activeSessionId = initialState?.activeSessionId || null;
    let activeGenerations = clone(initialState?.activeGenerations || {});
    let sessionSeq = Number.isSafeInteger(initialState?.sessionSeq) ? initialState.sessionSeq : 0;
    let publishMicrophoneCaptions = initialState?.publishMicrophoneCaptions === true;

    function currentGeneration(record) {
      return Boolean(activeSessionId && record.sessionId === activeSessionId &&
        Number.isSafeInteger(record.streamGeneration) && activeGenerations[record.streamId] === record.streamGeneration);
    }

    function emitPrivate(record) {
      if (record) onPrivateRecord(clone(record));
    }

    function emitPublic(type, payload) {
      if (!activeSessionId) return null;
      const event = protocol.createPublicEvent(type, activeSessionId, ++sessionSeq, payload);
      onPublicEvent(event);
      return event;
    }

    function storeState() {
      prune();
      return {
        activeSessionId,
        activeGenerations: clone(activeGenerations),
        sessionSeq,
        publishMicrophoneCaptions,
        records: [...records.values()].map(clone),
      };
    }

    function prune() {
      const cutoff = now() - maxAgeMs;
      for (const [id, record] of records) {
        if (record.updatedAt < cutoff) records.delete(id);
      }
      const ordered = [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const record of ordered.slice(maxRecords)) records.delete(record.segmentId);
      const stateBytes = () => byteLength(JSON.stringify({
        activeSessionId,
        activeGenerations,
        sessionSeq,
        publishMicrophoneCaptions,
        records: [...records.values()],
      }));
      const oldestFirst = [...records.values()].sort((a, b) => a.updatedAt - b.updatedAt);
      let index = 0;
      while (records.size && stateBytes() > maxSerializedBytes) {
        records.delete(oldestFirst[index++].segmentId);
      }
    }

    function find(segmentId) {
      const record = records.get(segmentId);
      return record ? clone(record) : null;
    }

    function beginSession(sessionId, generations) {
      if (typeof sessionId !== 'string' || !sessionId || !generations || activeSessionId) {
        return { ok: false, reason: 'session-already-active-or-invalid' };
      }
      activeSessionId = sessionId;
      activeGenerations = { mic: generations.mic || 0, tab: generations.tab || 0 };
      sessionSeq = 0;
      return { ok: true, state: storeState() };
    }

    function endSession(sessionId) {
      if (!activeSessionId || sessionId !== activeSessionId) return { ok: false, reason: 'stale-session' };
      for (const record of records.values()) {
        if (record.sessionId !== activeSessionId || !record.published) continue;
        record.published = false;
        record.publishEligible = false;
        record.revision += 1;
        record.updatedAt = now();
        emitPublic('retract', { segmentId: record.segmentId });
        emitPrivate(record);
      }
      emitPublic('session-ended');
      activeSessionId = null;
      activeGenerations = {};
      prune();
      return { ok: true, state: storeState() };
    }

    function upsertCandidate(input) {
      const reasonCodes = Array.isArray(input?.reasonCodes) ? input.reasonCodes : [];
      const emptyWithSpeech = reasonCodes.includes('EMPTY_WITH_SPEECH') && input?.evidence?.speechDetected === true;
      if (!input || (input.streamId !== 'mic' && input.streamId !== 'tab') ||
          typeof input.segmentId !== 'string' || !input.segmentId ||
          !Number.isSafeInteger(input.streamGeneration) || input.sessionId !== activeSessionId ||
          activeGenerations[input.streamId] !== input.streamGeneration ||
          typeof input.rawText !== 'string' || (!input.rawText.trim() && !emptyWithSpeech) ||
          byteLength(input.rawText) > protocol.MAX_TEXT_BYTES ||
          typeof input.sourceText !== 'string' || (!input.sourceText.trim() && !emptyWithSpeech) ||
          byteLength(input.sourceText) > protocol.MAX_TEXT_BYTES ||
          reasonCodes.length > 32 || reasonCodes.some((reason) => typeof reason !== 'string' || reason.length > 64) ||
          !Array.isArray(input.translations || []) || (input.translations || []).length > 4 ||
          (input.translations || []).some((translation) => !translation ||
            typeof translation.targetLanguage !== 'string' || translation.targetLanguage.length > 32 ||
            !['pending', 'ready', 'failed', 'paused'].includes(translation.state) ||
            !Number.isSafeInteger(translation.sourceRevision) ||
            (translation.text !== null && (typeof translation.text !== 'string' || byteLength(translation.text) > protocol.MAX_TEXT_BYTES)))) {
        return { ok: false, reason: 'invalid-or-stale-candidate' };
      }
      const previous = records.get(input.segmentId);
      if (previous?.humanCorrected) return { ok: false, reason: 'human-correction-protected' };
      const createdAt = previous?.createdAt || now();
      const record = {
        sessionId: input.sessionId,
        streamId: input.streamId,
        streamGeneration: input.streamGeneration,
        segmentId: input.segmentId,
        revision: (previous?.revision || 0) + 1,
        sourceRevision: previous?.sourceRevision || 1,
        startMs: Number.isFinite(input.startMs) ? input.startMs : null,
        endMs: Number.isFinite(input.endMs) ? input.endMs : null,
        rawText: input.rawText,
        sourceText: previous?.sourceText || input.sourceText,
        sourceLanguage: input.sourceLanguage || null,
        translations: clone(input.translations || []),
        decision: 'uncertain',
        reasonCodes: clone(input.reasonCodes || ['INSUFFICIENT_EVIDENCE']),
        humanCorrected: false,
        userApproved: false,
        speakerId: null,
        speakerName: null,
        glossaryVersion: input.glossaryVersion || null,
        publishEligible: false,
        published: false,
        evidence: clone(input.evidence || null),
        createdAt,
        updatedAt: now(),
      };
      records.set(record.segmentId, record);
      prune();
      emitPrivate(record);
      return { ok: true, record: clone(record), state: storeState() };
    }

    function approve(segmentId, expectedRevision = null) {
      const record = records.get(segmentId);
      if (!record || (expectedRevision != null && record.revision !== expectedRevision)) {
        return { ok: false, reason: 'stale-or-missing-record' };
      }
      if (!record.sourceText.trim()) return { ok: false, reason: 'empty-source' };
      record.decision = 'accepted';
      record.userApproved = true;
      record.publishEligible = currentGeneration(record) &&
        (record.streamId !== 'mic' || publishMicrophoneCaptions);
      record.published = record.publishEligible;
      record.revision += 1;
      record.updatedAt = now();
      if (record.published) emitPublic('upsert', { record: protocol.projectPublicRecord(record, { publishMicrophoneCaptions }) });
      emitPrivate(record);
      return { ok: true, record: clone(record), state: storeState() };
    }

    function correct(segmentId, sourceText, { expectedRevision } = {}) {
      const record = records.get(segmentId);
      if (!record || (expectedRevision != null && record.revision !== expectedRevision) ||
          typeof sourceText !== 'string' || !sourceText.trim() || byteLength(sourceText) > protocol.MAX_TEXT_BYTES) {
        return { ok: false, reason: 'stale-or-invalid-correction' };
      }
      undoSnapshots.set(segmentId, clone(record));
      if (record.published) emitPublic('retract', { segmentId });
      record.sourceText = sourceText.trim();
      record.sourceRevision += 1;
      record.revision += 1;
      record.decision = 'uncertain';
      record.humanCorrected = true;
      record.userApproved = false;
      record.publishEligible = false;
      record.published = false;
      record.translations = record.translations.map((translation) => ({
        targetLanguage: translation.targetLanguage,
        sourceRevision: record.sourceRevision,
        state: 'pending',
        text: null,
      }));
      record.updatedAt = now();
      record.hasUndo = true;
      emitPrivate(record);
      return { ok: true, record: clone(record), state: storeState() };
    }

    function undo(segmentId) {
      const current = records.get(segmentId);
      const previous = undoSnapshots.get(segmentId);
      if (!current || !previous) return { ok: false, reason: 'no-undo-or-stale' };
      if (current.published) emitPublic('retract', { segmentId });
      const restored = {
        ...clone(previous),
        revision: current.revision + 1,
        sourceRevision: current.sourceRevision + 1,
        rawText: current.rawText,
        translations: previous.translations.map((translation) => ({ ...clone(translation), sourceRevision: current.sourceRevision + 1 })),
        updatedAt: now(),
        hasUndo: false,
      };
      restored.publishEligible = restored.decision === 'accepted' && restored.userApproved &&
        (restored.streamId !== 'mic' || publishMicrophoneCaptions);
      restored.published = currentGeneration(restored) && restored.publishEligible && previous.published === true;
      records.set(segmentId, restored);
      undoSnapshots.delete(segmentId);
      if (restored.published) emitPublic('upsert', { record: protocol.projectPublicRecord(restored, { publishMicrophoneCaptions }) });
      emitPrivate(restored);
      return { ok: true, record: clone(restored), state: storeState() };
    }

    function setTranslation(segmentId, sourceRevision, targetLanguage, text, state = 'ready', { allowHistorical = false } = {}) {
      const record = records.get(segmentId);
      if (!record || (!allowHistorical && !currentGeneration(record)) || record.sourceRevision !== sourceRevision ||
          !['ready', 'failed', 'paused'].includes(state) || typeof targetLanguage !== 'string' || !targetLanguage ||
          targetLanguage.length > 32 || (state === 'ready' &&
            (typeof text !== 'string' || byteLength(text) > protocol.MAX_TEXT_BYTES))) {
        return { ok: false, reason: 'stale-or-invalid-translation' };
      }
      const resultText = state === 'ready' && typeof text === 'string' ? text : null;
      const current = record.translations.find((item) => item.targetLanguage === targetLanguage && item.sourceRevision === sourceRevision);
      const next = { targetLanguage, sourceRevision, state, text: resultText };
      if (current) Object.assign(current, next);
      else record.translations.push(next);
      record.revision += 1;
      record.updatedAt = now();
      if (record.published && record.publishEligible) {
        // Refresh the public projection so a private pause clears an old pending status.
        // projectPublicRecord omits the paused state and publishes only the original caption.
        emitPublic('upsert', { record: protocol.projectPublicRecord(record, { publishMicrophoneCaptions }) });
      }
      emitPrivate(record);
      return { ok: true, record: clone(record), state: storeState() };
    }

    function setMicPublication(enabled) {
      publishMicrophoneCaptions = enabled === true;
      if (!publishMicrophoneCaptions && activeSessionId) {
        for (const record of records.values()) {
          if (record.sessionId !== activeSessionId || record.streamId !== 'mic' || !record.published) continue;
          emitPublic('retract', { segmentId: record.segmentId });
          record.published = false;
          record.publishEligible = false;
          record.revision += 1;
          record.updatedAt = now();
          emitPrivate(record);
        }
      }
      return { ok: true, state: storeState() };
    }

    function publicSnapshot() {
      if (!activeSessionId) return { sessionId: null, sessionSeq, event: null, records: [] };
      const current = [...records.values()]
        .filter((record) => record.sessionId === activeSessionId && currentGeneration(record) && record.published)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 2)
        .map((record) => protocol.projectPublicRecord(record, { publishMicrophoneCaptions }))
        .filter(Boolean);
      sessionSeq = Math.max(sessionSeq + 1, 1);
      const event = protocol.createPublicEvent('snapshot', activeSessionId, sessionSeq, { records: current });
      return { sessionId: activeSessionId, sessionSeq: event.sessionSeq, event, records: current };
    }

    function privateSnapshot() {
      prune();
      const latest = [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxRecords);
      return { activeSessionId, activeGenerations: clone(activeGenerations), records: latest.map(clone) };
    }

    return {
      approve: (segmentId, expectedRevision) => approve(segmentId, expectedRevision), beginSession, correct, endSession, find, privateSnapshot, publicSnapshot,
      setMicPublication, setTranslation, state: storeState, undo, upsertCandidate,
    };
  }

  const api = { createCaptionStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MeetTranslatorCaptionStore = api;
})(globalThis);
