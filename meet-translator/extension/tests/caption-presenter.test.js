'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../caption-protocol.js');

function loadPresenter() {
  const elements = new Map();
  const timers = [];
  let listener;
  function element() {
    return {
      children: [], dataset: {}, textContent: '', hidden: false,
      classList: { toggle() {} },
      append(...children) {
        for (const child of children) {
          child.remove();
          child.parent = this;
          this.children.push(child);
        }
      },
      remove() {
        if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
        this.parent = null;
      },
    };
  }
  const context = {
    MeetTranslatorCaptionProtocol: protocol, Date,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
    },
    chrome: { runtime: { connect: () => ({
      onMessage: { addListener(callback) { listener = callback; } },
      onDisconnect: { addListener() {} },
    }) } },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    setInterval() {},
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'caption-presenter.js'), 'utf8'), context);
  return {
    emit(event, snapshot = false) {
      listener({ type: snapshot ? 'CAPTION_PUBLIC_SNAPSHOT' : 'CAPTION_PUBLIC_EVENT', event });
      while (timers.length) timers.shift()();
    },
    sources: () => elements.get('caption-list').children.map((row) => row.children[0].textContent),
    empty: () => elements.get('empty-state').textContent,
  };
}

const record = (sourceText = 'approved source') => ({ segmentId: 'segment-a', revision: 1,
  sourceRevision: 1, streamId: 'tab', sourceText, translations: [], decision: 'accepted' });
const event = (type, sessionId, seq, payload = {}) => protocol.createPublicEvent(type, sessionId, seq, payload);

test('presenter never restores a retracted or ended caption from a delayed same-session snapshot', () => {
  for (const ending of ['retract', 'session-ended']) {
    const presenter = loadPresenter();
    presenter.emit(event('upsert', 'session-a', 2, { record: record() }));
    presenter.emit(event(ending, 'session-a', 4, { segmentId: 'segment-a' }));
    presenter.emit(event('snapshot', 'session-a', 3, { records: [record()] }), true);
    assert.deepEqual(presenter.sources(), [], ending);
    if (ending === 'session-ended') assert.match(presenter.empty(), /終了/);
  }
});

test('presenter accepts a newer snapshot without accepting its duplicate or older replacement', () => {
  const presenter = loadPresenter();
  presenter.emit(event('snapshot', 'session-a', 1, { records: [record()] }), true);
  presenter.emit(event('snapshot', 'session-a', 3, { records: [record('corrected source')] }), true);
  presenter.emit(event('snapshot', 'session-a', 3, { records: [record('duplicate stale source')] }), true);
  assert.deepEqual(presenter.sources(), ['corrected source']);
});

test('presenter hands off after session end and rejects retired sessions and active foreign sessions', () => {
  const presenter = loadPresenter();
  presenter.emit(null, true);
  presenter.emit(event('upsert', 'session-a', 1, { record: record('first session') }));
  presenter.emit(event('snapshot', 'unexpected-session', 9, { records: [record('foreign')] }), true);
  assert.deepEqual(presenter.sources(), ['first session']);
  presenter.emit(event('session-ended', 'session-a', 2));
  presenter.emit(event('upsert', 'session-b', 1, { record: record('second session') }));
  presenter.emit(event('snapshot', 'session-a', 10, { records: [record('retired')] }), true);
  presenter.emit(event('upsert', 'session-a', 11, { record: record('retired live') }));
  assert.deepEqual(presenter.sources(), ['second session']);
});

test('invalid initial snapshot cannot claim a session or clear a valid caption', () => {
  for (const invalid of [
    { type: 'snapshot', sessionId: 'invalid', sessionSeq: 1, records: [] },
    ...[undefined, '', null, 42].map((sessionId) => ({ protocolVersion: 1, type: 'snapshot', sessionId, sessionSeq: 1, records: [] })),
  ]) {
    const presenter = loadPresenter();
    presenter.emit(invalid, true);
    presenter.emit(event('upsert', 'session-a', 1, { record: record() }));
    presenter.emit({ type: 'snapshot', sessionId: 'session-a', sessionSeq: 2, records: [{}] }, true);
    assert.deepEqual(presenter.sources(), ['approved source']);
  }
});
