'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const optionsSource = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');

class FakeElement {
  constructor() {
    this.checked = false;
    this.className = '';
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.listeners = new Map();
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { return this.listeners.get('click')?.(); }
}

function loadOptions() {
  const elements = new Map();
  const writes = [];
  const fetches = [];
  const document = {
    documentElement: { lang: '' },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    querySelectorAll() { return []; },
  };
  const stored = {
    serverUrl: 'http://127.0.0.1:17070', apiToken: '', sourceLang: '', targetLang: 'ja',
    audioSource: 'mic-only', overlayEnabled: true, overlayFormat: 'both', overlayScroll: false,
    bidirectional: false, publishMicrophoneCaptions: false,
  };
  const context = {
    AbortSignal,
    document,
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return { ok: true, status: 200 };
    },
    getMessages: () => ({
      chatMigrationNotice: '', msgSaved: 'Saved', msgChecking: 'Checking', msgServerOk: 'Connected',
      msgServerError: 'Error: ', msgServerFailed: 'Failed: ', msgInvalidServerUrl: 'Invalid URL',
    }),
    applyI18n() {},
    MeetTranslatorShared: {
      migrateLegacyChatSetting: async () => false,
      normalizeLocalServerURL: (value) => new URL(value).origin,
    },
    chrome: {
      runtime: { id: 'test-extension' },
      storage: { local: {
        get(_keys, callback) { callback({ ...stored }); },
        set(value, callback) { writes.push(value); Object.assign(stored, value); callback?.(); },
      } },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(optionsSource, context, { filename: 'options.js' });
  return { elements, fetches, writes };
}

test('settings save uses the shared local URL validator and persists only the local endpoint', () => {
  const { elements, writes } = loadOptions();
  elements.get('server-url').value = 'http://127.0.0.1:19001/';
  elements.get('api-token').value = 'local-test-token';
  elements.get('audio-source').value = 'tab-only';

  elements.get('save-btn').click();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].serverUrl, 'http://127.0.0.1:19001');
  assert.equal(writes[0].apiToken, 'local-test-token');
  assert.equal(writes[0].audioSource, 'tab-only');
});

test('health check uses the shared URL validator and bearer token', async () => {
  const { elements, fetches } = loadOptions();
  elements.get('server-url').value = 'http://127.0.0.1:19002/';
  elements.get('api-token').value = 'health-test-token';

  await elements.get('health-btn').click();

  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, 'http://127.0.0.1:19002/health');
  assert.equal(fetches[0].options.headers.Authorization, 'Bearer health-test-token');
  assert.equal(elements.get('status-msg').textContent, 'Connected');
});
