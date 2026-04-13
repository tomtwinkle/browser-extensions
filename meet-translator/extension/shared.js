(function (root, factory) {
  const shared = factory();
  root.MeetTranslatorShared = shared;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = shared;
  }
})(
  typeof globalThis !== 'undefined' ? globalThis : this,
  function () {
  'use strict';

  const LANG_LABELS = {
    en: 'English',
    ja: '日本語',
    zh: '中文',
    ko: '한국어',
    fr: 'Français',
    de: 'Deutsch',
    es: 'Español',
    pt: 'Português',
    vi: 'Tiếng Việt',
  };

  function langLabel(code) {
    return LANG_LABELS[code] || code || '原文';
  }

  function normalizeSpeakerName(name) {
    const normalized =
      typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    return normalized || null;
  }

  function parseSpeakerNameFromAriaLabel(label) {
    const normalized = normalizeSpeakerName(label);
    if (!normalized) return null;

    const patterns = [
      /^メイン画面の (.+?) さんの共有画面の固定を解除します$/,
      /^(.+?) さんをメイン画面に固定します$/,
      /^(.+?) さんの共有画面をミュート$/,
      /^(.+?) さんのマイクをミュート$/,
      /^Pin (.+?) to the main screen$/i,
      /^Unpin (.+?) from the main screen$/i,
      /^Mute (.+?)(?:['’]s)? microphone$/i,
      /^Mute (.+?)(?:['’]s)? screen share$/i,
    ];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) return normalizeSpeakerName(match[1]);
    }
    return null;
  }

  function detectTextLang(text) {
    const s = text.replace(/\s+/g, '');
    if (!s) return null;
    const n = s.length;
    const count = (re) => (s.match(re) || []).length;

    const kana = count(/[\u3040-\u309f\u30a0-\u30ff\u3000-\u303f]/g);
    const cjk = count(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
    if (kana / n > 0.1 || (kana > 0 && cjk > 0)) return 'ja';

    const ko = count(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g);
    if (ko / n > 0.1) return 'ko';

    if (cjk / n > 0.2) return 'zh';

    const vi = count(/[\u0110\u0111\u01a0\u01a1\u01af\u01b0\u1ea0-\u1ef9]/g);
    if (vi > 0 && vi / n > 0.03) return 'vi';

    return 'en';
  }

  const fillerTokenPattern = [
    'う[ーんむ]*',
    'え[ーと]*',
    'あ[ーの]*',
    'は[ー]+',
    'ふ[ーん]*',
    'ん[ーん]*',
    '\\b(?:uh+|um+|hm+|er+|ah+|oh+|mm+)\\b',
  ].join('|');

  function isFillerOnly(text) {
    if (!text || !text.trim()) return true;
    const fillerRe = new RegExp(
      `^[\\s\\u3000、。,.!?！？…「」]*((?:${fillerTokenPattern})[\\s\\u3000、。,.!?！？…「」]*)+$`,
      'iu'
    );
    return fillerRe.test(text.trim());
  }

  function stripFillers(text) {
    if (!text) return '';
    const fillerRe = new RegExp(
      `[\\s\\u3000、。,.!?！？…「」]*(?:${fillerTokenPattern})[\\s\\u3000、。,.!?！？…「」]*`,
      'giu'
    );
    return text.replace(fillerRe, ' ').replace(/\s+/g, ' ').trim();
  }

  function formatChatMessage(langCode, text, speakerName) {
    const headerParts = [];
    const normalizedSpeaker = normalizeSpeakerName(speakerName);
    if (normalizedSpeaker) headerParts.push(normalizedSpeaker);
    headerParts.push(langLabel(langCode));
    return `[${headerParts.join(' · ')}]\n${text}`;
  }

  function normalizeFeedbackText(text) {
    const normalized = typeof text === 'string' ? text.trim() : '';
    return normalized || null;
  }

  function truncateForDescription(text, maxLen = 80) {
    if (!text) return null;
    return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
  }

  function buildGlossaryFeedbackDescription(feedback) {
    const parts = ['user-feedback'];
    const speakerName = normalizeSpeakerName(feedback?.speakerName);
    const original = truncateForDescription(normalizeFeedbackText(feedback?.original));
    const translation = truncateForDescription(normalizeFeedbackText(feedback?.translation));
    if (speakerName) parts.push(`speaker=${speakerName}`);
    if (original) parts.push(`original=${original}`);
    if (translation) parts.push(`translation=${translation}`);
    return parts.join(' | ');
  }

  function resolveChatPostHandlingMode(hostname, isTopFrame, target) {
    if (hostname === 'meet.google.com' && isTopFrame && target !== 'embedded-chat') {
      return 'meet-top';
    }
    if (hostname === 'chat.google.com' && target === 'embedded-chat') {
      return 'embedded-chat';
    }
    return 'ignore';
  }

  function decodeBase64(base64) {
    if (typeof atob === 'function') return atob(base64);
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(base64, 'base64').toString('binary');
    }
    throw new Error('base64 decode unavailable');
  }

  function encodeBase64(binary) {
    if (typeof btoa === 'function') return btoa(binary);
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(binary, 'binary').toString('base64');
    }
    throw new Error('base64 encode unavailable');
  }

  function base64ToUint8Array(base64) {
    return Uint8Array.from(decodeBase64(base64), (c) => c.charCodeAt(0));
  }

  function uint8ArrayToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return encodeBase64(binary);
  }

  function readWavMetadata(bytes) {
    if (bytes.byteLength < 44) {
      throw new Error('WAV payload is too short');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const readAscii = (offset, length) =>
      String.fromCharCode(...bytes.subarray(offset, offset + length));

    if (readAscii(0, 4) !== 'RIFF' || readAscii(8, 4) !== 'WAVE' ||
        readAscii(12, 4) !== 'fmt ' || readAscii(36, 4) !== 'data') {
      throw new Error('unsupported WAV layout');
    }

    const audioFormat = view.getUint16(20, true);
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const byteRate = view.getUint32(28, true);
    const bitsPerSample = view.getUint16(34, true);
    const dataBytes = view.getUint32(40, true);
    if (audioFormat !== 1) {
      throw new Error(`unsupported WAV encoding: ${audioFormat}`);
    }
    if (dataBytes + 44 > bytes.byteLength) {
      throw new Error('corrupt WAV data length');
    }

    return {
      channels,
      sampleRate,
      byteRate,
      bitsPerSample,
      dataOffset: 44,
      dataBytes,
    };
  }

  function getWavDurationMs(wavB64) {
    const bytes = base64ToUint8Array(wavB64);
    const meta = readWavMetadata(bytes);
    return (meta.dataBytes / meta.byteRate) * 1000;
  }

  function mergeWavBase64Chunks(wavChunks) {
    if (wavChunks.length === 0) {
      throw new Error('no WAV chunks to merge');
    }
    if (wavChunks.length === 1) {
      return wavChunks[0];
    }

    const decoded = wavChunks.map((wavB64) => base64ToUint8Array(wavB64));
    const metas = decoded.map((bytes) => readWavMetadata(bytes));
    const first = metas[0];

    for (const meta of metas.slice(1)) {
      if (meta.channels !== first.channels ||
          meta.sampleRate !== first.sampleRate ||
          meta.bitsPerSample !== first.bitsPerSample) {
        throw new Error('incompatible WAV formats in speaker batch');
      }
    }

    const totalDataBytes = metas.reduce((sum, meta) => sum + meta.dataBytes, 0);
    const merged = new Uint8Array(44 + totalDataBytes);
    merged.set(decoded[0].subarray(0, 44), 0);

    const mergedView = new DataView(merged.buffer);
    mergedView.setUint32(4, 36 + totalDataBytes, true);
    mergedView.setUint32(40, totalDataBytes, true);

    let offset = 44;
    decoded.forEach((bytes, index) => {
      const meta = metas[index];
      merged.set(bytes.subarray(meta.dataOffset, meta.dataOffset + meta.dataBytes), offset);
      offset += meta.dataBytes;
    });

    return uint8ArrayToBase64(merged);
  }

  return {
    base64ToUint8Array,
    buildGlossaryFeedbackDescription,
    detectTextLang,
    formatChatMessage,
    getWavDurationMs,
    isFillerOnly,
    langLabel,
    mergeWavBase64Chunks,
    normalizeFeedbackText,
    normalizeSpeakerName,
    parseSpeakerNameFromAriaLabel,
    readWavMetadata,
    resolveChatPostHandlingMode,
    stripFillers,
    truncateForDescription,
    uint8ArrayToBase64,
  };
  }
);
