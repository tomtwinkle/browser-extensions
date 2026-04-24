'use strict';

importScripts('shared.js');

function normalizeMimeType(contentType) {
  return typeof contentType === 'string' ? contentType.split(';', 1)[0].trim() || null : null;
}

async function readExifFromUrl(url) {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) {
    throw new Error('Unsupported image URL.');
  }

  const response = await fetch(url, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Could not fetch the image (HTTP ${response.status}).`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    sourceUrl: response.url || url,
    mimeType: normalizeMimeType(response.headers.get('content-type')),
    byteLength: bytes.byteLength,
    ...ExifViewerShared.parseExifMetadata(bytes),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'READ_EXIF_FROM_URL') return false;

  readExifFromUrl(message.url)
    .then((metadata) => sendResponse({ ok: true, metadata }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
