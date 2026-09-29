'use strict';

(function runCaptionPresenter(root) {
  const { applyPublicEvent } = root.MeetTranslatorCaptionProtocol;
  const connection = document.getElementById('connection');
  const list = document.getElementById('caption-list');
  const emptyState = document.getElementById('empty-state');
  const rows = new Map();
  const state = { sessionId: null, lastSeq: 0, records: new Map(), ended: false };
  let lastHeartbeatAt = 0;
  let lastCaptionUpdateAt = 0;
  let renderTimer = null;

  function setConnection(connected) {
    connection.textContent = connected ? '接続中' : '接続が切れました';
    connection.classList.toggle('disconnected', !connected);
  }

  function applyEvent(event) {
    if (!event) return;
    if (event.type === 'snapshot') {
      state.sessionId = event.sessionId;
      state.lastSeq = 0;
      state.records = new Map();
      state.ended = false;
    }
    if (event.sessionId !== state.sessionId && state.sessionId !== null) return;
    if (state.sessionId === null) state.sessionId = event.sessionId;
    if (applyPublicEvent(state, event)) {
      lastCaptionUpdateAt = Date.now();
      scheduleRender();
    }
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 250);
  }

  function createRow(segmentId) {
    const article = document.createElement('article');
    article.className = 'caption';
    article.dataset.segmentId = segmentId;
    const source = document.createElement('div');
    source.className = 'caption-source';
    const translation = document.createElement('div');
    translation.className = 'caption-translation';
    const status = document.createElement('div');
    status.className = 'caption-state';
    article.append(source, translation, status);
    rows.set(segmentId, { article, source, translation, status });
    return rows.get(segmentId);
  }

  function render() {
    const hiddenByAge = lastCaptionUpdateAt > 0 && Date.now() - lastCaptionUpdateAt >= 8_000;
    const records = hiddenByAge || state.ended ? [] : [...state.records.values()].slice(0, 2);
    const visibleIds = new Set(records.map((record) => record.segmentId));
    for (const [id, row] of rows) {
      if (!visibleIds.has(id)) {
        row.article.remove();
        rows.delete(id);
      }
    }
    for (const record of records) {
      const row = rows.get(record.segmentId) || createRow(record.segmentId);
      if (row.source.textContent !== record.sourceText) row.source.textContent = record.sourceText;
      const translation = record.translations.find((item) => item.state === 'ready' && item.text);
      const pending = record.translations.some((item) => item.state === 'pending');
      const failed = record.translations.some((item) => item.state === 'failed');
      row.translation.textContent = translation?.text || '';
      row.translation.hidden = !translation?.text;
      row.status.textContent = pending ? '翻訳中' : failed ? '翻訳できませんでした' : '';
      row.status.hidden = !row.status.textContent;
      list.append(row.article);
    }
    emptyState.textContent = state.ended
      ? '字幕配信は終了しました'
      : hiddenByAge
        ? '字幕を待っています'
        : records.length ? '' : '字幕を待っています';
    emptyState.hidden = records.length > 0;
  }

  const port = chrome.runtime.connect({ name: 'caption-public' });
  port.onMessage.addListener((message) => {
    if (message.type === 'CAPTION_PUBLIC_SNAPSHOT') {
      if (message.event) applyEvent(message.event);
      else render();
      return;
    }
    if (message.type === 'CAPTION_PUBLIC_EVENT') {
      applyEvent(message.event);
      return;
    }
    if (message.type === 'CAPTION_HEARTBEAT') {
      lastHeartbeatAt = Date.now();
      setConnection(true);
      return;
    }
    if (message.type === 'CAPTION_CONNECTION_ERROR') setConnection(false);
  });
  port.onDisconnect.addListener(() => setConnection(false));

  setInterval(() => {
    if (lastHeartbeatAt && Date.now() - lastHeartbeatAt >= 5_000) setConnection(false);
    if (lastCaptionUpdateAt && Date.now() - lastCaptionUpdateAt >= 8_000) scheduleRender();
  }, 250);
  render();
})(globalThis);
