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
        ├── main.go               HTTP サーバー + Graceful shutdown
        ├── whisper.go            CGo ブリッジ → whisper.cpp (文字起こし)
        ├── llama.go              CGo ブリッジ → llama.cpp (翻訳)
        ├── whisper_bridge.h/cpp  whisper.cpp C++ ブリッジ実装
        ├── llama_bridge.h/cpp    llama.cpp C++ ブリッジ実装
        ├── audio.go              WAV パーサー + 16kHz リサンプラー (標準ライブラリのみ)
        ├── preflight.go          起動前チェック (モデルファイル確認・OS 別案内)
        ├── gpu_cpu.go            CGo LDFLAGS: CPU ビルド
        ├── gpu_cuda.go           CGo LDFLAGS: NVIDIA CUDA ビルド
        ├── gpu_metal.go          CGo LDFLAGS: Apple Metal ビルド
        ├── CMakeLists.txt        whisper.cpp + llama.cpp を共通 ggml でまとめてビルド
        ├── Makefile              GPU 自動検出・cmake + Go ビルド
        └── README.md             サーバー詳細ドキュメント
```

---

## セットアップ

### 1. サーバーをビルド

**前提**: Go 1.23+、cmake、C++ コンパイラ

```bash
cd meet-translator/server/

make              # GPU を自動検出 (macOS → Metal / NVIDIA 検出時 → CUDA / その他 → CPU)
make GPU=metal    # Apple Metal を強制
make GPU=cuda     # NVIDIA CUDA を強制
make GPU=cpu      # CPU のみ
```

`make` は初回に whisper.cpp と llama.cpp を自動クローン・ビルドします。

### 2. モデルをダウンロード

**whisper モデル** (音声認識):

```bash
curl -L -o ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

| モデル | サイズ | 精度 |
|---|---|---|
| `ggml-tiny.bin`     | 75 MB  | △ |
| `ggml-base.bin`     | 142 MB | ○ 推奨 |
| `ggml-small.bin`    | 466 MB | ○ |
| `ggml-medium.bin`   | 1.5 GB | ◎ |
| `ggml-large-v3.bin` | 3.1 GB | ◎◎ |

**llama モデル** (翻訳 LLM, GGUF 形式):

[Qwen2.5-7B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF) などから  
`Qwen2.5-7B-Instruct-Q4_K_M.gguf` (≈ 4.7 GB) を取得してください。

### 3. サーバーを起動

```bash
WHISPER_MODEL=./ggml-base.bin \
LLAMA_MODEL=./Qwen2.5-7B-Instruct-Q4_K_M.gguf \
./meet-translator-server
```

サーバー起動後、http://localhost:7070/health で疎通確認できます。

#### 主な環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `7070` | リスンポート |
| `WHISPER_MODEL` | *(必須)* | whisper GGML モデルファイルパス |
| `LLAMA_MODEL` | *(必須)* | llama GGUF モデルファイルパス |
| `LLAMA_GPU_LAYERS` | `-1` | GPU オフロードレイヤ数 (`0`=CPU only, `-1`=全レイヤ) |
| `WHISPER_GPU_LAYERS` | `-1` | 同上 (whisper 用) |

### 4. 拡張機能を読み込む

1. Chrome / Edge で `chrome://extensions` を開く
2. **デベロッパーモード** を有効にする
3. **「パッケージ化されていない拡張機能を読み込む」** → `meet-translator/extension/` フォルダを選択

### 5. 拡張機能を設定する

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

## 配布 (GitHub Releases)

`v*` タグを push すると GitHub Actions が自動的に 4 プラットフォーム向けバイナリをビルドして  
GitHub Release に公開します。

| バイナリ | ビルド環境 | GPU |
|---|---|---|
| `linux_amd64_cpu` | ubuntu-latest | CPU |
| `darwin_arm64_metal` | macos-latest (Apple Silicon) | Metal |
| `darwin_amd64_metal` | macos-13 (Intel) | Metal |
| `windows_amd64_cpu` | windows-latest | CPU |

```bash
git tag v1.0.0 && git push origin v1.0.0
```

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
