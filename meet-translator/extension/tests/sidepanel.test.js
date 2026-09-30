'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const sidepanelSource = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');

class FakeElement {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = { toggle() {} };
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
  }
  click() { this.listeners.get('click')?.(); }
}

function loadSidepanel() {
  const elements = new Map();
  const sentMessages = [];
  let onMessage;
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new FakeElement();
        element.ownerDocument = document;
        elements.set(id, element);
      }
      return elements.get(id);
    },
    createElement() {
      const element = new FakeElement();
      element.ownerDocument = document;
      return element;
    },
  };
  const context = {
    crypto: { randomUUID: () => 'test-request-id' },
    document,
    chrome: {
      runtime: {
        connect() {
          return {
            onMessage: { addListener(listener) { onMessage = listener; } },
            onDisconnect: { addListener() {} },
            postMessage(message) { sentMessages.push(message); },
          };
        },
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(sidepanelSource, context, { filename: 'sidepanel.js' });
  return { elements, document, sentMessages, emit: (message) => onMessage(message) };
}

test('late action response cannot replace a newer translated private record', () => {
  const { elements, emit } = loadSidepanel();
  const pendingRecord = {
    segmentId: 'segment-a', revision: 2, sourceRevision: 2, sessionId: 'session-a',
    streamId: 'tab', sourceText: 'Corrected source', decision: 'uncertain', published: false,
    translations: [{ targetLanguage: 'ja', sourceRevision: 2, state: 'pending', text: null }],
  };
  emit({ type: 'CAPTION_PRIVATE_SNAPSHOT', snapshot: { activeSessionId: 'session-a', records: [pendingRecord] } });
  elements.get('history').children[0].click();

  const translatedRecord = {
    ...pendingRecord,
    revision: 3,
    translations: [{ targetLanguage: 'ja', sourceRevision: 2, state: 'ready', text: '新しい翻訳' }],
  };
  emit({ type: 'CAPTION_PRIVATE_RECORD', record: translatedRecord });
  emit({ type: 'CAPTION_ACTION_RESULT', action: 'correct', result: { ok: true, record: pendingRecord } });

  assert.equal(elements.get('translation').textContent, '新しい翻訳');
  assert.equal(elements.get('source-text').value, 'Corrected source');
});

test('private panel shows ASR diagnostics and keeps empty speech candidates unapprovable', () => {
  const { elements, emit } = loadSidepanel();
  const record = {
    segmentId: 'segment-diagnostic', revision: 1, sourceRevision: 1, sessionId: 'session-a',
    streamId: 'tab', sourceText: 'ご視聴ありがとうございました', rawText: 'Thank you for watching',
    decision: 'uncertain', published: false, translations: [],
    reasonCodes: ['INSUFFICIENT_EVIDENCE', 'KNOWN_HALLUCINATION_PHRASE', 'LOW_LOGPROB'],
  };
  emit({ type: 'CAPTION_PRIVATE_SNAPSHOT', snapshot: { activeSessionId: 'session-a', records: [record] } });
  elements.get('history').children[0].click();

  assert.match(elements.get('selected-status').textContent, /定型句のため要確認/);
  assert.match(elements.get('selected-status').textContent, /Whisperの対数確率が低い/);

  const emptyRecord = {
    ...record, segmentId: 'segment-empty', revision: 1, sourceText: '', rawText: '',
    reasonCodes: ['EMPTY_WITH_SPEECH'],
  };
  emit({ type: 'CAPTION_PRIVATE_RECORD', record: emptyRecord });
  elements.get('history').children[1].click();
  assert.equal(elements.get('approve-caption').disabled, true);
  assert.match(elements.get('history').children[1].children[0].textContent, /音声あり・認識文字なし/);
});

test('private panel reports dropped audio count and duration', () => {
  const { elements, emit } = loadSidepanel();
  emit({
    type: 'CAPTION_QUEUE_STATUS',
    status: { code: 'OVERLOAD', droppedCount: 2, droppedAudioMs: 2750 },
  });

  assert.match(elements.get('status').textContent, /破棄した件数は累計2件・合計2\.8秒/);
  assert.match(elements.get('status').textContent, /最新の区分は「音声処理の混雑」/);
});

test('private panel separates cumulative audio drops from the latest drop category', () => {
  const { elements, emit } = loadSidepanel();
  emit({
    type: 'CAPTION_QUEUE_STATUS',
    status: { code: 'STALE', droppedCount: 1, droppedAudioMs: 750 },
  });
  emit({
    type: 'CAPTION_QUEUE_STATUS',
    status: { code: 'OVERLOAD', droppedCount: 2, droppedAudioMs: 2750 },
  });

  assert.match(elements.get('status').textContent, /破棄した件数は累計2件・合計2\.8秒/);
  assert.match(elements.get('status').textContent, /最新の区分は「音声処理の混雑」/);
  assert.match(elements.get('status').textContent, /字幕履歴を確認してください/);
});

test('private panel reports stale translation drops and retained source', () => {
  const { elements, emit } = loadSidepanel();
  emit({
    type: 'CAPTION_TRANSLATION_QUEUE_STATUS',
    status: { code: 'TRANSLATION_STALE', droppedCount: 3 },
  });

  assert.match(elements.get('status').textContent, /開始せずに破棄した件数は累計3件/);
  assert.match(elements.get('status').textContent, /最新の区分は「翻訳の期限切れ・原文\/セッション更新」/);
  assert.match(elements.get('status').textContent, /原文は履歴に保持しました/);
});

test('private panel separates the cumulative drop total from the latest translation drop reason', () => {
  const { elements, emit } = loadSidepanel();
  emit({
    type: 'CAPTION_TRANSLATION_QUEUE_STATUS',
    status: { code: 'TRANSLATION_STALE', droppedCount: 1 },
  });
  emit({
    type: 'CAPTION_TRANSLATION_QUEUE_STATUS',
    status: { code: 'TRANSLATION_OVERLOAD', droppedCount: 2 },
  });

  assert.match(elements.get('status').textContent, /開始せずに破棄した件数は累計2件/);
  assert.match(elements.get('status').textContent, /最新の区分は「翻訳処理の混雑」/);
  assert.match(elements.get('status').textContent, /原文は履歴に保持しました/);
});

test('private panel reports a failed translation without claiming the source changed', () => {
  const { elements, emit } = loadSidepanel();
  const record = {
    segmentId: 'segment-timeout', revision: 2, sourceRevision: 2, sessionId: 'session-a',
    streamId: 'tab', sourceText: 'Unchanged corrected source', decision: 'uncertain', published: false,
    translations: [{ targetLanguage: 'ja', sourceRevision: 2, state: 'failed', text: null }],
  };
  emit({ type: 'CAPTION_PRIVATE_SNAPSHOT', snapshot: { activeSessionId: 'session-a', records: [record] } });
  elements.get('history').children[0].click();
  emit({
    type: 'CAPTION_ACTION_RESULT',
    action: 'correct',
    result: { ok: true, record, translationFailed: true },
  });

  assert.match(elements.get('status').textContent, /翻訳に失敗しました/);
  assert.doesNotMatch(elements.get('status').textContent, /原文が更新された/);
});

test('100 incoming candidates keep the focused correction draft, selection, and target segment', () => {
  const { elements, document, sentMessages, emit } = loadSidepanel();
  const selected = {
    segmentId: 'segment-selected', revision: 4, sourceRevision: 2, sessionId: 'session-a',
    streamId: 'tab', sourceText: 'Original source', decision: 'uncertain', published: false,
    translations: [{ targetLanguage: 'ja', sourceRevision: 2, state: 'ready', text: '元の翻訳' }],
  };
  emit({ type: 'CAPTION_PRIVATE_SNAPSHOT', snapshot: { activeSessionId: 'session-a', records: [selected] } });
  elements.get('history').children[0].click();

  const editor = elements.get('source-text');
  editor.focus();
  editor.value = 'Draft correction in progress';
  editor.selectionStart = 6;
  editor.selectionEnd = 17;
  editor.listeners.get('input')();

  for (let index = 0; index < 100; index++) {
    emit({
      type: 'CAPTION_PRIVATE_RECORD',
      record: {
        segmentId: `incoming-${index}`, revision: 1, sourceRevision: 1, sessionId: 'session-a',
        streamId: 'tab', sourceText: `New candidate ${index}`, decision: 'uncertain', published: false,
        translations: [],
      },
    });
  }

  assert.equal(document.activeElement, editor);
  assert.equal(editor.value, 'Draft correction in progress');
  assert.deepEqual([editor.selectionStart, editor.selectionEnd], [6, 17]);

  elements.get('save-correction').click();
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].payload.segmentId, 'segment-selected');
  assert.equal(sentMessages[0].payload.expectedRevision, 4);
  assert.equal(sentMessages[0].payload.sourceText, 'Draft correction in progress');
});

test('Enter during IME composition never saves a correction', () => {
  const { elements, sentMessages, emit } = loadSidepanel();
  const record = {
    segmentId: 'segment-ime', revision: 1, sourceRevision: 1, sessionId: 'session-a',
    streamId: 'tab', sourceText: 'Original source', decision: 'uncertain', published: false,
    translations: [],
  };
  emit({ type: 'CAPTION_PRIVATE_SNAPSHOT', snapshot: { activeSessionId: 'session-a', records: [record] } });
  elements.get('history').children[0].click();
  const editor = elements.get('source-text');
  editor.value = '編集中の訂正文';
  editor.listeners.get('input')();
  editor.listeners.get('keydown')?.({ key: 'Enter', isComposing: true, keyCode: 229, preventDefault() {} });

  assert.equal(sentMessages.length, 0);
});
