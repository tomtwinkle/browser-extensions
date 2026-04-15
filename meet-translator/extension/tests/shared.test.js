'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  base64ToUint8Array,
  buildGlossaryFeedbackDescription,
  cloneFeedbackContext,
  detectTextLang,
  formatChatMessage,
  getWavDurationMs,
  hasFeedbackContext,
  isFillerOnly,
  mergeFeedbackContext,
  mergeWavBase64Chunks,
  normalizeSpeakerName,
  parseSpeakerNameFromAriaLabel,
  readWavMetadata,
  resolveChatPostHandlingMode,
  resolveContentScriptFrame,
  stripFillers,
} = require('../shared.js');

function createWavBase64(
  samples,
  { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}
) {
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 4, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 4, 'ascii');
  buffer.write('fmt ', 12, 4, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 4, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  samples.forEach((sample, index) => {
    buffer.writeInt16LE(sample, 44 + index * bytesPerSample);
  });

  return buffer.toString('base64');
}

function readPcmSamples(wavB64) {
  const bytes = base64ToUint8Array(wavB64);
  const meta = readWavMetadata(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = [];
  for (let offset = meta.dataOffset; offset < meta.dataOffset + meta.dataBytes; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
}

test('detectTextLang identifies supported language families', () => {
  assert.equal(detectTextLang(''), null);
  assert.equal(detectTextLang('これはテストです'), 'ja');
  assert.equal(detectTextLang('안녕하세요 반갑습니다'), 'ko');
  assert.equal(detectTextLang('这是一个中文句子'), 'zh');
  assert.equal(detectTextLang('Xin chào, tôi rất vui được gặp bạn'), 'vi');
  assert.equal(detectTextLang('Hello from Google Meet'), 'en');
});

test('filler helpers distinguish pure filler from actual speech', () => {
  assert.equal(isFillerOnly('えーと、うーん…'), true);
  assert.equal(isFillerOnly('uh, um...'), true);
  assert.equal(isFillerOnly('えーと、今日は天気がいいですね'), false);
  assert.equal(stripFillers('えーと、今日は天気がいいですね'), '今日は天気がいいですね');
  assert.equal(stripFillers('uh... hello there'), 'hello there');
  assert.equal(stripFillers('there are no fillers here'), 'there are no fillers here');
  assert.equal(stripFillers('うーん、えーと'), '');
});

test('speaker helpers normalize whitespace and parse aria labels', () => {
  assert.equal(normalizeSpeakerName('  Hikaru   Harada  '), 'Hikaru Harada');
  assert.equal(normalizeSpeakerName('   '), null);
  assert.equal(parseSpeakerNameFromAriaLabel('山田 太郎 さんをメイン画面に固定します'), '山田 太郎');
  assert.equal(parseSpeakerNameFromAriaLabel("Mute Hikaru's microphone"), 'Hikaru');
  assert.equal(parseSpeakerNameFromAriaLabel('Not a speaker label'), null);
});

test('formatChatMessage includes speaker and language label when available', () => {
  assert.equal(
    formatChatMessage('ja', '翻訳結果です', 'Hikaru'),
    '[Hikaru · 日本語]\n翻訳結果です'
  );
  assert.equal(
    formatChatMessage('', 'Original text', null),
    '[原文]\nOriginal text'
  );
});

test('resolveChatPostHandlingMode routes original and embedded-chat relay messages', () => {
  assert.equal(resolveChatPostHandlingMode('meet.google.com', true, undefined), 'meet-top');
  assert.equal(
    resolveChatPostHandlingMode('chat.google.com', false, 'embedded-chat'),
    'embedded-chat'
  );
  assert.equal(resolveChatPostHandlingMode('meet.google.com', true, 'embedded-chat'), 'ignore');
  assert.equal(resolveChatPostHandlingMode('meet.google.com', false, undefined), 'ignore');
});

test('resolveContentScriptFrame targets top frame and embedded chat frame correctly', () => {
  assert.equal(resolveContentScriptFrame('POST_TRANSLATION', undefined, 23), 0);
  assert.equal(resolveContentScriptFrame('POST_TRANSLATION', 'embedded-chat', 23), 23);
  assert.equal(resolveContentScriptFrame('POST_TRANSLATION', 'embedded-chat', null), null);
  assert.equal(resolveContentScriptFrame('SHOW_OVERLAY', undefined, 23), 0);
  assert.equal(resolveContentScriptFrame('GET_ACTIVE_SPEAKER', undefined, 23), 0);
  assert.equal(resolveContentScriptFrame('UNKNOWN_MESSAGE', undefined, 23), null);
});

test('buildGlossaryFeedbackDescription keeps useful context and truncates long fields', () => {
  const longOriginal = 'a'.repeat(90);
  const description = buildGlossaryFeedbackDescription({
    speakerName: ' Hikaru  Harada ',
    original: longOriginal,
    translation: 'Translated text',
  });

  assert.match(description, /^user-feedback \| speaker=Hikaru Harada \| original=/);
  assert.match(description, /translation=Translated text$/);
  assert.ok(description.includes(`${'a'.repeat(77)}...`));
});

test('feedback context helpers preserve a stable editable snapshot', () => {
  assert.deepEqual(cloneFeedbackContext({ speakerName: '  Hikaru  ', original: ' hello ', translation: ' ' }), {
    speakerName: 'Hikaru',
    original: 'hello',
    translation: null,
  });
  assert.equal(hasFeedbackContext({ original: 'hello' }), true);
  assert.equal(hasFeedbackContext({ translation: 'translated' }), true);
  assert.equal(hasFeedbackContext({ speakerName: 'Hikaru' }), false);

  const transcriptionOnly = mergeFeedbackContext(null, {
    speakerName: ' Hikaru Harada ',
    original: 'Original text',
  });
  assert.deepEqual(transcriptionOnly, {
    speakerName: 'Hikaru Harada',
    original: 'Original text',
    translation: null,
  });

  const withTranslation = mergeFeedbackContext(transcriptionOnly, {
    speakerName: 'Hikaru Harada',
    translation: 'Translated text',
  });
  assert.deepEqual(withTranslation, {
    speakerName: 'Hikaru Harada',
    original: 'Original text',
    translation: 'Translated text',
  });

  const nextUtterance = mergeFeedbackContext(withTranslation, {
    speakerName: 'Hikaru Harada',
    original: 'Next original text',
  });
  assert.deepEqual(nextUtterance, {
    speakerName: 'Hikaru Harada',
    original: 'Next original text',
    translation: null,
  });
});

test('readWavMetadata and getWavDurationMs inspect standard PCM WAV payloads', () => {
  const wavB64 = createWavBase64(new Array(160).fill(0));
  const bytes = base64ToUint8Array(wavB64);
  const meta = readWavMetadata(bytes);

  assert.equal(meta.channels, 1);
  assert.equal(meta.sampleRate, 16000);
  assert.equal(meta.bitsPerSample, 16);
  assert.equal(meta.dataBytes, 320);
  assert.equal(getWavDurationMs(wavB64), 10);
});

test('mergeWavBase64Chunks concatenates compatible PCM chunks', () => {
  const first = createWavBase64([0, 1, 2, 3]);
  const second = createWavBase64([4, 5]);
  const merged = mergeWavBase64Chunks([first, second]);

  assert.deepEqual(readPcmSamples(merged), [0, 1, 2, 3, 4, 5]);
  assert.equal(
    getWavDurationMs(merged),
    getWavDurationMs(first) + getWavDurationMs(second)
  );
});

test('mergeWavBase64Chunks rejects incompatible WAV formats', () => {
  const mono16k = createWavBase64([0, 1], { sampleRate: 16000 });
  const mono8k = createWavBase64([0, 1], { sampleRate: 8000 });

  assert.throws(
    () => mergeWavBase64Chunks([mono16k, mono8k]),
    /incompatible WAV formats/
  );
});
