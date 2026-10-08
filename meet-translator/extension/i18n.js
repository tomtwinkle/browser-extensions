'use strict';

const MESSAGES = {
  en: {
    // popup
    appTitle:              'Meet Translator',
    statusStopped:         'Stopped',
    statusRunning:         'Running …',
    btnStart:              'Start transcription',
    btnStop:               'Stop transcription',
    openCaptionShare:      'Open caption sharing tab',
    openCorrectionPanel:   'Open private corrections',
    serverUnavailable:     '⚠ Server not connected',
    settingsLink:          '⚙ Settings',
    chatMigrationNotice:   'Legacy automatic chat posting was disabled. Captions are no longer sent to Meet chat.',
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
    errorOpenCorrectionPanel: 'Could not open the private correction panel.',
    // options
    optionsTitle:          '⚙ Meet Translator – Settings',
    sectionServer:         'Local Server',
    labelServerUrl:        'Server URL',
    hintServer:            'Start the local Go server in the server/ directory.',
    labelApiToken:         'Local API token',
    hintApiToken:          "Use the same value as the server's MEET_TRANSLATOR_API_TOKEN environment variable. It is used only by extension pages and the service worker.",
    labelExtensionOrigin:  'Allowed extension origin',
    hintExtensionOrigin:  "Set this exact value in the server's MEET_TRANSLATOR_EXTENSION_ORIGIN environment variable.",
    sectionAudio:          'Audio Source Settings',
    labelAudioSource:      'Capture target',
    optMicOnly:            'Microphone only',
    optBoth:               'Microphone + Tab audio (everyone)',
    optTabOnly:            'Tab audio only (other participants)',
    hintAudio:             'Google Meet does not loop your own voice back to the tab. ' +
                           'To translate your own speech too, choose a setting that includes "Microphone".',
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
    optLangVi:             'Vietnamese (vi)',
    labelTargetLang:       'Target language',
    labelBidirectional:    'Bidirectional translation',
    labelPublishMicrophone: 'Allow microphone captions in the shared tab',
    hintPublishMicrophone: 'Off by default. Capturing microphone audio does not publish it to the shared caption tab.',
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
    msgInvalidServerUrl:   'Server URL must use http://localhost or http://127.0.0.1.',
  },
  ja: {
    // popup
    appTitle:              'Meet Translator',
    statusStopped:         '停止中',
    statusRunning:         '実行中 …',
    btnStart:              '文字起こしを開始',
    btnStop:               '文字起こしを停止',
    openCaptionShare:      '字幕共有用タブを開く',
    openCorrectionPanel:   '非公開の訂正履歴を開く',
    serverUnavailable:     '⚠ サーバー未接続',
    settingsLink:          '⚙ 設定',
    chatMigrationNotice:   '従来のチャット自動投稿を無効にしました。認識結果をMeetチャットへ送信しません。',
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
    errorOpenCorrectionPanel: '非公開の訂正パネルを開けませんでした。',
    // options
    optionsTitle:          '⚙ Meet Translator – 設定',
    sectionServer:         'ローカルサーバー',
    labelServerUrl:        'サーバー URL',
    hintServer:            'server/ ディレクトリのローカルGoサーバーを起動してください。',
    labelApiToken:         'ローカルAPIトークン',
    hintApiToken:          'サーバーの MEET_TRANSLATOR_API_TOKEN 環境変数と同じ値を設定してください。拡張ページとService Workerだけが使用します。',
    labelExtensionOrigin:  '許可する拡張Origin',
    hintExtensionOrigin:  'この値をサーバーの MEET_TRANSLATOR_EXTENSION_ORIGIN 環境変数へそのまま設定してください。',
    sectionAudio:          '音声ソース設定',
    labelAudioSource:      'キャプチャ対象',
    optMicOnly:            '自分のマイクのみ',
    optBoth:               '自分のマイク ＋ 画面の音声（全員）',
    optTabOnly:            '画面の音声のみ（他の参加者）',
    hintAudio:             'Google Meet は自分の声をタブに返さないため、自分の発話も翻訳するには「マイク」を含む設定を選んでください。',
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
    optLangVi:             'ベトナム語 (vi)',
    labelTargetLang:       '翻訳先言語',
    labelBidirectional:    '双方向翻訳',
    labelPublishMicrophone: 'マイク字幕を共有タブへ公開する',
    hintPublishMicrophone: '初期状態はオフです。マイク音声のキャプチャを許可しても、共有タブへの公開は別設定です。',
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
    msgInvalidServerUrl:   'サーバーURLには http://localhost または http://127.0.0.1 を指定してください。',
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
