# meet-translator ローカルサーバー

Google Meet 自動翻訳チャット拡張機能のバックエンドサーバーです。  
**Go 標準ライブラリのみ**で実装されており、外部パッケージへの依存はありません。

音声文字起こしは [whisper.cpp](https://github.com/ggerganov/whisper.cpp) の HTTP サーバーに委譲し、  
翻訳は [Ollama](https://ollama.com/) 経由のローカル LLM（Qwen2.5 など）で行います。

```
拡張機能 → [Go サーバー :7070]
                ├─ POST /inference  → whisper.cpp サーバー :8080
                └─ POST /api/chat   → Ollama :11434
```

---

## 必要環境

| ツール | 用途 | 入手先 |
|---|---|---|
| Go 1.22+ | このサーバーのビルド | https://go.dev/dl/ |
| whisper.cpp | 音声文字起こし | https://github.com/ggerganov/whisper.cpp |
| Ollama | 翻訳 LLM | https://ollama.com/download |

---

## セットアップ手順

### 1. whisper.cpp のビルドとモデルの取得

```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build && cmake --build build --config Release -j

# モデルをダウンロード（base が推奨バランス）
bash models/download-ggml-model.sh base
```

### 2. Ollama のインストールと翻訳モデルの取得

```bash
# https://ollama.com/download からインストール後:
ollama pull qwen2.5:7b
```

### 3. Go サーバーのビルド

```bash
cd /path/to/browser-extensions/server/
go build -o meet-translator-server .
```

---

## 起動手順

### 方法 A: 自動起動（推奨）— コマンド 1 つ

`WHISPER_BIN` と `WHISPER_MODEL` を指定するだけで、Go サーバーが whisper.cpp を**子プロセスとして自動起動・終了管理**します。

```bash
WHISPER_BIN=./whisper.cpp/build/bin/whisper-server \
WHISPER_MODEL=./whisper.cpp/models/ggml-base.bin \
./meet-translator-server
```

Ctrl+C で Go サーバーを停止すると whisper.cpp も一緒に終了します。

---

### 方法 B: 手動起動（既存インスタンスを利用する場合）

whisper.cpp を別途起動してから Go サーバーを起動します。

```bash
# 1. whisper.cpp HTTP サーバー
cd whisper.cpp
./build/bin/whisper-server -m models/ggml-base.bin --port 8080

# 2. Go サーバー（別ターミナル）
cd browser-extensions/server/
./meet-translator-server
```

---

### Ollama について

どちらの方法でも Ollama は別途起動が必要です（インストール後は自動起動される場合が多いです）。

```bash
ollama serve   # 既に起動中なら不要
```

---

### 環境変数一覧

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `7070` | Go サーバーのリスンポート |
| `WHISPER_BIN` | _(未設定)_ | whisper-server バイナリのパス（設定時は自動起動） |
| `WHISPER_MODEL` | _(未設定)_ | whisper.cpp の .bin モデルファイルのパス |
| `WHISPER_PORT` | `8080` | whisper.cpp のポート（自動起動時のみ有効） |
| `WHISPER_URL` | `http://localhost:8080` | 方法 B: 既存 whisper.cpp サーバーの URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama の URL |

---

## API エンドポイント

### `GET /health`

```json
{ "status": "ok", "whisper_url": "http://localhost:8080", "ollama_url": "http://localhost:11434" }
```

### `POST /transcribe-and-translate`

**リクエスト** (multipart/form-data):

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `audio` | File | ✅ | WAV 形式の音声ファイル |
| `source_lang` | string | | 音声の言語（例: `en`, `ja`）。省略時は Whisper が自動検出 |
| `target_lang` | string | | 翻訳先言語（例: `ja`, `en`）。デフォルト: `ja` |
| `ollama_model` | string | | Ollama モデル名。デフォルト: `qwen2.5:7b` |

**レスポンス**:

```json
{
  "transcription": "Hello, this is a test.",
  "translation": "こんにちは、これはテストです。"
}
```

---

## Whisper モデルサイズの目安

| モデル | VRAM | 速度 | 精度 |
|---|---|---|---|
| `tiny` | ~390MB | ⚡⚡⚡ | △ |
| `base` | ~142MB | ⚡⚡ | ○ |
| `small` | ~466MB | ⚡ | ○ |
| `medium` | ~1.5GB | 普通 | ◎ |
| `large-v3` | ~3.1GB | 遅い | ◎◎ |
