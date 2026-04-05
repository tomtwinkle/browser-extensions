# meet-translator ローカルサーバー

whisper.cpp と llama.cpp を Go バイナリに直接組み込んだ**シングルバイナリ**サーバーです。  
外部サービスへの依存は**ゼロ**。モデルファイルを置いて実行するだけで動きます。

```
拡張機能 → [meet-translator-server]
               ├─ whisper.cpp (組み込み): 音声文字起こし
               └─ llama.cpp   (組み込み): LLM 翻訳
```

## 必要環境

| ツール | 用途 | 入手先 |
|---|---|---|
| Go 1.23+ | ビルド | https://go.dev/dl/ |
| cmake + C++ コンパイラ | whisper.cpp / llama.cpp のビルド | OS パッケージマネージャー |

> `make` を実行すると whisper.cpp と llama.cpp が自動クローン・ビルドされます。

## ビルド

```bash
cd server/

make                  # GPU を自動検出 (macOS=Metal, NVIDIA検出時=CUDA, それ以外=CPU)
make GPU=metal        # Apple Metal を強制
make GPU=cuda         # NVIDIA CUDA を強制
make GPU=cpu          # CPU のみ
```

## モデルのダウンロード

### whisper モデル (音声認識)

```bash
curl -L -o ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

| モデル | サイズ | 精度 |
|---|---|---|
| `ggml-tiny.bin`   | 75 MB  | △ |
| `ggml-base.bin`   | 142 MB | ○ 推奨 |
| `ggml-small.bin`  | 466 MB | ○ |
| `ggml-medium.bin` | 1.5 GB | ◎ |
| `ggml-large-v3.bin` | 3.1 GB | ◎◎ |

### llama モデル (翻訳 LLM)

モデル名を指定すると **HuggingFace から自動ダウンロード** します。  
Ollama でダウンロード済みの GGUF があれば自動的に検索・再利用します。

| モデル名 | サイズ | 備考 |
|---|---|---|
| `qwen3.5:4b-q4_k_m`   | ≈ 3.2 GB | **推奨**、Thinking 対応 |
| `qwen3.5:2b-q4_k_m`   | ≈ 1.4 GB | 軽量、Thinking 対応 |
| `qwen3.5:0.8b-q4_k_m` | ≈ 0.6 GB | 最軽量、Thinking 対応 |
| `qwen3.5:9b-q4_k_m`   | ≈ 5.3 GB | 高精度、Thinking 対応 |
| `qwen3:4b-q4_k_m`     | ≈ 2.6 GB | Thinking 対応 |
| `qwen3:8b-q4_k_m`     | ≈ 5.2 GB | Thinking 対応 |
| `qwen2.5:7b-instruct-q4_k_m` | ≈ 4.7 GB | 安定版 |

> **注意**: Qwen3.5 アーキテクチャは llama.cpp **b8664 以降**が必要です。  
> それ以前のバージョンでは `unknown model architecture: 'qwen35'` エラーになります。

GGUF ファイルを直接指定することも可能です:

```bash
./meet-translator-server --llama-model /path/to/model.gguf
```

## 起動

```bash
# モデル名を指定して初回起動（自動ダウンロード + 設定保存）
./meet-translator-server \
  --whisper-model base \
  --llama-model qwen3.5:4b-q4_k_m

# 2 回目以降は引数なしで起動可能
./meet-translator-server
```

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `7070` | リスンポート |
| `WHISPER_MODEL` | *(必須)* | whisper モデル名またはファイルパス |
| `LLAMA_MODEL` | *(必須)* | llama モデル名またはファイルパス |
| `LLAMA_GPU_LAYERS` | `-1` | GPU オフロードレイヤ数 (`0`=CPU only, `-1`=全レイヤ) |
| `WHISPER_GPU_LAYERS` | `-1` | 同上 (whisper 用) |
| `MODEL_CACHE_DIR` | OS 標準 | モデルキャッシュディレクトリ |
