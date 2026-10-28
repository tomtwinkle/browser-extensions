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
  const telemetryExportButton = document.getElementById('prepare-telemetry-export');
  const telemetryDownloadLink = document.getElementById('download-telemetry-export');
  const loadControlStatus = document.getElementById('load-control-status');
  const resumeTranslationsButton = document.getElementById('resume-translations');
  const records = new Map();
  const buttons = new Map();
  let selectedSegmentId = null;
  let selectedRecord = null;
  let dirty = false;
  let pending = false;
  let telemetryObjectUrl = null;
  let pendingTelemetryRequestId = null;

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
    const latestReason = queueStatus.code === 'OVERLOAD' ? '音声処理の混雑' : '音声の期限切れ';
    setStatus(
      `音声を破棄した件数は累計${droppedCount}件・合計${droppedSeconds}秒です。` +
        `最新の区分は「${latestReason}」。字幕履歴を確認してください。`,
      true
    );
    return true;
  }

  function showTranslationQueueStatus(queueStatus) {
    if (!['TRANSLATION_OVERLOAD', 'TRANSLATION_STALE', 'TRANSLATION_PAUSED'].includes(queueStatus?.code)) return false;
    const droppedCount = Number.isSafeInteger(queueStatus.droppedCount) ? queueStatus.droppedCount : 0;
    const latestReason = queueStatus.code === 'TRANSLATION_OVERLOAD'
      ? '翻訳処理の混雑'
      : queueStatus.code === 'TRANSLATION_PAUSED'
        ? '負荷制御による一時停止'
        : '翻訳の期限切れ・原文/セッション更新';
    const heldCount = Number.isSafeInteger(queueStatus.heldCount) ? queueStatus.heldCount : 0;
    const rejectedCount = Number.isSafeInteger(queueStatus.rejectedCount) ? queueStatus.rejectedCount : 0;
    setStatus(
      `翻訳を開始せずに破棄した件数は累計${droppedCount}件です。` +
        `保留${heldCount}件・停止中の受付拒否${rejectedCount}件。` +
        `最新の区分は「${latestReason}」。原文は履歴に保持しました。`,
      queueStatus.code !== 'TRANSLATION_PAUSED'
    );
    return true;
  }

  function showLoadControlStatus(value = {}) {
    const messages = [];
    if (!value.memorySourceAvailable) {
      messages.push('メモリ状態を取得できないため、メモリ圧迫時の自動停止とモデル解放は利用できません。');
    }
    if (value.stopAsr) messages.push('ASR受付を一時停止しています。');
    if (value.inferenceBlocked) messages.push('翻訳推論の受付を停止しています。');
    else if (value.translationsPaused) messages.push('処理負荷のため翻訳を一時停止しています。');
    else if (value.experimentsStopped) messages.push('高負荷のため実験・診断処理を停止しています。');
    else messages.push('翻訳の一時停止はありません。');
    if (value.translationsPaused && value.resumeEligible) {
      messages.push('復帰条件を満たしました。ボタン操作で翻訳を再開できます。');
    } else if (value.translationsPaused) {
      messages.push('復帰条件を確認中です。再開時に過去の保留発話は積み直しません。');
    }
    loadControlStatus.textContent = messages.join(' ');
    resumeTranslationsButton.disabled = !(value.translationsPaused && value.resumeEligible);
  }

  function translationSummary(record) {
    const current = record.translations?.find((item) => item.sourceRevision === record.sourceRevision);
    if (current?.state === 'paused') return '処理負荷のため翻訳を一時停止';
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
    translation.textContent = !translated ? '—'
      : translated.state === 'ready' ? translated.text
        : translated.state === 'failed' ? '翻訳に失敗しました'
          : translated.state === 'paused' ? '処理負荷のため翻訳を一時停止'
            : '翻訳中';
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
      showTranslationQueueStatus(message.translationQueueStatus);
      showLoadControlStatus(message.loadControlStatus);
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
    if (message.type === 'CAPTION_TRANSLATION_QUEUE_STATUS') {
      showTranslationQueueStatus(message.status);
      return;
    }
    if (message.type === 'CAPTION_LOAD_CONTROL_STATUS') {
      showLoadControlStatus(message.status);
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
          if (result.translationStale) {
            setStatus('翻訳中に原文が更新されたため、古い翻訳結果を破棄しました。', true);
          } else if (result.translationPaused) {
            setStatus('訂正を保存しました。処理負荷のため翻訳を一時停止し、原文を履歴に保持しています。');
          } else if (result.translationFailed) {
            setStatus('訂正を保存しましたが、翻訳に失敗しました。原文は履歴に保持されています。', true);
          } else {
            setStatus('訂正を保存しました。');
          }
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
    if (message.type === 'EVALUATION_TELEMETRY_EXPORT') {
      if (message.requestId !== pendingTelemetryRequestId) return;
      pendingTelemetryRequestId = null;
      const payload = {
        ...message.snapshot,
        caseTimings: message.caseTimings,
        privacy: { transcriptText: false, audio: false, credentials: false },
      };
      if (telemetryObjectUrl) URL.revokeObjectURL(telemetryObjectUrl);
      telemetryObjectUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      }));
      telemetryDownloadLink.href = telemetryObjectUrl;
      telemetryDownloadLink.download = `meet-translator-telemetry-${Date.now()}.json`;
      telemetryDownloadLink.hidden = false;
      setStatus('本文・音声を含まない評価テレメトリを準備しました。保存先はignored領域にしてください。');
    }
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
  telemetryExportButton.addEventListener('click', () => {
    telemetryDownloadLink.hidden = true;
    setStatus('評価テレメトリを準備しています…');
    pendingTelemetryRequestId = crypto.randomUUID();
    port.postMessage({
      type: 'EVALUATION_TELEMETRY_EXPORT_REQUEST',
      requestId: pendingTelemetryRequestId,
    });
  });
  resumeTranslationsButton.addEventListener('click', () => {
    if (resumeTranslationsButton.disabled) return;
    resumeTranslationsButton.disabled = true;
    port.postMessage({ type: 'CAPTION_LOAD_CONTROL_RESUME' });
  });
})();
