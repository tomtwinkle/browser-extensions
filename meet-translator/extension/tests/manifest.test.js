'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const manifestDir = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(
  path.join(manifestDir, 'manifest.json'),
  'utf8'
));

test('extension no longer requests Google Chat host access or content injection', () => {
  const manifestText = JSON.stringify(manifest);
  assert.equal(manifestText.includes('chat.google.com'), false);
});

test('short speaker-batch flushing does not request the alarms permission', () => {
  assert.equal(manifest.permissions.includes('alarms'), false);
});

test('caption pages are bundled and use separate public and private Ports', () => {
  const presenterHtml = fs.readFileSync(path.join(manifestDir, 'caption-presenter.html'), 'utf8');
  const presenterJs = fs.readFileSync(path.join(manifestDir, 'caption-presenter.js'), 'utf8');
  const sidepanelHtml = fs.readFileSync(path.join(manifestDir, 'sidepanel.html'), 'utf8');
  const sidepanelJs = fs.readFileSync(path.join(manifestDir, 'sidepanel.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(manifestDir, 'popup.html'), 'utf8');
  const i18nJs = fs.readFileSync(path.join(manifestDir, 'i18n.js'), 'utf8');

  assert.match(presenterHtml, /caption-protocol\.js/);
  assert.match(presenterJs, /name: 'caption-public'/);
  assert.match(sidepanelJs, /name: 'caption-private'/);
  assert.match(popupHtml, /data-i18n="openCaptionShare"/);
  assert.match(popupHtml, /data-i18n="openCorrectionPanel"/);
  assert.match(i18nJs, /openCaptionShare:\s+'字幕共有用タブを開く'/);
  assert.match(i18nJs, /openCorrectionPanel:\s+'非公開の訂正履歴を開く'/);
  assert.doesNotMatch(presenterJs + sidepanelJs, /runtime\.sendMessage\(/);
  assert.doesNotMatch(presenterHtml + sidepanelHtml, /https?:\/\//);
});

test('offscreen persists only through its runtime Port and storage stays with the service worker', () => {
  const offscreenHtml = fs.readFileSync(path.join(manifestDir, 'offscreen.html'), 'utf8');
  const offscreenJs = fs.readFileSync(path.join(manifestDir, 'offscreen.js'), 'utf8');
  const backgroundJs = fs.readFileSync(path.join(manifestDir, 'background.js'), 'utf8');

  assert.match(offscreenHtml, /caption-store\.js/);
  assert.match(offscreenJs, /name: 'meet-translator-offscreen'/);
  assert.doesNotMatch(offscreenJs, /chrome\.storage\./);
  assert.match(backgroundJs, /chrome\.storage\.session\.get\('captionStoreState'\)/);
  assert.match(backgroundJs, /chrome\.storage\.session\.set\(\{ captionStoreState:/);
});
