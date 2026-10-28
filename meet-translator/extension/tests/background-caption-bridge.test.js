'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../shared.js');

const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function loadBackground({ persisted = null, publishMicrophoneCaptions = false, deferPublicSnapshot = false } = {}) {
  const workerConnections = [];
  const portMessages = [];
  const stored = { captionStoreState: persisted };
  const storageWrites = [];
  const publicSnapshotRequests = [];
  const chrome = {
    offscreen: { async createDocument() {}, async closeDocument() {} },
    runtime: {
      getURL(file = '') { return `chrome-extension://test/${file}`; },
      async getContexts() { return []; },
      lastError: null,
      onConnect: { addListener(listener) { workerConnections.push(listener); } },
      onMessage: { addListener() {} },
      sendMessage() { return Promise.resolve({}); },
    },
    scripting: { async executeScript() {} },
    storage: {
      local: {
        async get(keys) {
          const values = { publishMicrophoneCaptions };
          return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
            .filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
        },
        setAccessLevel() { return Promise.resolve(); },
      },
      session: {
        async get(key) {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter((name) => Object.hasOwn(stored, name))
            .map((name) => [name, stored[name]]));
        },
        async set(values) {
          storageWrites.push(values);
          Object.assign(stored, values);
        },
      },
    },
    tabs: { async sendMessage() { return { success: true }; } },
    tabCapture: { getMediaStreamId(_options, callback) { callback('stream-id'); } },
  };

  const context = {
    AbortController, Blob, FormData, URL, URLSearchParams, chrome, console: { info() {}, log() {}, warn() {}, error() {} },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
    globalThis: null,
    importScripts(...files) {
      for (const file of files) {
        if (file === 'shared.js') continue;
        const dependency = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        vm.runInNewContext(dependency, context, { filename: file });
      }
    },
    clearInterval() {}, clearTimeout, setInterval() { return 1; }, setTimeout,
  };
  context.globalThis = context;
  context.MeetTranslatorShared = shared;
  vm.runInNewContext(backgroundSource, context, { filename: 'background.js' });
  const state = vm.runInNewContext('state', context);

  function connect(name, url) {
    const incoming = [];
    const disconnectListeners = [];
    const port = {
      name,
      sender: { url },
      onMessage: { addListener(listener) { incoming.push(listener); } },
      onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
      disconnect() { for (const listener of disconnectListeners) listener(); },
      postMessage(message) {
        portMessages.push({ port, message });
        if (name === 'meet-translator-offscreen' && message.type === 'CAPTION_RPC') {
          if (message.action === 'snapshot-public' && deferPublicSnapshot) {
            publicSnapshotRequests.push({ port, requestId: message.requestId });
            return;
          }
          const result = message.action === 'snapshot-public'
            ? { event: null, sessionId: null }
            : { records: [], activeSessionId: null };
          queueMicrotask(() => port.emit({ type: 'CAPTION_RPC_RESULT', requestId: message.requestId, result }));
        }
      },
      emit(message) { for (const listener of incoming) listener(message); },
    };
    for (const listener of workerConnections) listener(port);
    return port;
  }

  return { chrome, connect, context, portMessages, state, storageWrites, stored, publicSnapshotRequests };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

async function pendingPublicSubscription() {
  const harness = loadBackground({ deferPublicSnapshot: true });
  const offscreen = harness.connect('meet-translator-offscreen', 'chrome-extension://test/offscreen.html');
  offscreen.emit({ type: 'OFFSCREEN_HELLO', bootId: 'boot-order' });
  await flush();
  const publicPage = harness.connect('caption-public', 'chrome-extension://test/caption-presenter.html');
  await flush();
  const messages = () => harness.portMessages.filter((item) => item.port === publicPage).map((item) => plain(item.message));
  const reply = (result, error = null) => {
    const request = harness.publicSnapshotRequests[0];
    offscreen.emit({ type: 'CAPTION_RPC_RESULT', requestId: request.requestId, result, error });
  };
  return { ...harness, offscreen, publicPage, messages, reply };
}

test('public subscription delivers its snapshot before buffered live retract/end/handoff events', async () => {
  const h = await pendingPublicSubscription();
  const events = [
    { type: 'retract', sessionId: 'session-a', sessionSeq: 2, segmentId: 'segment-a' },
    { type: 'session-ended', sessionId: 'session-a', sessionSeq: 3 },
    { type: 'upsert', sessionId: 'session-b', sessionSeq: 1, record: { segmentId: 'segment-b' } },
  ].map((value) => ({ protocolVersion: 1, ...value }));
  for (const event of events) h.offscreen.emit({ type: 'CAPTION_PUBLIC_EVENT', event });
  assert.deepEqual(h.messages(), []);
  const snapshot = { protocolVersion: 1, type: 'snapshot', sessionId: 'session-a', sessionSeq: 1, records: [] };
  h.reply({ event: snapshot });
  await flush();
  assert.deepEqual(h.messages(), [
    { type: 'CAPTION_PUBLIC_SNAPSHOT', event: snapshot },
    ...events.map((event) => ({ type: 'CAPTION_PUBLIC_EVENT', event })),
  ]);
});

test('public subscription discards pending live events when disconnected or snapshot fails', async () => {
  for (const mode of ['disconnect', 'failure']) {
    const h = await pendingPublicSubscription();
    h.offscreen.emit({ type: 'CAPTION_PUBLIC_EVENT', event: { type: 'session-ended', sessionId: 'session-a', sessionSeq: 1 } });
    if (mode === 'disconnect') h.publicPage.disconnect();
    if (mode === 'failure') h.offscreen.disconnect();
    else h.reply({ event: null });
    await flush();
    assert.equal(h.messages().some((message) => message.type === 'CAPTION_PUBLIC_EVENT'), false);
    assert.equal(h.state.captionPublicClients.has(h.publicPage), false);
    if (mode === 'disconnect') assert.deepEqual(h.messages(), []);
    else assert.equal(h.messages().at(-1).type, 'CAPTION_CONNECTION_ERROR');
  }
});

test('public initial subscription buffer is bounded and never replays a partial overflow', async () => {
  const h = await pendingPublicSubscription();
  for (let seq = 1; seq <= 65; seq += 1) {
    h.offscreen.emit({ type: 'CAPTION_PUBLIC_EVENT', event: { type: 'retract', sessionId: 'session-a', sessionSeq: seq, segmentId: 'segment-a' } });
  }
  h.reply({ event: null });
  await flush();
  assert.equal(h.state.captionPublicClients.has(h.publicPage), false);
  assert.deepEqual(h.messages().map((message) => message.type), ['CAPTION_CONNECTION_ERROR']);
});

test('offscreen handshake restores session state only for the matching document and persists through service worker', async () => {
  const priorState = { activeSessionId: 'session-old', records: [{ segmentId: 'private-1' }] };
  const { connect, portMessages, stored, storageWrites } = loadBackground({ persisted: priorState });
  const port = connect('meet-translator-offscreen', 'chrome-extension://test/offscreen.html');

  port.emit({ type: 'OFFSCREEN_HELLO', bootId: 'boot-new' });
  await flush();
  assert.deepEqual(plain(portMessages.at(-1).message), {
    type: 'CAPTION_STORE_INIT',
    state: priorState,
    publishMicrophoneCaptions: false,
  });

  const nextState = { activeSessionId: null, records: [{ segmentId: 'private-2' }] };
  port.emit({ type: 'CAPTION_STORE_PERSIST', requestId: 'persist-1', bootId: 'boot-new', state: nextState });
  await flush();
  assert.deepEqual(plain(stored.captionStoreState), { ...nextState, offscreenBootId: 'boot-new' });
  assert.equal(storageWrites.length, 1);
  assert.deepEqual(plain(portMessages.at(-1).message), {
    type: 'CAPTION_STORE_PERSISTED', requestId: 'persist-1', ok: true,
  });
});

test('service worker reconnect preserves the live Offscreen document session', async () => {
  const liveState = {
    activeSessionId: 'session-live',
    activeGenerations: { mic: 1, tab: 4 },
    offscreenBootId: 'boot-live',
    records: [],
  };
  const { connect, portMessages } = loadBackground({ persisted: liveState, publishMicrophoneCaptions: true });
  const port = connect('meet-translator-offscreen', 'chrome-extension://test/offscreen.html');
  port.emit({ type: 'OFFSCREEN_HELLO', bootId: 'boot-live' });
  await flush();

  assert.deepEqual(plain(portMessages.at(-1).message), {
    type: 'OFFSCREEN_RECONNECT',
    state: liveState,
    publishMicrophoneCaptions: true,
  });
});

test('private caption records reach only the private correction page', async () => {
  const { connect, context, portMessages } = loadBackground();
  const offscreen = connect('meet-translator-offscreen', 'chrome-extension://test/offscreen.html');
  offscreen.emit({ type: 'OFFSCREEN_HELLO', bootId: 'boot-private' });
  await flush();

  const publicPage = connect('caption-public', 'chrome-extension://test/caption-presenter.html');
  const privatePage = connect('caption-private', 'chrome-extension://test/sidepanel.html');
  assert.equal(context.extensionPageKind(publicPage), 'public');
  assert.equal(context.extensionPageKind(privatePage), 'private');
  await flush();

  const secretRecord = { segmentId: 'seg-1', rawText: 'private ASR draft', sourceText: 'private correction' };
  offscreen.emit({ type: 'CAPTION_PRIVATE_RECORD', record: secretRecord });
  await flush();

  const privateMessages = portMessages.filter((item) => item.port === privatePage).map((item) => plain(item.message));
  const publicMessages = portMessages.filter((item) => item.port === publicPage).map((item) => plain(item.message));
  assert.ok(privateMessages.some((message) => message.type === 'CAPTION_PRIVATE_RECORD' && message.record.rawText === secretRecord.rawText));
  assert.equal(JSON.stringify(publicMessages).includes(secretRecord.rawText), false);
  assert.equal(JSON.stringify(publicMessages).includes(secretRecord.sourceText), false);

  offscreen.emit({
    type: 'CAPTION_PUBLIC_EVENT',
    event: { protocolVersion: 1, type: 'snapshot', sessionId: 'session-1', sessionSeq: 1, records: [] },
  });
  await flush();
  assert.ok(portMessages.some((item) => item.port === publicPage && item.message.type === 'CAPTION_PUBLIC_EVENT'));
});

test('audio queue drop counts are reported only to the private correction page', async () => {
  const { context, state } = loadBackground();
  const privateMessages = [];
  const publicMessages = [];
  state.captionPrivateClients.add({ postMessage(message) { privateMessages.push(plain(message)); } });
  state.captionPublicClients.add({ postMessage(message) { publicMessages.push(plain(message)); } });

  context.reportAudioQueueDrop('OVERLOAD', 1250);

  assert.ok(privateMessages.some((message) => message.type === 'CAPTION_QUEUE_STATUS' &&
    message.status.code === 'OVERLOAD' && message.status.droppedCount === 1 && message.status.droppedAudioMs === 1250));
  assert.equal(publicMessages.some((message) => message.type === 'CAPTION_QUEUE_STATUS'), false);

  context.reportTranslationQueueDrop('TRANSLATION_STALE');
  assert.ok(privateMessages.some((message) => message.type === 'CAPTION_TRANSLATION_QUEUE_STATUS' &&
    message.status.code === 'TRANSLATION_STALE' && message.status.droppedCount === 1));
  assert.equal(publicMessages.some((message) => message.type === 'CAPTION_TRANSLATION_QUEUE_STATUS'), false);
});
