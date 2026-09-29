'use strict';

(function runPrivateCaptionPanel() {
  const history = document.getElementById('history');
  const historyEmpty = document.getElementById('history-empty');
  const status = document.getElementById('status');
  const selectedStatus = document.getElementById('selected-status');
  const sourceText = document.getElementById('source-text');
  const translation = document.getElementById('translation');
  const saveButton = document.getElementById('save-correction');
  const approveButton = document.getElementById('approve-caption');
  const undoButton = document.getElementById('undo-correction');
  const records = new Map();
  const buttons = new Map();
  let selectedSegmentId = null;
  let selectedRecord = null;
  let dirty = false;
  let pending = false;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  function showAudioQueueStatus(queueStatus) {
    if (!['OVERLOAD', 'STALE'].includes(queueStatus?.code)) return false;
    const droppedCount = Number.isSafeInteger(queueStatus.droppedCount) ? queueStatus.droppedCount : 0;
    const droppedSeconds = Number.isFinite(queueStatus.droppedAudioMs)
      ? (queueStatus.droppedAudioMs / 1000).toFixed(1)
      : '0.0';
    const cause = queueStatus.code === 'OVERLOAD' ? '音声処理が混み合ったため' : '古くなった音声のため';
    setStatus(`${cause}累計${droppedCount}件・${droppedSeconds}秒を破棄しました。字幕履歴を確認してください。`, true);
    return true;
  }

  function translationSummary(record) {
    const current = record.translations?.find((item) => item.sourceRevision === record.sourceRevision);
    if (!current || current.state === 'pending') return '翻訳中';
    if (current.state === 'failed') return '翻訳に失敗';
    return current.text || '翻訳なし';
  }

  function reviewReasons(record) {
    const labels = {
      INSUFFICIENT_EVIDENCE: '自動公開の根拠が不足',
      INVALID_VAD_EVIDENCE: '音声区間データを検証できない',
      NO_SPEECH: '音声判定で発話なし',
      CLIPPING: '音声のクリッピングが多い',
      EMPTY_WITH_SPEECH: '音声あり・認識文字なし',
      KNOWN_HALLUCINATION_PHRASE: '定型句のため要確認',
      REPEATED_TRANSCRIPTION: '繰り返し候補',
      LONG_DURATION_SHORT_TRANSCRIPTION: '音声時間に対して短い候補',
      NON_SPEECH_OR_SHORT_TEXT: '短文または非音声表記',
      SHORT_TRANSCRIPTION: '一文字の短い候補',
      LOW_LOGPROB: 'Whisperの対数確率が低い',
      HIGH_NO_SPEECH: 'Whisperの非音声確率が高い',
      LANGUAGE_MISMATCH: '設定言語と異なる可能性',
      FILLER_ONLY: '相槌・フィラーのみ',
    };
    return [...new Set(record.reasonCodes || [])]
      .map((reason) => labels[reason] || '確認が必要')
      .join('、');
  }

  function updateHistoryItem(record) {
    let button = buttons.get(record.segmentId);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-item';
      const source = document.createElement('span');
      const meta = document.createElement('span');
      meta.className = 'meta';
      button.append(source, meta);
      button.addEventListener('click', () => selectRecord(record.segmentId));
      buttons.set(record.segmentId, button);
      history.append(button);
    }
    const [source, meta] = button.children;
    source.textContent = record.sourceText || (record.reasonCodes?.includes('EMPTY_WITH_SPEECH') ? '（音声あり・認識文字なし）' : '');
    meta.textContent = `${record.streamId === 'mic' ? 'マイク' : 'Meet音声'} · ${record.decision === 'accepted' ? (record.published ? '共有中' : '承認済み・非公開') : '未承認'} · ${translationSummary(record)}`;
    button.setAttribute('aria-pressed', String(record.segmentId === selectedSegmentId));
  }

  function updateEditor() {
    const hasSelection = Boolean(selectedRecord);
    const translated = selectedRecord?.translations?.find((item) => item.sourceRevision === selectedRecord.sourceRevision);
    const statusText = !hasSelection
      ? '履歴から発話を選択してください。'
      : selectedRecord.decision === 'accepted'
        ? selectedRecord.published ? '共有中' : '承認済み・現在は非公開'
        : '未承認の候補';
    const reasons = hasSelection ? reviewReasons(selectedRecord) : '';
    selectedStatus.textContent = reasons ? `${statusText}。確認理由: ${reasons}` : statusText;
    translation.textContent = !translated ? '—' : translated.state === 'ready' ? translated.text : translated.state === 'failed' ? '翻訳に失敗しました' : '翻訳中';
    sourceText.disabled = !hasSelection || pending;
    saveButton.disabled = !hasSelection || pending || !dirty || sourceText.value.trim() === '';
    approveButton.disabled = !hasSelection || pending || !selectedRecord.sourceText?.trim() ||
      selectedRecord.decision === 'accepted' && selectedRecord.published;
    undoButton.disabled = !hasSelection || pending || selectedRecord.hasUndo !== true;
  }

  function selectRecord(segmentId) {
    selectedSegmentId = segmentId;
    selectedRecord = records.get(segmentId) || null;
    dirty = false;
    sourceText.value = selectedRecord?.sourceText || '';
    for (const record of records.values()) updateHistoryItem(record);
    updateEditor();
  }

  function applyRecord(record) {
    if (!record || typeof record.segmentId !== 'string') return;
    const current = records.get(record.segmentId);
    if (current && Number.isSafeInteger(current.revision) && Number.isSafeInteger(record.revision) &&
        record.revision < current.revision) return;
    records.set(record.segmentId, record);
    updateHistoryItem(record);
    historyEmpty.hidden = records.size > 0;
    if (selectedSegmentId === record.segmentId) {
      selectedRecord = record;
      // Incoming updates never replace a source draft while the host is editing it.
      if (!dirty) sourceText.value = record.sourceText;
      updateEditor();
    }
  }

  sourceText.addEventListener('input', () => {
    dirty = sourceText.value !== selectedRecord?.sourceText;
    updateEditor();
  });

  const port = chrome.runtime.connect({ name: 'caption-private' });
  port.onMessage.addListener((message) => {
    if (message.type === 'CAPTION_PRIVATE_SNAPSHOT') {
      const snapshot = message.snapshot;
      records.clear();
      for (const button of buttons.values()) button.remove();
      buttons.clear();
      for (const record of snapshot?.records || []) {
        records.set(record.segmentId, record);
        updateHistoryItem(record);
      }
      historyEmpty.hidden = records.size > 0;
      setStatus('接続中');
      showAudioQueueStatus(message.queueStatus);
      if (selectedSegmentId && records.has(selectedSegmentId)) selectRecord(selectedSegmentId);
      return;
    }
    if (message.type === 'CAPTION_PRIVATE_RECORD') {
      applyRecord(message.record);
      return;
    }
    if (message.type === 'CAPTION_QUEUE_STATUS') {
      showAudioQueueStatus(message.status);
      return;
    }
    if (message.type === 'CAPTION_ACTION_RESULT') {
      pending = false;
      const result = message.result;
      if (!result?.ok) {
        setStatus(result?.reason || '操作に失敗しました。', true);
      } else {
        if (result.record) applyRecord(result.record);
        if (message.action === 'correct') {
          selectedRecord = records.get(result.record?.segmentId) || selectedRecord || result.record;
          sourceText.value = selectedRecord?.sourceText || '';
          dirty = false;
          setStatus(result.translationStale
            ? '翻訳中に原文が更新されたため、古い翻訳結果を破棄しました。'
            : '訂正を保存しました。');
        } else if (message.action === 'approve') {
          setStatus(result.record?.published
            ? '承認した字幕を共有しました。'
            : '承認しました。公開条件を満たさない字幕は履歴内に保持します。');
        } else {
          setStatus('訂正を戻しました。');
        }
      }
      updateEditor();
    }
    if (message.type === 'CAPTION_CONNECTION_ERROR') setStatus('字幕ストアに接続できません。', true);
  });
  port.onDisconnect.addListener(() => setStatus('接続が切れました。', true));

  function sendAction(action, payload) {
    if (!selectedRecord || pending) return;
    pending = true;
    setStatus('処理中…');
    updateEditor();
    port.postMessage({
      type: 'CAPTION_ACTION',
      requestId: crypto.randomUUID(),
      action,
      payload: { segmentId: selectedRecord.segmentId, expectedRevision: selectedRecord.revision, ...payload },
    });
  }

  saveButton.addEventListener('click', () => sendAction('correct', { sourceText: sourceText.value }));
  approveButton.addEventListener('click', () => sendAction('approve', {}));
  undoButton.addEventListener('click', () => sendAction('undo', {}));
})();
