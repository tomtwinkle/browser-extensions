'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const extensionDir = path.join(__dirname, '..');
const vadSource = fs.readFileSync(path.join(extensionDir, 'offscreen-vad.js'), 'utf8');
const protocolSource = fs.readFileSync(path.join(extensionDir, 'caption-protocol.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(extensionDir, 'caption-store.js'), 'utf8');
const offscreenSource = fs.readFileSync(path.join(extensionDir, 'offscreen.js'), 'utf8');

function createAudioStream(label) {
  const audioTrack = { label, enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } };
  const videoTrack = { stop() { this.readyState = 'ended'; } };
  return {
    label,
    getAudioTracks() { return [audioTrack]; },
    getVideoTracks() { return [videoTrack]; },
    getTracks() { return [audioTrack, videoTrack]; },
  };
}

function loadOffscreen() {
  const messages = [];
  const portListeners = [];
  const streams = {
    tab: createAudioStream('Meet tab'),
    mic: createAudioStream('Microphone'),
  };
  const contexts = [];

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48_000;
      this.state = 'running';
      this.destination = { kind: 'destination' };
      this.sources = [];
      this.processors = [];
      this.closed = false;
      contexts.push(this);
    }
    createMediaStreamSource(stream) {
      const node = {
        stream,
        connections: [],
        connect(target) { this.connections.push(target); },
        disconnect() {},
      };
      this.sources.push(node);
      return node;
    }
    createScriptProcessor(size) {
      const node = {
        size,
        onaudioprocess: null,
        connections: [],
        connect(target) { this.connections.push(target); },
        disconnect() {},
      };
      this.processors.push(node);
      return node;
    }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }

  const context = {
    AudioContext: FakeAudioContext,
    btoa,
    chrome: {
      runtime: {
        connect() {
          const port = {
            onMessage: { addListener(listener) { portListeners.push(listener); } },
            onDisconnect: { addListener() {} },
            postMessage(message) {
              messages.push(message);
              if (message.type === 'OFFSCREEN_HELLO') {
                queueMicrotask(() => portListeners[0]({
                  type: 'CAPTION_STORE_INIT',
                  state: {},
                  publishMicrophoneCaptions: false,
                }));
              } else if (message.type === 'CAPTION_STORE_PERSIST') {
                queueMicrotask(() => portListeners[0]({
                  type: 'CAPTION_STORE_PERSISTED',
                  requestId: message.requestId,
                  ok: true,
                }));
              }
            },
          };
          return port;
        },
      },
      storage: {
        session: {
          async get() { return {}; },
          async set() {},
        },
        local: {
          async get() { return { publishMicrophoneCaptions: false }; },
        },
      },
    },
    console: { info() {}, warn() {}, error() {}, log() {} },
    setTimeout,
    clearTimeout,
    navigator: {
      mediaDevices: {
        async getUserMedia(constraints) {
          return constraints.audio?.mandatory?.chromeMediaSource === 'tab' ? streams.tab : streams.mic;
        },
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(protocolSource, context, { filename: 'caption-protocol.js' });
  vm.runInContext(storeSource, context, { filename: 'caption-store.js' });
  vm.runInContext(vadSource, context, { filename: 'offscreen-vad.js' });
  vm.runInContext(offscreenSource, context, { filename: 'offscreen.js' });
  return { context, contexts, portListeners, messages, streams };
}

function frame(context, amplitude) {
  return vm.runInContext(`new Float32Array(4096).fill(${amplitude})`, context);
}

function processFrames(processor, samples, count) {
  for (let i = 0; i < count; i += 1) {
    processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  }
}

test('offscreen keeps tab and microphone on independent VAD processors and requests', async () => {
  const { context, contexts, portListeners, messages } = loadOffscreen();
  await portListeners[0]({
    type: 'CAPTION_RPC',
    requestId: 'start-1',
    action: 'start-audio',
    payload: {
      audioSource: 'both',
      streamId: 'tab-capture-id',
      sessionId: 'session-1',
      tabId: 99,
      streamGenerations: { mic: 3, tab: 7 },
      publishMicrophoneCaptions: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const audioContext = contexts[0];
  assert.equal(audioContext.sources.length, 2);
  assert.equal(audioContext.processors.length, 2);
  assert.equal(audioContext.sources[0].connections.includes(audioContext.processors[0]), true);
  assert.equal(audioContext.sources[1].connections.includes(audioContext.processors[1]), true);
  assert.equal(audioContext.sources[0].connections.includes(audioContext.sources[1]), false);

  const speech = frame(context, 0.08);
  const silence = frame(context, 0);
  for (const processor of audioContext.processors) processFrames(processor, speech, 4);
  for (const processor of audioContext.processors) processFrames(processor, silence, 18);

  const utterances = messages.filter((message) => message.type === 'AUDIO_DATA');
  assert.deepEqual(utterances.map((message) => message.streamId).sort(), ['mic', 'tab']);
  assert.deepEqual(utterances.map((message) => message.streamGeneration).sort(), [3, 7]);
  assert.ok(utterances.every((message) => message.sessionId === 'session-1'));
  assert.ok(utterances.every((message) => message.evidence.speechDetected === true));
});
