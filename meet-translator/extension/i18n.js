'use strict';

const MESSAGES = {
  en: {
    // popup
    appTitle:              'Meet Auto-Translate Chat',
    statusStopped:         'Stopped',
    statusRunning:         'Running …',
    btnStart:              'Start Auto-Translate Chat',
    btnStop:               'Stop Auto-Translate Chat',
    serverUnavailable:     '⚠ Server not connected',
    settingsLink:          '⚙ Settings',
    footerOnly:            'Google Meet only',
    errorMeetTab:          'Please open the extension on a Google Meet tab.',
    errorMicDenied:        'Microphone access is denied.\n' +
                           'Chrome Settings → Privacy and security → Site settings → Microphone\n' +
                           'to unblock this extension.',
    errorMicRejected:      'Microphone access was denied.\n' +
                           'Chrome Settings → Privacy and security → Site settings → Microphone\n' +
                           'to allow this extension.',
    errorServerDisconnected: 'Connection to server lost. Auto-translate stopped.',
    errorStartFailed:      'Failed to start. Please make sure the server is running.',
    errorStopFailed:       'Failed to stop.',
    // options
    optionsTitle:          '⚙ Meet Auto-Translate Chat – Settings',
    sectionServer:         'Local Server',
    labelServerUrl:        'Server URL',
    hintServer:            'Start the FastAPI server in the server/ directory.',
    sectionAudio:          'Audio Source Settings',
    labelAudioSource:      'Capture target',
    optMicOnly:            'Microphone only',
    optBoth:               'Microphone + Tab audio (everyone)',
    optTabOnly:            'Tab audio only (other participants)',
    hintAudio:             'Google Meet does not loop your own voice back to the tab. ' +
                           'To translate your own speech too, choose a setting that includes "Microphone".',
    sectionChat:           'Chat Post Settings',
    labelChatEnabled:      'Auto-post translation to chat',
    labelChatFormat:       'Post format',
    optChatBoth:           'Original + Translation (with labels, 2 posts)',
    optChatTranslation:    'Translation only',
    optChatTranscription:  'Original only',
    hintChatFormat:        '"Original + Translation" posts the original right after Whisper transcribes, ' +
                           'then posts the translation once complete.',
    sectionLang:           'Language Settings',
    labelSourceLang:       'Source language',
    optLangAuto:           'Auto-detect',
    optLangEn:             'English (en)',
    optLangJa:             'Japanese (ja)',
    optLangZh:             'Chinese (zh)',
    optLangKo:             'Korean (ko)',
    optLangFr:             'French (fr)',
    optLangDe:             'German (de)',
    optLangEs:             'Spanish (es)',
    optLangPt:             'Portuguese (pt)',
    labelTargetLang:       'Target language',
    labelBidirectional:    'Bidirectional translation',
    hintBidirectional:     'When the spoken language matches the target language, it is automatically translated back to the source language instead. Useful for multilingual meetings.',
    sectionDisplay:        'Display Settings',
    labelOverlayEnabled:   'Show overlay on Meet screen',
    hintOverlay:           'Displays original and translated text as subtitles on the Meet screen. Does not block clicks.',
    labelOverlayFormat:    'Display content',
    optOverlayBoth:        'Original + Translation',
    optOverlayTranslation: 'Translation only',
    optOverlayTranscription: 'Original only',
    labelOverlayScroll:    'Scroll mode (Niconico-style, right to left)',
    btnSave:               'Save',
    btnHealthCheck:        'Check server connection',
    msgSaved:              'Saved ✓',
    msgChecking:           'Checking…',
    msgServerOk:           'Server connection OK ✓',
    msgServerError:        'Error: HTTP ',
    msgServerFailed:       'Connection failed: ',
  },
  ja: {
    // popup
    appTitle:              'Meet 自動翻訳チャット',
    statusStopped:         '停止中',
    statusRunning:         '実行中 …',
    btnStart:              '自動翻訳チャット開始',
    btnStop:               '自動翻訳チャット停止',
    serverUnavailable:     '⚠ サーバー未接続',
    settingsLink:          '⚙ 設定',
    footerOnly:            'Google Meet 専用',
    errorMeetTab:          'Google Meet タブで拡張機能を起動してください。',
    errorMicDenied:        'マイクへのアクセスが拒否されています。\n' +
                           'Chrome の設定 → プライバシーとセキュリティ → サイトの設定 → マイク\n' +
                           'から、この拡張機能のブロックを解除してください。',
    errorMicRejected:      'マイクへのアクセスを拒否しました。\n' +
                           'Chrome の設定 → プライバシーとセキュリティ → サイトの設定 → マイク\n' +
                           'から拡張機能の許可を確認してください。',
    errorServerDisconnected: 'サーバーへの接続が切断されました。自動翻訳を停止しました。',
    errorStartFailed:      '開始に失敗しました。サーバーが起動しているか確認してください。',
    errorStopFailed:       '停止に失敗しました。',
    // options
    optionsTitle:          '⚙ Meet 自動翻訳チャット – 設定',
    sectionServer:         'ローカルサーバー',
    labelServerUrl:        'サーバー URL',
    hintServer:            'server/ ディレクトリの FastAPI サーバーを起動してください。',
    sectionAudio:          '音声ソース設定',
    labelAudioSource:      'キャプチャ対象',
    optMicOnly:            '自分のマイクのみ',
    optBoth:               '自分のマイク ＋ 画面の音声（全員）',
    optTabOnly:            '画面の音声のみ（他の参加者）',
    hintAudio:             'Google Meet は自分の声をタブに返さないため、自分の発話も翻訳するには「マイク」を含む設定を選んでください。',
    sectionChat:           'チャット投稿設定',
    labelChatEnabled:      '翻訳結果をチャットに自動投稿する',
    labelChatFormat:       '投稿形式',
    optChatBoth:           '原文＋翻訳（各ラベル付き・2回投稿）',
    optChatTranslation:    '翻訳のみ',
    optChatTranscription:  '原文のみ',
    hintChatFormat:        '「原文＋翻訳」では Whisper の文字起こし直後に原文を投稿し、翻訳完了後に翻訳を続けて投稿します。',
    sectionLang:           '言語設定',
    labelSourceLang:       '翻訳元言語',
    optLangAuto:           '自動検出',
    optLangEn:             '英語 (en)',
    optLangJa:             '日本語 (ja)',
    optLangZh:             '中国語 (zh)',
    optLangKo:             '韓国語 (ko)',
    optLangFr:             'フランス語 (fr)',
    optLangDe:             'ドイツ語 (de)',
    optLangEs:             'スペイン語 (es)',
    optLangPt:             'ポルトガル語 (pt)',
    labelTargetLang:       '翻訳先言語',
    labelBidirectional:    '双方向翻訳',
    hintBidirectional:     '発話が翻訳先言語と同じ言語だった場合、翻訳元言語に自動的に逆翻訳します。多言語が混在するミーティングに便利です。',
    sectionDisplay:        '表示設定',
    labelOverlayEnabled:   'Meet 画面にオーバーレイ表示する',
    hintOverlay:           '原文と翻訳を画面下部に字幕として表示します。クリックの妨げにはなりません。',
    labelOverlayFormat:    '表示内容',
    optOverlayBoth:        '原文＋翻訳',
    optOverlayTranslation: '翻訳のみ',
    optOverlayTranscription: '原文のみ',
    labelOverlayScroll:    'スクロール表示（ニコニコ動画風・右から左へ流れる）',
    btnSave:               '保存',
    btnHealthCheck:        'サーバー疎通確認',
    msgSaved:              '保存しました ✓',
    msgChecking:           '確認中…',
    msgServerOk:           'サーバー接続 OK ✓',
    msgServerError:        'エラー: HTTP ',
    msgServerFailed:       '接続失敗: ',
  },
};

/**
 * sourceLang から UI 表示言語を決める。
 * 'ja' のときのみ日本語、それ以外（空文字＝自動検出を含む）は英語（デフォルト）。
 */
function resolveUiLang(sourceLang) {
  return sourceLang === 'ja' ? 'ja' : 'en';
}

/** sourceLang に対応するメッセージ辞書を返す。 */
function getMessages(sourceLang) {
  return MESSAGES[resolveUiLang(sourceLang)];
}

/**
 * data-i18n 属性を持つ要素のテキストを一括置換する。
 * optgroup の label 属性は data-i18n-label で指定する。
 */
function applyI18n(msgs) {
  const lang = msgs === MESSAGES['ja'] ? 'ja' : 'en';
  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (msgs[key] !== undefined) el.textContent = msgs[key];
  });

  document.querySelectorAll('[data-i18n-label]').forEach((el) => {
    const key = el.dataset.i18nLabel;
    if (msgs[key] !== undefined) el.label = msgs[key];
  });
}
