'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const popupSource = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

class FakeElement {
  constructor() {
    this.checked = false;
    this.disabled = false;
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
}

function loadPopup({
  sidePanel = { open: async () => {} },
  activeTabUrl = 'https://meet.google.com/test-room',
} = {}) {
  const elements = new Map();
  const panelCalls = [];
  const createdTabs = [];
  const updatedTabs = [];
  const sentMessages = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
  };
  if (sidePanel) {
    sidePanel.open = async (options) => {
      panelCalls.push(options);
      return undefined;
    };
  }

  const context = {
    URL,
    document,
    getMessages: () => ({}),
    applyI18n() {},
    MeetTranslatorShared: { migrateLegacyChatSetting: async () => false },
    chrome: {
      storage: { local: {
        get(defaults, callback) {
          callback({ ...defaults, ...(Object.hasOwn(defaults, 'audioSource') ? { audioSource: 'tab-only' } : {}) });
        },
        set(_value, callback) { callback?.(); },
      } },
      runtime: {
        id: 'test-extension',
        getURL: (fileName) => `chrome-extension://test-extension/${fileName}`,
        sendMessage(message, callback) {
          sentMessages.push(message);
          if (message.type === 'GET_STATE') callback({ isActive: false });
          else if (message.type === 'GET_SERVER_INFO') callback({ ok: false });
          else if (message.type === 'START_CAPTURE') callback({ success: true });
        },
        onMessage: { addListener() {} },
        openOptionsPage() {},
      },
      tabs: {
        query(query, callback) {
          const tabs = query.url ? [] : [{ id: 42, url: activeTabUrl }];
          callback?.(tabs);
          return Promise.resolve(tabs);
        },
        create(tab) { createdTabs.push(tab); },
        update(tabId, update) { updatedTabs.push({ tabId, update }); },
      },
      ...(sidePanel ? { sidePanel } : {}),
    },
  };
  context.globalThis = context;
  vm.runInNewContext(popupSource, context, { filename: 'popup.js' });
  return { elements, panelCalls, createdTabs, updatedTabs, sentMessages };
}

test('correction button opens the native side panel for the active tab', async () => {
  const { elements, panelCalls } = loadPopup();

  await elements.get('open-correction-panel').listeners.get('click')();

  assert.equal(panelCalls.length, 1);
  assert.equal(panelCalls[0].tabId, 42);
});

test('correction button keeps a tab fallback when the side panel API is unavailable', async () => {
  const { elements, createdTabs } = loadPopup({ sidePanel: null });

  await elements.get('open-correction-panel').listeners.get('click')();

  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].url, 'chrome-extension://test-extension/sidepanel.html');
});

test('capture accepts the exact Meet host when an isolated test server uses a port', async () => {
  const { elements, sentMessages } = loadPopup({ activeTabUrl: 'https://meet.google.com:49327/device-fixture' });

  await elements.get('toggle-btn').listeners.get('click')();

  const request = sentMessages.find((message) => message.type === 'START_CAPTURE');
  assert.equal(request?.tabId, 42);
  assert.equal(elements.get('toggle-btn').classList.contains('stop'), true);
});

test('capture rejects a lookalike Meet hostname', async () => {
  const { elements, sentMessages } = loadPopup({ activeTabUrl: 'https://meet.google.com.attacker.example/test-room' });

  await elements.get('toggle-btn').listeners.get('click')();

  assert.equal(sentMessages.some((message) => message.type === 'START_CAPTURE'), false);
});
