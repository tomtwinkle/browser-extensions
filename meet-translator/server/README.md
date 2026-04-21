# meet-translator ローカルサーバー

whisper.cpp / llama.cpp を Go バイナリに直接組み込んだローカルサーバーです。
Kotoba-Whisper や GGUF LLM は同梱 backend で動作し、SenseVoice / WhisperX / Apple Silicon 向けの MLX 対応モデルを選んだ場合だけローカル Python worker を起動します。

```
拡張機能 → [meet-translator-server]
               ├─ whisper.cpp / Python worker: 音声文字起こし
               └─ llama.cpp / MLX worker   : LLM 翻訳
```

## 必要環境

| ツール | 用途 | 入手先 |
|---|---|---|
| Go 1.23+ | ビルド | https://go.dev/dl/ |
| cmake + C++ コンパイラ | whisper.cpp / llama.cpp のビルド | OS パッケージマネージャー |
| Python 3.10+ (optional) | SenseVoice / WhisperX バックエンド、Apple Silicon 向け MLX Bonsai | https://www.python.org/downloads/ |
| ffmpeg (optional) | SenseVoice / WhisperX の音声デコード | https://ffmpeg.org/download.html |

> `make` を実行すると whisper.cpp と llama.cpp が自動クローン・ビルドされ、
> 標準バイナリ (`server`) と PrismML バイナリ (`server-prism`) の両方を生成します。
> `git pull` 後に pin している upstream バージョンが変わっていた場合も、次の `make` / `make test` で vendor checkout を自動更新します。

## ビルド

```bash
cd server/

make                  # GPU を自動検出して server + server-prism を両方ビルド
make all GPU=metal    # Apple Metal を強制して両バリアントをビルド
make all GPU=cuda     # NVIDIA CUDA を強制して両バリアントをビルド
make all GPU=cpu      # CPU のみで両バリアントをビルド
make build GPU=cpu    # 標準バイナリのみ
make prism GPU=cpu    # PrismML バイナリのみ（bonsai-8b / server-prism 用）
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
| `ggml-base.bin`   | 142 MB | ○ |
| `ggml-small.bin`  | 466 MB | ○ |
| `ggml-medium.bin` | 1.5 GB | ◎ |
| `ggml-large-v3.bin` | 3.1 GB | ◎◎ |
| `ggml-large-v3-turbo.bin` | 809 MB | ◎ default floor |
| `ggml-kotoba-whisper-v2.0.bin` | 3.1 GB | ◎◎ JA-focused |
| `ggml-kotoba-whisper-v2.0-q5_0.bin` | ≈ 1.0 GB | ◎ JA-focused (quantized) |

モデル名でも指定できます: `large-v3-turbo`, `kotoba-whisper`, `kotoba-whisper-q5_0`

Python バックエンドも `--whisper-model` で選択できます:

| モデル名 | 実装 | 備考 |
|---|---|---|
| `sensevoice` / `sensevoice-small` | FunASR SenseVoiceSmall | 高速な多言語 ASR、ローカル Python worker |
| `whisperx` / `whisperx-large-v3` | WhisperX (faster-whisper backend) | VAD 付き、多言語 ASR、ローカル Python worker |
| `sensevoice:<model-ref>` | FunASR | 任意の SenseVoice 系 model ref |
| `whisperx:<model-name>` | WhisperX | 任意の WhisperX / faster-whisper モデル名 |

> **Python バックエンドの準備**:
> `python3 -m pip install -r ./python/requirements-asr.txt`
> `ffmpeg` をインストールし、PATH から参照できるようにしてください。

### llama モデル (翻訳 LLM)

モデル名を指定すると **HuggingFace から自動ダウンロード** します。  
Ollama でダウンロード済みの GGUF があれば自動的に検索・再利用します。

| モデル名 | サイズ | 備考 |
|---|---|---|
| `qwen3.5:0.8b-q4_k_m` | ≈ 0.6 GB | default floor、Thinking 対応 |
| `bonsai-8b`           | ≈ 1.15 GB / MLX repo | 最初の step-up、Thinking 対応。Apple Silicon では MLX 自動選択、その他は PrismML |
| `bonsai-4b`           | MLX repo | Apple Silicon 専用、Thinking 対応 |
| `bonsai-1.7b`         | MLX repo | Apple Silicon 専用、Thinking 対応 |
| `qwen3:8b-q4_k_m`     | ≈ 5.2 GB | 上位 tier、Thinking 対応 |
| `qwen3.5:2b-q4_k_m`   | ≈ 1.4 GB | 軽量、Thinking 対応 |
| `qwen3.5:4b-q4_k_m`   | ≈ 3.2 GB | Thinking 対応 |
| `qwen3.5:9b-q4_k_m`   | ≈ 5.3 GB | 高精度、Thinking 対応 |
| `qwen3:4b-q4_k_m`     | ≈ 2.6 GB | Thinking 対応 |
| `qwen2.5:7b-instruct-q4_k_m` | ≈ 4.7 GB | 安定版 |

> **注意**: Qwen3.5 / Gemma4 は古い `llama.cpp` vendor clone だと
> `unknown model architecture: 'qwen35'` / `unknown model architecture: 'gemma4'`
> で失敗します。最新 `main` を pull した後は `make` または `make test` を再実行してください。
> Apple Silicon (`darwin/arm64`) では MLX 対応版が分かっているモデル
> (`bonsai-*`, `qwen2.5:*`, `qwen3:*`, `qwen3.5:*`, `calm3:*`, `gemma4:*`)
> が MLX に自動切替されます。先に
> `python3 -m pip install -r ./python/requirements-llm.txt`
> を実行してください。
> それ以外の環境では `bonsai-8b` は `server-prism` が必要で、`bonsai-4b` / `bonsai-1.7b` は利用できません。
> `make` なら `server` と `server-prism` を自動で両方ビルドします。
> 登録済みの MLX repo ID を直接指定することもでき、たとえば
> `prism-ml/Ternary-Bonsai-8B-mlx-2bit` や `mlx-community/Qwen3-0.6B-4bit`
> を受け付けます。

GGUF ファイルを直接指定することも可能です:

```bash
./meet-translator-server --llama-model /path/to/model.gguf
```

## 起動

初回にモデル指定を省略した場合は、`large-v3-turbo` + `qwen3.5:0.8b-q4_k_m` を floor として
起動し、RAM/GPU に余裕があれば `bonsai-8b` やさらに上位のモデルへ自動で引き上げます。

```bash
# モデル名を指定して初回起動（自動ダウンロード + 設定保存）
./meet-translator-server \
  --whisper-model large-v3-turbo \
  --llama-model qwen3.5:0.8b-q4_k_m

# 2 回目以降は引数なしで起動可能
./meet-translator-server
```

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `7070` | リスンポート |
| `WHISPER_MODEL` | `auto`（floor: `large-v3-turbo`） | whisper モデル名またはファイルパス |
| `LLAMA_MODEL` | `auto`（floor: `qwen3.5:0.8b-q4_k_m`） | llama モデル名またはファイルパス |
| `LLAMA_GPU_LAYERS` | `-1` | GPU オフロードレイヤ数 (`0`=CPU only, `-1`=全レイヤ) |
| `WHISPER_GPU_LAYERS` | `-1` | 同上 (whisper 用) |
| `MODEL_CACHE_DIR` | OS 標準 | モデルキャッシュディレクトリ |

## 辞書 (Glossary) による精度向上

起動時に自動的に辞書ファイルを読み込み、2 段階で精度を向上させます。

```
macOS/Linux: ~/.config/meet-translator/glossary.json
Windows:     %APPDATA%\meet-translator\glossary.json
```

### 辞書の種類

| 種類 | 用途 | 動作 |
|---|---|---|
| `corrections` | ASR 誤認識の修正 | Whisper 出力後にテキスト置換（例: "a pie" → "API"） |
| `terms` | 専門用語の翻訳マッピング | LLM プロンプトに注入し、一貫した訳語を強制 |

### 辞書の手動管理 (REST API)

```bash
# 全エントリ確認
curl http://localhost:7070/glossary

# ASR 修正を追加
curl -X POST http://localhost:7070/glossary/corrections \
  -H "Content-Type: application/json" \
  -d '{"source":"a pie","target":"API","description":"Common Whisper misrecognition"}'

# 専門用語を追加
curl -X POST http://localhost:7070/glossary/terms \
  -H "Content-Type: application/json" \
  -d '{"source":"pull request","target":"プルリクエスト"}'

# エントリ削除
curl -X DELETE http://localhost:7070/glossary/corrections/a%20pie
curl -X DELETE http://localhost:7070/glossary/terms/pull%20request

# 外部から学習結果を送信 (kind = "correction" | "term")
curl -X POST http://localhost:7070/glossary/learn \
  -H "Content-Type: application/json" \
  -d '{"kind":"correction","source":"get hub","target":"GitHub"}'
```

### 辞書の直接編集とホットリロード

`glossary.json` はテキストエディタで直接編集できます。  
サーバーは **30 秒ごとにファイルの更新を監視**し、変更があれば自動的に再読み込みします。  
再起動不要でリアルタイムに辞書を更新できます。

```jsonc
// ~/.config/meet-translator/glossary.json
{
  "corrections": {
    "a pie": {"source":"a pie","target":"API","description":"Whisper misrecognition"},
    "get hub": {"source":"get hub","target":"GitHub"}
  },
  "terms": {
    "pull request": {"source":"pull request","target":"プルリクエスト"},
    "merge": {"source":"merge","target":"マージ"}
  }
}
```

### バックグラウンド自己改善

翻訳が **5 件**蓄積されるたびに、バックグラウンドで LLM が以下を自動解析します:

1. **ASR 誤認識候補** を検出して `corrections` に追加
2. **翻訳で一貫性のある訳語が必要な専門用語** を検出して `terms` に追加

追加されたエントリには `"description": "auto-improved"` タグが付きます。  
不要なエントリは REST API または直接編集で削除できます。
