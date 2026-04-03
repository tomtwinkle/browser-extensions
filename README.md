# browser-extensions

## meet-translator – Google Meet 自動翻訳チャット拡張機能

Google Meetの音声をリアルタイムでキャプチャし、文字起こし・翻訳したテキストをMeetのチャット欄に自動投稿するChrome/Edge拡張機能です（Manifest V3）。

### ディレクトリ構成

```
meet-translator/
├── manifest.json        # Manifest V3 設定
├── background.js        # Service Worker：音声キャプチャ・翻訳制御
├── offscreen.html       # Offscreen Document（Web Audio API 用）
├── offscreen.js         # Offscreen Document スクリプト
├── content.js           # Content Script：Meet チャット DOM 操作
├── popup.html           # ポップアップ UI
├── popup.js             # ポップアップ スクリプト
└── icons/               # 拡張機能アイコン (16/32/48/128 px)
```

### 機能概要

| ファイル | 役割 |
|---|---|
| `background.js` | `chrome.tabCapture.getMediaStreamId()` でタブ音声のストリームIDを取得し、Offscreen Document に渡す。`transcribeAndTranslate(audioData)` 関数（現在はモック）で翻訳テキストを生成し、Content Script に転送する。 |
| `offscreen.js` | `getUserMedia` でタブ音声ストリームをキャプチャ、`ScriptProcessorNode` で音声バッファを収集し、5秒ごとに Background に送信する。 |
| `content.js` | Background から翻訳テキストを受け取り、Meet チャットの DOM（入力欄・送信ボタン）を特定して自動投稿する。 |
| `popup.html/js` | 「自動翻訳チャット開始／停止」ボタンを提供し、Background との通信で処理を制御する。 |

### インストール方法

1. このリポジトリをクローン（またはダウンロード）します。
2. Chrome または Edge を開き、アドレスバーに `chrome://extensions` または `edge://extensions` を入力します。
3. 「デベロッパーモード」を有効にします。
4. 「パッケージ化されていない拡張機能を読み込む」をクリックし、`meet-translator/` フォルダを選択します。

### 使い方

1. `https://meet.google.com/` でミーティングに参加します。
2. ブラウザのツールバーにある拡張機能アイコンをクリックします。
3. **「自動翻訳チャット開始」** ボタンをクリックします。
   - 音声キャプチャが開始され、約 5 秒ごとに翻訳テキストがチャットへ投稿されます。
   - チャットパネルが閉じている場合は自動的に開こうとします。
4. **「自動翻訳チャット停止」** ボタンで停止します。

> **現在の動作（モック）**  
> `transcribeAndTranslate()` 関数は実際のAPIには接続せず、5秒ごとに「テスト翻訳です」と返します。  
> 実際の文字起こし・翻訳APIを利用する場合は `background.js` の `transcribeAndTranslate()` 関数を実装してください。

### 本番実装に向けたTODO

- `background.js` の `transcribeAndTranslate(audioData)` を実際のAPIに置き換える  
  （例：OpenAI Whisper で文字起こし → Google Cloud Translation / DeepL で翻訳）
- `offscreen.js` の `ScriptProcessorNode` を AudioWorklet に移行する（非推奨回避）
- VAD（Voice Activity Detection）を追加して無音区間のAPI呼び出しを削減する
- Meet の UI 変更に合わせて `content.js` の DOM セレクタを適宜更新する

### 権限説明

| 権限 | 理由 |
|---|---|
| `tabCapture` | Meetタブの音声ストリームを取得するため |
| `activeTab` | ポップアップ操作時にアクティブタブのIDを取得するため |
| `scripting` | Content Script の動的実行（将来の拡張用） |
| `storage` | 設定の永続化（将来の拡張用） |
| `offscreen` | MV3 Service Worker では使用できない AudioContext をOffscreen Document で実行するため |
