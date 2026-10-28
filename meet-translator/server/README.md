# meet-translator ローカルサーバー

whisper.cpp / llama.cpp を Go バイナリに直接組み込んだローカルサーバーです。既定では `127.0.0.1:17070` だけで待ち受け、API token と設定済み拡張Originがないと起動しません。
Kotoba-Whisper とGGUF LLMは同梱backendで動作し、SenseVoice / WhisperXなど任意のASR比較経路を選んだ場合はローカルPython workerを起動します。MLX等の別推論経路は、実機で検証するまでM1資格済みとは扱いません。

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
| Python 3.10+ (optional) | SenseVoice / WhisperX / Kotoba TransformersのASR backend | https://www.python.org/downloads/ |
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

## モデルの比較候補と取得

通常の推論構成はASR 1個、翻訳1個、小型VAD 1個です。モデルがregistryに存在することは、実品質・M1性能・Meet統合の合格を意味しません。

### ASR

| `--whisper-model` 値 | 説明 |
|---|---|
| `large-v3-turbo` | Whisper.cpp比較基準。未選定・未資格 |
| `large-v3` | Whisperの明示比較alias。未選定・未資格 |
| `kotoba-whisper-v2.2` / `kotoba-tech/kotoba-whisper-v2.2` | 作者checkpointをTransformers workerで実行するASR候補 |
| `sensevoice` / `sensevoice-small` | SenseVoiceSmallのローカルPython経路 |
| `whisperx` / `whisperX` / `whisperx-turbo` | WhisperX `turbo`のローカルPython経路 |
| `whisperx-large-v3` | WhisperXの`large-v3`比較alias |

小型Whisper、large-v1/v2、Kotoba v2.0、第三者Kotoba変換は現行選択一覧から隠しています。保存済みの明示設定は互換警告付きで解決します。`sensevoice:<model-ref>` と `whisperx:<model-name>` は明示指定です。SenseVoice / WhisperX / Kotoba Transformersの手動依存には `python/requirements-asr-sensevoice.txt`、`python/requirements-asr-whisperx.txt`、`python/requirements-asr-transformers.txt` を使います。必要なbackendでは `ffmpeg` をPATHへ設定してください。

### 翻訳

| `--llama-model` 値 | 説明 |
|---|---|
| `tencent/Hy-MT2-1.8B` | 現行の選択可能な候補。registryのartifactはTencent公式Hy-MT2 1.8B Q4_K_M。公開ベンチマークscreen通過、M1未資格 |
| `qwen3.5:0.8b-q4_k_m` | 既存設定と再現用baseline。現行選択一覧から非表示。品質・M1未資格 |

公開値screenを通過した実験枠はHy-MT2 Q4_K_Mと、registry未登録のCAT-Translate 0.8B/1.4Bです。CATは小型の日英比較モデルで、圧縮方式とは分類していません。Hy-MT2の2-bit variantは品質維持率が基準未満、1.25-bit版はexact variantの翻訳scoreが不足、30B-A3B MoEは全重み量がM1予算を超えるため除外です。蒸留ASRの日本語CERは比較元より悪く、pruning評価は日英外です。CATのLoRAは学習手法で、weight sharingを含め、適切な日英推論artifactの数値は未確認です。詳細は `docs/research/compression-screen.md` を参照してください。

TranslateGemma 4BとShisa V2.1 1.2Bは日英両方向の公開値が揃わず保留です。公式Qwen3.8 FP8は27Bで日本語翻訳値がなく、FP8生重みだけで10GiB推論予算を超えます。旧Qwen世代、Hy-MT2 7B、CALM3 22B、Bonsai、Gemma 4と重複aliasは現在の選択一覧から外しています。保存済みの明示設定は警告を出して解決し、別モデルへ自動置換しません。

公開benchmark passはローカル評価や製品選定ではありません。重みhash、利用条件、正式template/EOS、pin済みruntimeでの実ロード、M1 memory/latency、Meet字幕共有を通過するまでは候補状態をDEFERREDにします。会議中に検索、重み取得、更新は行いません。

直接のローカルファイルパス指定もできます:

```bash
./server --llama-model /path/to/model.gguf
```

## ローカルAPIの設定

サーバーは127.0.0.1だけにbindし、全APIに `Authorization: Bearer <token>` を要求します。ブラウザー要求は `MEET_TRANSLATOR_EXTENSION_ORIGIN` に設定した完全一致の拡張Originだけを許可します。Originは認証の代わりにはならず、OriginのないCLI要求もtokenが必要です。tokenは32バイト以上の暗号学的乱数を使用し、サーバーは環境変数から読みます。tokenをログや設定ファイルへ保存しません。

1. 拡張を読み込み、設定画面に表示される `chrome-extension://...` Originを確認します。
2. 暗号学的乱数で32バイト以上のtokenを生成し、`MEET_TRANSLATOR_API_TOKEN` としてサーバー起動環境へ設定します。
3. 同じtokenを拡張の設定画面へ入力し、設定画面に表示された完全一致Originを `MEET_TRANSLATOR_EXTENSION_ORIGIN` としてサーバー起動環境へ設定します。
4. サーバーを起動し、拡張の「Check server connection」で認証済みの疎通を確認します。

tokenの例をソース、コマンド履歴、ログへ書かないでください。既存configのportは維持されます。新しいconfigの既定portは17070です。

## 起動

モデル名を省略したときの `large-v3-turbo` + `qwen3.5:0.8b-q4_k_m` は、現在の比較基準です。モデル識別子が登録されていることや起動できることは品質・M1資格の合格を意味しません。RAM/GPU容量だけで未測定のモデルへ切り替えません。

```bash
# 既存のローカルモデル名を指定して起動
./meet-translator-server \
  --whisper-model large-v3-turbo \
  --llama-model qwen3.5:0.8b-q4_k_m

# 2 回目以降は引数なしで起動可能
./meet-translator-server
```

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `17070` | loopbackリスンポート。既存configの値を優先 |
| `MEET_TRANSLATOR_API_TOKEN` | 必須 | 32バイト以上のBearer token。設定ファイルへ保存しない |
| `MEET_TRANSLATOR_EXTENSION_ORIGIN` | 必須 | `chrome-extension://<extension-id>` の完全一致Origin |
| `WHISPER_MODEL` | `auto`（baseline: `large-v3-turbo`） | whisper モデル名またはファイルパス |
| `LLAMA_MODEL` | `auto`（reproduction baseline: `qwen3.5:0.8b-q4_k_m`） | llama モデル名またはファイルパス |
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
# 全エントリ確認。tokenはサーバー環境から読む。
curl http://127.0.0.1:17070/glossary \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN"

# ASR 修正を追加
curl -X POST http://127.0.0.1:17070/glossary/corrections \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"a pie","target":"API","description":"Common Whisper misrecognition"}'

# 専門用語を追加
curl -X POST http://127.0.0.1:17070/glossary/terms \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"pull request","target":"プルリクエスト"}'

# エントリ削除
curl -X DELETE http://127.0.0.1:17070/glossary/corrections/a%20pie \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN"
curl -X DELETE http://127.0.0.1:17070/glossary/terms/pull%20request \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN"

# 外部から学習結果を送信 (kind = "correction" | "term")
curl -X POST http://127.0.0.1:17070/glossary/learn \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN" \
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
