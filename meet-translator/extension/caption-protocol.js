'use strict';

(function exposeCaptionProtocol(root) {
  const PROTOCOL_VERSION = 1;
  const MAX_EVENT_BYTES = 64 * 1024;
  const MAX_TEXT_BYTES = 8 * 1024;
  const EVENT_TYPES = new Set(['upsert', 'retract', 'snapshot', 'session-ended']);

  function byteLength(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
    return unescape(encodeURIComponent(value)).length;
  }

  function validText(value, { allowEmpty = false } = {}) {
    return typeof value === 'string' && (allowEmpty || value.trim().length > 0) && byteLength(value) <= MAX_TEXT_BYTES;
  }

  function isPublicRecord(record) {
    return Boolean(
      record && typeof record.segmentId === 'string' && record.segmentId.length > 0 &&
      Number.isSafeInteger(record.revision) && record.revision > 0 &&
      Number.isSafeInteger(record.sourceRevision) && record.sourceRevision > 0 &&
      (record.streamId === 'mic' || record.streamId === 'tab') &&
      validText(record.sourceText) && record.decision === 'accepted' &&
      Array.isArray(record.translations) && record.translations.every((translation) =>
        translation && typeof translation.targetLanguage === 'string' &&
        ['pending', 'ready', 'failed'].includes(translation.state) &&
        (translation.text === null || validText(translation.text, { allowEmpty: true }))
      )
    );
  }

  /** Build a strict public record. Private ASR, identity, diagnostics, and settings never cross this projection. */
  function projectPublicRecord(record, { publishMicrophoneCaptions = false } = {}) {
    if (!record || record.decision !== 'accepted' || record.publishEligible !== true || record.published !== true) return null;
    if (record.streamId === 'mic' && !publishMicrophoneCaptions) return null;
    const translations = (Array.isArray(record.translations) ? record.translations : [])
      .filter((translation) => translation?.sourceRevision === record.sourceRevision && translation.state !== 'paused')
      .map((translation) => ({
        targetLanguage: translation.targetLanguage,
        state: translation.state,
        text: translation.state === 'ready' && validText(translation.text, { allowEmpty: true })
          ? translation.text
          : null,
      }));
    const projected = {
      segmentId: record.segmentId,
      revision: record.revision,
      sourceRevision: record.sourceRevision,
      streamId: record.streamId,
      sourceText: record.sourceText,
      translations,
      decision: 'accepted',
    };
    return isPublicRecord(projected) ? projected : null;
  }

  function createPublicEvent(type, sessionId, sessionSeq, payload = {}) {
    if (!EVENT_TYPES.has(type) || typeof sessionId !== 'string' || !sessionId ||
        !Number.isSafeInteger(sessionSeq) || sessionSeq < 1) {
      throw new TypeError('invalid caption event envelope');
    }
    const event = { protocolVersion: PROTOCOL_VERSION, type, sessionId, sessionSeq };
    if (type === 'upsert') {
      if (!isPublicRecord(payload.record)) throw new TypeError('invalid caption event record');
      event.record = payload.record;
    } else if (type === 'retract') {
      if (typeof payload.segmentId !== 'string' || !payload.segmentId) throw new TypeError('invalid caption retract');
      event.segmentId = payload.segmentId;
    } else if (type === 'snapshot') {
      if (!Array.isArray(payload.records) || payload.records.some((record) => !isPublicRecord(record))) {
        throw new TypeError('invalid caption snapshot');
      }
      event.records = payload.records;
    }
    if (byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) throw new RangeError('caption event exceeds 64 KiB');
    return event;
  }

  function applyPublicEvent(state, event) {
    if (!state || !event || event.protocolVersion !== PROTOCOL_VERSION ||
        !EVENT_TYPES.has(event.type) || event.sessionId !== state.sessionId ||
        !Number.isSafeInteger(event.sessionSeq) || event.sessionSeq <= state.lastSeq) return false;

    if (event.type === 'snapshot') {
      if (!Array.isArray(event.records) || event.records.some((record) => !isPublicRecord(record))) return false;
      state.records = new Map(event.records.map((record) => [record.segmentId, record]));
      state.ended = false;
    } else if (event.type === 'upsert') {
      if (!isPublicRecord(event.record)) return false;
      const current = state.records.get(event.record.segmentId);
      if (!current || event.record.revision > current.revision) state.records.set(event.record.segmentId, event.record);
      if (state.records.size > 2) {
        const newest = [...state.records.values()].sort((a, b) => b.revision - a.revision).slice(0, 2);
        state.records = new Map(newest.map((record) => [record.segmentId, record]));
      }
    } else if (event.type === 'retract') {
      if (typeof event.segmentId !== 'string') return false;
      state.records.delete(event.segmentId);
    } else {
      state.records.clear();
      state.ended = true;
    }
    state.lastSeq = event.sessionSeq;
    return true;
  }

  const api = { PROTOCOL_VERSION, MAX_EVENT_BYTES, MAX_TEXT_BYTES, applyPublicEvent, createPublicEvent, isPublicRecord, projectPublicRecord };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MeetTranslatorCaptionProtocol = api;
})(globalThis);
