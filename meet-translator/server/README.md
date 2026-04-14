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
> `git pull` 後に pin している upstream バージョンが変わっていた場合も、次の `make` / `make test` で vendor checkout を自動更新します。

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

> **注意**: Qwen3.5 / Gemma4 は古い `llama.cpp` vendor clone だと
> `unknown model architecture: 'qwen35'` / `unknown model architecture: 'gemma4'`
> で失敗します。最新 `main` を pull した後は `make` または `make test` を再実行してください。

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
