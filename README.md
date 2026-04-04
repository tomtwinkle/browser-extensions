# browser-extensions

## meet-translator – Google Meet 自動翻訳チャット

Google Meet の音声をリアルタイムでキャプチャし、文字起こし・翻訳したテキストを  
Meet のチャット欄に自動投稿する Chrome / Edge 拡張機能（Manifest V3）です。

**外部サービスへの依存はゼロ。** whisper.cpp と llama.cpp をローカルサーバーに組み込み、  
すべての推論がマシン上で完結します。

---

## アーキテクチャ

```
[ Google Meet タブ ]
       │  tabCapture (音声)
       ▼
[ offscreen.js ]  ── Web Audio API で音声収集 → WAV (PCM 16-bit) に変換
       │               無音チャンクは VAD でスキップ
       ▼
[ background.js ]  ── fetch POST /transcribe-and-translate
       │
       ▼
[ meet-translator-server ]  ← シングルバイナリ (Go + CGo)
  ├─ whisper.cpp (組み込み) ── 音声文字起こし
  └─ llama.cpp   (組み込み) ── LLM 翻訳
       │
       ▼
[ content.js ]  ── Meet チャット DOM に翻訳テキストを投稿
```

---

## ディレクトリ構成

```
browser-extensions/
└── meet-translator/
    ├── extension/                Chrome / Edge 拡張機能
    │   ├── manifest.json         Manifest V3 設定
    │   ├── background.js         Service Worker: 音声キャプチャ・翻訳制御
    │   ├── offscreen.html/js     Offscreen Document: Web Audio API + WAV エンコーダー
    │   ├── content.js            Content Script: Meet チャット DOM 操作
    │   ├── popup.html/js         ポップアップ UI (開始/停止 + 設定リンク)
    │   ├── options.html/js       設定ページ (サーバー URL・言語・モデル)
    │   └── icons/                アイコン (16 / 32 / 48 / 128 px)
    │
    └── server/                   ローカル推論サーバー
        ├── main.go               HTTP サーバー + Graceful shutdown + CLI フラグ
        ├── whisper.go            CGo ブリッジ → whisper.cpp (文字起こし)
        ├── llama.go              CGo ブリッジ → llama.cpp (翻訳)
        ├── whisper_bridge.h/cpp  whisper.cpp C++ ブリッジ実装
        ├── llama_bridge.h/cpp    llama.cpp C++ ブリッジ実装
        ├── audio.go              WAV パーサー + 16kHz リサンプラー (標準ライブラリのみ)
        ├── model_manager.go      モデルレジストリ・パス解決・自動ダウンロード
        ├── model_download.go     HuggingFace からの GGUF ダウンロード (進捗表示付き)
        ├── model_options.go      モデル別オプション (Thinking モード等)
        ├── ollama_cache.go       Ollama キャッシュからのモデル検索
        ├── server_config.go      設定ファイルの読み書き (初回指定を記憶)
        ├── preflight.go          起動前チェック (モデルファイル確認・OS 別案内)
        ├── translation.go        翻訳ロジック (プロンプト組み立て)
        ├── gpu_cpu.go            CGo LDFLAGS: CPU ビルド
        ├── gpu_cuda.go           CGo LDFLAGS: NVIDIA CUDA ビルド
        ├── gpu_metal.go          CGo LDFLAGS: Apple Metal ビルド
        ├── CMakeLists.txt        whisper.cpp + llama.cpp を共通 ggml でまとめてビルド
        └── Makefile              GPU 自動検出・cmake + Go ビルド
```

---

## セットアップ

### リリース版を使う場合 (推奨)

[GitHub Releases](https://github.com/tomtwinkle/browser-extensions/releases) から  
お使いの OS のアーカイブをダウンロードして展開するだけで動作します。

| ファイル | 対象 |
|---|---|
| `meet-translator-server-linux-amd64.tar.gz` | Linux (x86_64) |
| `meet-translator-server-linux-arm64.tar.gz` | Linux (ARM64) |
| `meet-translator-server-darwin-arm64.tar.gz` | macOS (Apple Silicon) |
| `meet-translator-server-windows-amd64.zip` | Windows (x64) |
| `meet-translator-extension.zip` | Chrome / Edge 拡張機能 |

### ソースからビルドする場合

**前提**: Go 1.23+、cmake 3.21+、C++ コンパイラ

```bash
cd meet-translator/server/

make              # GPU を自動検出 (macOS → Metal / NVIDIA 検出時 → CUDA / その他 → CPU)
make GPU=metal    # Apple Metal を強制
make GPU=cuda     # NVIDIA CUDA を強制
make GPU=cpu      # CPU のみ
```

`make` は初回に whisper.cpp と llama.cpp を自動クローン・cmake ビルドします。

---

## サーバーの起動

### 初回起動（モデルを指定して記憶させる）

```bash
./meet-translator-server \
  --whisper-model base \
  --llama-model qwen3:8b-q4_k_m
```

モデルがローカルに存在しない場合は **HuggingFace から自動ダウンロード** します。  
指定したモデルは設定ファイルに保存され、**次回以降は引数なしで起動できます**。

```bash
./meet-translator-server   # 2 回目以降はそのまま起動
```

### Ollama キャッシュの共有

Ollama で取得済みの GGUF モデルがある場合は自動的に検索して使用します。  
追加ダウンロードは不要です。

### 主な起動オプション

| フラグ | 環境変数 | デフォルト | 説明 |
|---|---|---|---|
| `--port` | `PORT` | `7070` | リスンポート |
| `--whisper-model` | `WHISPER_MODEL` | *(必須)* | whisper モデル名またはファイルパス |
| `--llama-model` | `LLAMA_MODEL` | *(必須)* | llama モデル名またはファイルパス |
| `--llama-gpu-layers` | `LLAMA_GPU_LAYERS` | `-1` | GPU オフロードレイヤ数 (`0`=CPU, `-1`=全レイヤ) |
| `--whisper-gpu-layers` | `WHISPER_GPU_LAYERS` | `-1` | 同上 (whisper 用) |
| `--model-cache-dir` | `MODEL_CACHE_DIR` | OS 標準 | モデルキャッシュディレクトリ |
| `--config` | `MEET_TRANSLATOR_CONFIG` | OS 標準 | 設定ファイルパスの上書き |

> **優先順位**: CLI フラグ > 設定ファイル > 環境変数 > デフォルト値

設定ファイルの場所:

| OS | パス |
|---|---|
| Linux | `~/.config/meet-translator/config.json` |
| macOS | `~/Library/Application Support/meet-translator/config.json` |
| Windows | `%APPDATA%\meet-translator\config.json` |

### ヘルスチェック

```bash
curl http://localhost:7070/health
```

---

## 対応モデル

### whisper モデル (音声認識)

モデル名を `--whisper-model` に指定すると自動ダウンロードします。

| モデル名 | サイズ | 精度 |
|---|---|---|
| `tiny` | 75 MB  | △ |
| `base` | 142 MB | ○ **推奨** |
| `small` | 466 MB | ○ |
| `medium` | 1.5 GB | ◎ |
| `large-v3` | 3.1 GB | ◎◎ |
| `large-v3-turbo` | 809 MB | ◎ (高速) |

### llama モデル (翻訳 LLM)

モデル名を `--llama-model` に指定すると自動ダウンロードします。

| モデル名 | サイズ | 備考 |
|---|---|---|
| `qwen3:0.6b-q4_k_m` | ≈ 0.4 GB | 最軽量、Thinking 対応 |
| `qwen3:1.7b-q4_k_m` | ≈ 1.1 GB | Thinking 対応 |
| `qwen3:4b-q4_k_m`   | ≈ 2.6 GB | **推奨**、Thinking 対応 |
| `qwen3:8b-q4_k_m`   | ≈ 5.2 GB | 高精度、Thinking 対応 |
| `qwen2.5:7b-instruct-q4_k_m` | ≈ 4.7 GB | 安定版 |
| `gemma4:e2b-q4_k_m` | ≈ 1.3 GB | Google Gemma 4 |
| `gemma4:e4b-q4_k_m` | ≈ 2.6 GB | Google Gemma 4 |
| `gemma4:26b-q4_k_m` | ≈ 16 GB | Google Gemma 4 高精度 |

ファイルパスを直接指定することも可能です:

```bash
./meet-translator-server --llama-model /path/to/model.gguf
```

### Thinking モード (Qwen3)

Qwen3 系モデルは **Thinking モード** に対応しています。  
`<think>...</think>` で推論を展開してから翻訳するため精度が向上しますが、レイテンシが増加します。

リクエスト時に `llama_options` フィールドで制御できます:

```json
{"thinking": true}   // Thinking 有効 (Qwen3 のデフォルト)
{"thinking": false}  // Thinking 無効 (高速)
```

---

## 拡張機能のセットアップ

### 開発版 (ソースから読み込む)

1. Chrome / Edge で `chrome://extensions` を開く
2. **デベロッパーモード** を有効にする
3. **「パッケージ化されていない拡張機能を読み込む」** → `meet-translator/extension/` フォルダを選択

### リリース版 (zip から読み込む)

1. `meet-translator-extension.zip` をダウンロードして任意のフォルダに展開
2. Chrome / Edge で `chrome://extensions` を開く
3. **デベロッパーモード** を有効にする
4. **「パッケージ化されていない拡張機能を読み込む」** → 展開したフォルダを選択

### 設定

拡張機能アイコン → **⚙ 設定** を開き、以下を確認・設定します：

| 設定項目 | 説明 |
|---|---|
| サーバー URL | `http://localhost:7070`（デフォルト） |
| 翻訳元言語 | 自動検出 または 言語を指定 |
| 翻訳先言語 | 翻訳後の言語 (デフォルト: 日本語) |
| **「サーバー疎通確認」** ボタン | サーバーに接続できるか確認 |

---

## 使い方

1. `https://meet.google.com/` でミーティングに参加します
2. 拡張機能アイコンをクリックし **「自動翻訳チャット開始」** を押します
3. 音声キャプチャが開始され、約 5 秒ごとに翻訳テキストがチャットへ投稿されます
   - 無音区間は VAD でスキップされ、無駄な推論が行われません
   - チャットパネルが閉じている場合は自動的に開きます
4. **「自動翻訳チャット停止」** で停止します

---

## リリース (GitHub Actions)

`main` ブランチへのマージ時に **release-please** が conventional commits を解析し、  
自動でバージョンを決定して Release PR を作成します。

| コミットプレフィックス | バンプ | 例 |
|---|---|---|
| `feat:` | minor | `0.1.0 → 0.2.0` |
| `fix:` | patch | `0.1.0 → 0.1.1` |

Release PR をマージすると各プラットフォームのバイナリと拡張機能 zip が  
自動ビルドされ GitHub Release にアップロードされます。

---

## CI

プルリクエスト時に以下の 4 プラットフォームでビルド・テストが実行されます：

| プラットフォーム | ランナー |
|---|---|
| linux-amd64 | ubuntu-latest |
| linux-arm64 | ubuntu-24.04-arm |
| macos-arm64 | macos-latest (Apple Silicon) |
| windows-amd64 | windows-latest |

---

## 権限説明

| 権限 | 理由 |
|---|---|
| `tabCapture` | Meet タブの音声ストリームを取得するため |
| `activeTab` | ポップアップ操作時にアクティブタブの ID を取得するため |
| `scripting` | Content Script の動的実行 |
| `storage` | 設定の永続化 |
| `offscreen` | MV3 Service Worker では使用できない AudioContext を Offscreen Document で実行するため |
| `tabs` | 設定ページを開くため |
| `http://localhost:7070/*` | ローカルサーバーへのリクエストを許可するため |
