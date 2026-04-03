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

### llama モデル (翻訳 LLM, GGUF 形式)

```bash
# Qwen2.5-7B-Instruct (推奨, Q4 量子化 ≈ 4.7GB)
# https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF から取得
```

## 起動

```bash
WHISPER_MODEL=./ggml-base.bin \
LLAMA_MODEL=./Qwen2.5-7B-Instruct-Q4_K_M.gguf \
./meet-translator-server
```

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `7070` | リスンポート |
| `WHISPER_MODEL` | *(必須)* | whisper GGML モデルファイルパス |
| `LLAMA_MODEL` | *(必須)* | llama GGUF モデルファイルパス |
| `LLAMA_GPU_LAYERS` | `-1` | GPU オフロードレイヤ数 (`0`=CPU only, `-1`=全レイヤ) |
| `WHISPER_GPU_LAYERS` | `-1` | 同上 (whisper 用) |
