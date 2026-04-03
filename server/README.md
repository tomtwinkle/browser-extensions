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
| Go 1.23+ | このサーバーのビルド | https://go.dev/dl/ |
| cmake + C++ コンパイラ | whisper.cpp のビルド（`make` が自動実行） | OS パッケージマネージャー |
| Ollama | 翻訳 LLM | https://ollama.com/download |

> whisper.cpp は `make` 実行時に自動クローン・ビルドされます。別途インストールは不要です。

---

## セットアップ手順

### 1. Ollama のインストールと翻訳モデルの取得

```bash
# https://ollama.com/download からインストール後:
ollama pull qwen2.5:7b
```

### 2. whisper モデルのダウンロード

```bash
curl -L -o ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

### 3. ビルドと起動

```bash
cd server/
make                         # whisper.cpp を自動クローン・ビルド → Go バイナリ生成

WHISPER_MODEL=./ggml-base.bin ./meet-translator-server
```

起動後、http://localhost:7070/health で疎通確認できます。

---

### 環境変数一覧

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `7070` | Go サーバーのリスンポート |
| `WHISPER_MODEL` | _(必須)_ | whisper ggml モデルファイルのパス |
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
