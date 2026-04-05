# browser-extensions

## meet-translator – Google Meet 自動翻訳chat

Google Meet の音声をreal-timeでcaptureし、文字起こし・翻訳したtextを  
Meet のchat欄に自動投稿する Chrome / Edge 拡張機能（Manifest V3）です。

**外部serviceへの依存はzero。** whisper.cpp と llama.cpp をlocal serverに組み込み、  
すべての推論がmachine上で完結します。

---

## architecture

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

## directory構成

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

## setup

### release版を使う場合 (推奨)

[GitHub Releases](https://github.com/tomtwinkle/browser-extensions/releases) から  
お使いの OS のarchiveをdownloadして展開するだけで動作します。

| file | 対象 |
|---|---|
| `meet-translator-server-linux-amd64.tar.gz` | Linux (x86_64) |
| `meet-translator-server-linux-arm64.tar.gz` | Linux (ARM64) |
| `meet-translator-server-darwin-arm64.tar.gz` | macOS (Apple Silicon) |
| `meet-translator-server-windows-amd64.zip` | Windows (x64) |
| `meet-translator-extension.zip` | Chrome / Edge 拡張機能 |

### sourceからbuildする場合

**前提**: Go 1.23+、cmake 3.21+、C++ compiler

```bash
cd meet-translator/server/

make              # GPU を自動検出 (macOS → Metal / NVIDIA 検出時 → CUDA / その他 → CPU)
make GPU=metal    # Apple Metal を強制
make GPU=cuda     # NVIDIA CUDA を強制
make GPU=cpu      # CPU のみ
```

`make` は初回に whisper.cpp と llama.cpp を自動clone・cmake buildします。

### リビルド

コード変更後は状況に応じて以下を使い分けてください:

| コマンド | 用途 |
|---|---|
| `make build` | Go ソースのみ変更した場合。cmake をスキップして `go build` のみ再実行 |
| `make rebuild` | bridge C++ ファイル（`whisper_bridge.cpp` 等）を変更した後。cmake を再実行してから `go build`。vendor の clone はスキップ |
| `make distclean && make` | `LLAMA_VERSION` / `WHISPER_VERSION` を変更した場合。vendor を含むすべてを削除して完全再構築 |

```bash
# 例: Go ソースを変更した場合（最速）
make build

# 例: git pull でブリッジ C++ が更新された場合
make rebuild

# 例: llama.cpp / whisper.cpp のバージョンを上げた場合
make distclean
make
```

---

## serverの起動

### 初回起動（modelを指定して記憶させる）

```bash
./meet-translator-server \
  --whisper-model base \
  --llama-model qwen3:8b-q4_k_m
```

modelがlocalに存在しない場合は **HuggingFace から自動download** します。  
指定したmodelは設定fileに保存され、**次回以降は引数なしで起動できます**。

```bash
./meet-translator-server   # 2 回目以降はそのまま起動
```

### Ollama cacheの共有

Ollama で取得済みの GGUF modelがある場合は自動的に検索して使用します。  
追加downloadは不要です。

### 主な起動option

| flag | 環境変数 | default | 説明 |
|---|---|---|---|
| `--port` | `PORT` | `7070` | listen port |
| `--whisper-model` | `WHISPER_MODEL` | *(必須)* | whisper model名またはfile path |
| `--llama-model` | `LLAMA_MODEL` | *(必須)* | llama model名またはfile path |
| `--llama-gpu-layers` | `LLAMA_GPU_LAYERS` | `-1` | GPU offload layers数 (`0`=CPU, `-1`=全layer) |
| `--whisper-gpu-layers` | `WHISPER_GPU_LAYERS` | `-1` | 同上 (whisper 用) |
| `--model-cache-dir` | `MODEL_CACHE_DIR` | OS 標準 | model cache directory |
| `--config` | `MEET_TRANSLATOR_CONFIG` | OS 標準 | 設定file pathの上書き |

> **優先順位**: CLI flag > 設定file > 環境変数 > default値

設定fileの場所:

| OS | path |
|---|---|
| Linux | `~/.config/meet-translator/config.json` |
| macOS | `~/Library/Application Support/meet-translator/config.json` |
| Windows | `%APPDATA%\meet-translator\config.json` |

### health check

```bash
curl http://localhost:7070/health
```

---

## 対応model

### whisper model (音声認識)

model名を `--whisper-model` に指定すると自動downloadします。

| model名 | size | 精度 |
|---|---|---|
| `tiny` | 75 MB  | △ |
| `base` | 142 MB | ○ **推奨** |
| `small` | 466 MB | ○ |
| `medium` | 1.5 GB | ◎ |
| `large-v3` | 3.1 GB | ◎◎ |
| `large-v3-turbo` | 809 MB | ◎ (高速) |

### llama model (翻訳 LLM)

model名を `--llama-model` に指定すると自動downloadします。

| model名 | size | ライセンス | 備考 |
|---|---|---|---|
| `qwen3.5:4b-q4_k_m`   | ≈ 3.2 GB | Apache 2.0 | **推奨**、Thinking 対応 |
| `qwen3.5:9b-q4_k_m`   | ≈ 5.3 GB | Apache 2.0 | 高精度、Thinking 対応 |
| `qwen3.5:0.8b-q4_k_m` | ≈ 0.6 GB | Apache 2.0 | 最軽量、Thinking 対応 |
| `qwen3.5:2b-q4_k_m`   | ≈ 1.4 GB | Apache 2.0 | Thinking 対応 |
| `qwen3:0.6b-q4_k_m` | ≈ 0.4 GB | Apache 2.0 | Thinking 対応 |
| `qwen3:1.7b-q4_k_m` | ≈ 1.1 GB | Apache 2.0 | Thinking 対応 |
| `qwen3:4b-q4_k_m`   | ≈ 2.6 GB | Apache 2.0 | Thinking 対応 |
| `qwen3:8b-q4_k_m`   | ≈ 5.2 GB | Apache 2.0 | Thinking 対応 |
| `qwen2.5:7b-instruct-q4_k_m` | ≈ 4.7 GB | Apache 2.0 | 安定版 |
| `qwen2.5:14b-instruct-q4_k_m` | ≈ 8.7 GB | Apache 2.0 | 高精度版 |
| `calm3:22b-q4_k_m` | ≈ 13 GB | Apache 2.0 | 日英特化 (CyberAgent)、要 16GB VRAM |
| `gemma4:e2b-q4_k_m` | ≈ 1.3 GB | Apache 2.0 | Google Gemma 4 |
| `gemma4:e4b-q4_k_m` | ≈ 2.6 GB | Apache 2.0 | Google Gemma 4 |
| `gemma4:26b-q4_k_m` | ≈ 16 GB | Apache 2.0 | Google Gemma 4 高精度 |

file pathを直接指定することも可能です:

```bash
./meet-translator-server --llama-model /path/to/model.gguf
```

### Thinking mode (Qwen3 / Qwen3.5)

Qwen3 系および Qwen3.5 系modelは **Thinking mode** に対応しています。  
`<think>...</think>` で推論を展開してから翻訳するため精度が向上しますが、latencyが増加します。

request時に `llama_options` fieldで制御できます:

```json
{"thinking": true}   // Thinking 有効 (Qwen3/Qwen3.5 のデフォルト)
{"thinking": false}  // Thinking 無効 (高速)
```

---

## 拡張機能のsetup

### 開発版 (sourceから読み込む)

1. Chrome / Edge で `chrome://extensions` を開く
2. **developer mode** を有効にする
3. **「package化されていない拡張機能を読み込む」** → `meet-translator/extension/` folderを選択

### release版 (zip から読み込む)

1. `meet-translator-extension.zip` をdownloadして任意のfolderに展開
2. Chrome / Edge で `chrome://extensions` を開く
3. **developer mode** を有効にする
4. **「package化されていない拡張機能を読み込む」** → 展開したfolderを選択

### 設定

拡張機能icon → **⚙ 設定** を開き、以下を確認・設定します：

| 設定項目 | 説明 |
|---|---|
| server URL | `http://localhost:7070`（default） |
| 翻訳元言語 | 自動検出 または 言語を指定 |
| 翻訳先言語 | 翻訳後の言語 (default: 日本語) |
| **「server疎通確認」** button | serverに接続できるか確認 |

---

## 使い方

1. `https://meet.google.com/` でmeetingに参加します
2. 拡張機能iconをclickし **「自動翻訳chat開始」** を押します
3. 音声captureが開始され、約 5 秒ごとに翻訳textがchatへ投稿されます
   - 無音区間は VAD でskipされ、無駄な推論が行われません
   - chat panelが閉じている場合は自動的に開きます
4. **「自動翻訳chat停止」** で停止します

---

## release (GitHub Actions)

`main` branchへのmerge時に conventional commits を解析し、  
自動でversionを決定してgit tagと GitHub Release を作成します。

| commit prefix | bump | 例 |
|---|---|---|
| `feat:` | minor | `0.1.0 → 0.2.0` |
| `fix:` | patch | `0.1.0 → 0.1.1` |

releaseが作成されると各platformのbinaryと拡張機能 zip が  
自動buildされ GitHub Release にuploadされます。

---

## CI

pull request時に以下の 2 種類のworkflowが 4 platformで実行されます：

**Test** (`test.yml`): ビルド + Go テスト  
**Execute Test** (`execute-test.yml`): ビルド環境と実行環境を分離し、クリーンなrunnerでバイナリの動作を検証

| platform | runner |
|---|---|
| linux-amd64 | ubuntu-latest |
| linux-arm64 | ubuntu-24.04-arm |
| macos-arm64 | macos-latest (Apple Silicon) |
| windows-amd64 | windows-latest |

---

## 権限説明

| 権限 | 理由 |
|---|---|
| `tabCapture` | Meet tabの音声streamを取得するため |
| `activeTab` | popup操作時にactive tabの ID を取得するため |
| `scripting` | Content Script の動的実行 |
| `storage` | 設定の永続化 |
| `offscreen` | MV3 Service Worker では使用できない AudioContext を Offscreen Document で実行するため |
| `tabs` | 設定pageを開くため |
| `http://localhost:7070/*` | local serverへのrequestを許可するため |

---

## Third-Party Licenses

This software embeds [whisper.cpp](https://github.com/ggerganov/whisper.cpp) **v1.8.4** and
[llama.cpp](https://github.com/ggerganov/llama.cpp) **b8664**, both released under the MIT License.

Models downloaded at runtime (Whisper, Qwen3.5, Qwen3, Qwen2.5-7B/14B, Gemma4) are released
under MIT or Apache 2.0. Qwen2.5-3B is excluded from the registry as it carries a
non-commercial-only license.

See [THIRDPARTY.md](./THIRDPARTY.md) for full copyright notices and model license details.
