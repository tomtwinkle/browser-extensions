'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const shared = require('../shared.js');

const contentSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function createElement(tagName = 'div', rect = null) {
  return {
    tagName: String(tagName).toUpperCase(),
    style: {},
    attributes: {},
    children: [],
    listeners: {},
    parentElement: null,
    firstChild: null,
    hidden: false,
    textContent: '',
    value: '',
    offsetWidth: 72,
    offsetHeight: 32,
    naturalWidth: 0,
    naturalHeight: 0,
    addEventListener(type, listener) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(listener);
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      this.firstChild = this.children[0] || null;
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
      child.parentElement = null;
      this.firstChild = this.children[0] || null;
    },
    replaceChildren(...children) {
      this.children = [];
      this.firstChild = null;
      children.forEach((child) => this.appendChild(child));
    },
    contains(target) {
      let current = target;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'id') this.id = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    getBoundingClientRect() {
      return rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    click() {
      for (const listener of this.listeners.click || []) {
        listener({
          target: this,
          preventDefault() {},
          stopPropagation() {},
        });
      }
    },
  };
}

function flattenText(node) {
  if (!node) return '';
  return [node.textContent || '', ...node.children.map((child) => flattenText(child))].join(' ');
}

function findFirst(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

function loadContentScript() {
  const html = createElement('html');
  const document = {
    documentElement: html,
    createElement(tagName) {
      return createElement(tagName);
    },
    addEventListener() {},
  };

  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(_message, callback) {
        callback({ ok: true, metadata: { container: 'jpeg', hasExif: false, sections: [] } });
      },
    },
  };

  const context = {
    console: {
      log() {},
      info() {},
      warn() {},
      error() {},
    },
    globalThis: null,
    document,
    window: null,
    chrome,
    fetch: async () => ({
      ok: true,
      url: 'blob:test',
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new Uint8Array().buffer,
    }),
    setTimeout,
    clearTimeout,
  };

  context.window = {
    document,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener() {},
  };
  context.globalThis = context.window;
  context.window.globalThis = context.window;
  context.window.chrome = chrome;
  context.window.fetch = context.fetch;
  context.window.ExifViewerShared = shared;

  vm.runInNewContext(contentSource, context.window, {
    filename: 'content.js',
  });

  return context.window.ExifViewerContent;
}

test('handlePointerMove shows and positions the hover button for visible images', () => {
  const api = loadContentScript();
  const image = createElement('img', {
    left: 120,
    top: 80,
    right: 520,
    bottom: 340,
    width: 400,
    height: 260,
  });
  image.currentSrc = 'https://example.com/photo.jpg';

  api.handlePointerMove({ target: image });
  const ui = api.ensureUi();

  assert.equal(api.state.hoveredImage, image);
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.style.display, 'inline-flex');
  assert.equal(ui.button.style.left, '436px');
  assert.equal(ui.button.style.top, '296px');
});

test('handlePointerMove hides the hover button after leaving the image', () => {
  const api = loadContentScript();
  const image = createElement('img', {
    left: 120,
    top: 80,
    right: 520,
    bottom: 340,
    width: 400,
    height: 260,
  });
  image.currentSrc = 'https://example.com/photo.jpg';

  api.handlePointerMove({ target: image });
  api.handlePointerMove({ target: createElement('div') });

  const ui = api.ensureUi();
  assert.equal(api.state.hoveredImage, null);
  assert.equal(ui.button.hidden, true);
  assert.equal(ui.button.style.display, 'none');
});

test('renderMetadata renders an explicit no-EXIF message when metadata is absent', () => {
  const api = loadContentScript();
  const image = createElement('img', {
    left: 10,
    top: 10,
    right: 210,
    bottom: 110,
    width: 200,
    height: 100,
  });
  image.currentSrc = 'https://example.com/no-exif.jpg';
  image.naturalWidth = 2000;
  image.naturalHeight = 1000;

  api.renderMetadata(image, {
    sourceUrl: image.currentSrc,
    mimeType: 'image/jpeg',
    byteLength: 2048,
    container: 'jpeg',
    hasExif: false,
    sections: [],
  });

  const ui = api.ensureUi();
  assert.equal(ui.backdrop.style.display, 'block');
  assert.match(flattenText(ui.body), /No EXIF metadata was found in this image/);
});

test('renderMetadata adds a Google Maps link when GPS coordinates are available', () => {
  const api = loadContentScript();
  const image = createElement('img', {
    left: 10,
    top: 10,
    right: 210,
    bottom: 110,
    width: 200,
    height: 100,
  });
  image.currentSrc = 'https://example.com/with-gps.jpg';

  api.renderMetadata(image, {
    sourceUrl: image.currentSrc,
    mimeType: 'image/jpeg',
    byteLength: 2048,
    container: 'jpeg',
    hasExif: true,
    sections: [],
    summary: {
      gps: {
        latitude: 35.6534804,
        longitude: 139.7197987,
      },
    },
  });

  const ui = api.ensureUi();
  const link = findFirst(
    ui.body,
    (node) => node.tagName === 'A' && node.getAttribute('href') != null
  );

  assert.ok(link);
  assert.equal(
    link.getAttribute('href'),
    'https://www.google.com/maps/@35.6534804,139.7197987,17.0z'
  );
  assert.equal(link.textContent, 'Open in Google Maps');
});

test('renderMetadata shows summary rows, tooltip labels, and expands XMP decode views', () => {
  const api = loadContentScript();
  const image = createElement('img', {
    left: 10,
    top: 10,
    right: 210,
    bottom: 110,
    width: 200,
    height: 100,
  });
  image.currentSrc = 'https://example.com/detailed.jpg';
  image.naturalWidth = 8192;
  image.naturalHeight = 5464;

  api.renderMetadata(image, {
    sourceUrl: image.currentSrc,
    mimeType: 'image/jpeg',
    byteLength: 2048,
    container: 'jpeg',
    hasExif: true,
    sections: [
      {
        label: 'Image',
        entries: [
          {
            name: 'Model',
            title: 'Camera model',
            description: 'Camera body model recorded when the image was captured.',
            displayValue: 'EOS R5',
          },
        ],
      },
    ],
    summary: {
      camera: { display: 'Canon EOS R5' },
      lens: { display: 'Canon RF24-70mm F2.8 L IS USM · 24-70 mm f/2.8' },
      capture: { display: '2026:04:24 10:00:00 +09:00' },
      exposure: { display: '1/125 s · f/2.8 · ISO 100 · 24 mm · 35mm equiv 24 mm' },
      image: { size: '8192 × 5464', orientation: 'Rotate 90° CW' },
      software: { display: 'Adobe Lightroom Classic' },
      gps: {
        latitude: 35.6534804,
        longitude: 139.7197987,
        altitude: 52,
        timestamp: '2026:04:24 01:23:45 UTC',
      },
    },
    xmp: {
      hasXmp: true,
      packetCount: 1,
      packets: [
        {
          label: 'XMP packet 1',
          byteLength: 128,
          hexDump: '00000000  3C 78 3A 78 6D 70 6D 65 74 61                 |<x:xmpmeta|',
          properties: [
            { path: 'dc:title', value: 'Hover EXIF Viewer' },
            { path: 'rdf:Description@dc:creator', value: 'Tomoki Harada' },
          ],
        },
      ],
    },
  });

  const ui = api.ensureUi();
  assert.match(flattenText(ui.body), /Canon EOS R5/);
  assert.match(flattenText(ui.body), /Canon RF24-70mm F2.8 L IS USM/);
  assert.match(flattenText(ui.body), /Adobe Lightroom Classic/);
  assert.match(flattenText(ui.body), /Camera model/);
  assert.match(flattenText(ui.body), /Model/);

  const tooltipButton = findFirst(
    ui.body,
    (node) =>
      node.tagName === 'BUTTON' &&
      node.textContent === '?' &&
      node.getAttribute('aria-label') === 'Show field explanation'
  );
  assert.ok(tooltipButton);
  assert.equal(tooltipButton.getAttribute('aria-expanded'), 'false');

  tooltipButton.click();

  const tooltip = findFirst(
    ui.body,
    (node) => node.tagName === 'DIV' && node.getAttribute('role') === 'tooltip' && node.hidden === false
  );
  assert.ok(tooltip);
  assert.equal(
    tooltip.textContent,
    'Camera body model recorded when the image was captured.'
  );
  assert.equal(tooltipButton.getAttribute('aria-expanded'), 'true');

  const xmpButton = findFirst(
    ui.body,
    (node) => node.tagName === 'BUTTON' && node.textContent === 'Decode XMP (1)'
  );
  assert.ok(xmpButton);
  xmpButton.click();

  assert.match(flattenText(ui.body), /Binary editor/);
  assert.match(flattenText(ui.body), /Decoded XMP/);
  assert.match(flattenText(ui.body), /dc:title/);
  assert.match(flattenText(ui.body), /Hover EXIF Viewer/);

  const textarea = findFirst(ui.body, (node) => node.tagName === 'TEXTAREA');
  assert.ok(textarea);
  assert.match(textarea.value, /3C 78 3A 78 6D 70 6D 65 74 61/);
});
