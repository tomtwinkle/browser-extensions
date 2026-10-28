# meet-translator – Google Meet 音声のローカル文字起こし・翻訳

Google Meet 音声をローカルで文字起こし・翻訳する Chrome / Edge 拡張機能
(Manifest V3) とローカルサーバーです。拡張機能には、ホスト専用の訂正画面と、
ホストがMeetの画面共有で選ぶ字幕ページがあります。

ASR・翻訳はローカルサーバーで実行します。字幕ページを開いただけでは共有は始まらず、
Meetの通常の画面共有画面からホストがそのタブを選ぶ必要があります。訂正画面は共有しないでください。
Google Chatの権限と投稿経路は削除しました。実Meet統合とM1モデル評価は未完了です。
[`docs/implementation-status.md`](docs/implementation-status.md) に確認済み範囲と残件を記録しています。

[English README](README.md)

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
[ caption-presenter.html ] ── 承認済み字幕だけを表示
[ sidepanel.html ]          ── ホスト専用の候補確認・訂正・承認
[ content.js ]              ── Meet内オーバーレイと辞書フィードバックUI
```

---

## ディレクトリ構成

```
meet-translator/
├── extension/                Chrome / Edge 拡張機能
│   ├── manifest.json         Manifest V3 設定
│   ├── shared.js             本体とテストで共有する純粋関数
│   ├── background.js         Service Worker: 音声キャプチャ・翻訳制御
│   ├── offscreen.html/js     Offscreen Document: Web Audio API + WAV エンコーダー
│   ├── content.js            Content Script: 現行のMeet内表示と辞書UI
│   ├── caption-presenter.html/js  共有対象に選ぶ公開字幕ページ
│   ├── sidepanel.html/js          ホスト専用の履歴・訂正画面
│   ├── caption-store.js           session/revision付き字幕状態
│   ├── caption-protocol.js        非公開情報を除いた公開投影
│   ├── popup.html/js         ポップアップ UI (開始/停止 + 設定リンク)
│   ├── options.html/js       設定ページ (サーバー URL・言語)
│   ├── tests/                Node ベースの extension 単体テスト
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
    ├── glossary.go           辞書管理 (ASR 修正・専門用語マッピング)
    ├── glossary_improver.go  バックグラウンド辞書自己改善
    ├── gpu_cpu.go            CGo LDFLAGS: CPU ビルド
    ├── gpu_cuda.go           CGo LDFLAGS: NVIDIA CUDA ビルド
    ├── gpu_metal.go          CGo LDFLAGS: Apple Metal ビルド
    ├── CMakeLists.txt        whisper.cpp + llama.cpp を共通 ggml でまとめてビルド
    └── Makefile              GPU 自動検出・cmake + Go ビルド
```

---

## セットアップ

### リリース版を使う場合（推奨）

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

make                  # GPU を自動検出し、server + server-prism を両方ビルド
make all GPU=metal    # Apple Metal を強制して両バリアントをビルド
make all GPU=cuda     # NVIDIA CUDA を強制して両バリアントをビルド
make all GPU=cpu      # CPU のみで両バリアントをビルド
make build GPU=cpu    # 標準バイナリのみ
make prism GPU=cpu    # PrismML バイナリのみ（bonsai-8b / server-prism 用）
```

`make` は初回に whisper.cpp と llama.cpp を自動クローン・cmake ビルドし、
`git pull` 後に pin している upstream バージョンが変わっていれば vendor checkout も自動更新し、
`server` と `server-prism` の両方を生成します。

### リビルド

コード変更後は状況に応じて以下を使い分けてください:

| コマンド | 用途 |
|---|---|
| `make build` | 標準バイナリ (`server`) のみ再ビルド |
| `make prism` | `bonsai-8b` 用の PrismML バイナリ (`server-prism`) のみ再ビルド |
| `make` / `make all` | 標準・PrismML両方のバイナリを再ビルド |
| `make rebuild` | ブリッジ C++ ファイル（`whisper_bridge.cpp` 等）を変更した後。cmake を再実行してから `go build`。必要なら pin 済み vendor バージョンも自動更新 |
| `make distclean && make` | vendor を含めて全部取り直したいときの完全再構築 |

```bash
# 例: Go ソースを変更し、両方のバイナリを更新したい場合
make all

# 例: git pull でブリッジ C++ が更新された場合
make rebuild

# 例: 完全にクリーン再構築したい場合
make distclean
make
```

### テスト

```bash
# extension の単体テスト
node --test meet-translator/extension/tests/*.test.js

# server のテスト
cd meet-translator/server && make test
```

---

## サーバーの起動

### 初回起動

`large-v3-turbo` + `qwen3.5:0.8b-q4_k_m` は再現用の比較基準IDです。
RAM/GPU容量だけで別モデルへ昇格しません。この基準は品質・メモリ・遅延・M1統合の合格を意味しません。

```bash
./meet-translator-server
```

サーバーの起動には32バイト以上のAPI tokenと、拡張設定ページに表示される完全一致Originが必要です。
設定方法は[ローカルAPI設定](server/README.md#ローカルapiの設定)を参照してください。

### モデルを手動指定する場合

```bash
./meet-translator-server \
  --whisper-model large-v3-turbo \
  --llama-model qwen3.5:0.8b-q4_k_m
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
| `--port` | `PORT` | `17070` | loopbackリッスンポート |
| `--whisper-model` | `WHISPER_MODEL` | `auto`（baseline: `large-v3-turbo`） | Whisper モデル名またはファイルパス |
| `--llama-model` | `LLAMA_MODEL` | `auto`（reproduction baseline: `qwen3.5:0.8b-q4_k_m`） | LLM モデル名またはファイルパス |
| `--llama-gpu-layers` | `LLAMA_GPU_LAYERS` | `-1` | GPU オフロード層数 (`0`=CPU, `-1`=全層) |
| `--whisper-gpu-layers` | `WHISPER_GPU_LAYERS` | `-1` | 同上 (Whisper 用) |
| `--model-cache-dir` | `MODEL_CACHE_DIR` | OS 標準 | モデルキャッシュディレクトリ |
| `--config` | `MEET_TRANSLATOR_CONFIG` | OS 標準 | 設定ファイルパスの上書き |

> **優先順位**: CLI フラグ > 設定ファイル > 環境変数 > デフォルト値

設定ファイルの場所:

| OS | パス |
|---|---|
| Linux | `~/.config/meet-translator/config.json` |
| macOS | `~/Library/Application Support/meet-translator/config.json` |
| Windows | `%APPDATA%\meet-translator\config.json` |

### ローカルAPIの設定とヘルスチェック

設定手順は[サーバーREADME](server/README.md#ローカルapiの設定)を参照してください。
すべてのAPIにBearer tokenが必要です。設定ページに表示された拡張Originだけを許可し、
サーバーは `127.0.0.1` にbindします。新規設定の既定ポートは17070です。

```bash
curl http://127.0.0.1:17070/health \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN"
```

---

## 対応モデル

モデル一覧への掲載、ローカル起動、公開ベンチマーク通過は、M1 Maxでの品質・性能合格を意味しません。最終条件は字幕共有・訂正UIを含む同時利用試験です。

### Whisper・ASR

| 現行比較名 | 用途・状態 |
|---|---|
| `large-v3-turbo` | 再現用ASR基準。未選定・未資格 |
| `large-v3` | Whisper比較用。未選定・未資格 |
| `kotoba-whisper-v2.2` / `kotoba-tech/kotoba-whisper-v2.2` | 作者配布の日本語ASR比較候補。未資格 |
| `sensevoice`、`whisperx`、`whisperx-large-v3` | 任意のローカルPython ASR比較経路。各モデル別に要検証 |

小型の `tiny` / `base` / `small` / `medium`、Whisper `large-v1` / `large-v2`、Kotoba-Whisper v2.0、第三者変換版は現在のモデル一覧から除外しました。保存済みの明示設定は互換警告付きで解決します。`sensevoice:<model-ref>` と `whisperx:<model-name>` は上級者向けの明示指定です。

SenseVoice / WhisperX / Kotoba Transformers backend はローカルPython workerを使います。`uv` がない場合の手動依存は以下を参照してください。

```bash
cd server
python3.11 -m pip install -r ./python/requirements-asr-whisperx.txt
```

SenseVoiceは `requirements-asr-sensevoice.txt`、Kotoba v2.2は `requirements-asr-transformers.txt` を使います。`ffmpeg` が必要なbackendではPATHを設定してください。

### 翻訳モデル

| 現行比較名 | 用途・状態 |
|---|---|
| `tencent/Hy-MT2-1.8B` | Q4_K_M量子化候補。公開ベンチマークの事前screen通過。M1未資格 |
| `CyberAgent/CAT-Translate-0.8b` | 0.8Bの日英小型研究候補。同じcardのTranslateGemma 4Bより両方向BLEUが高い。runtime一覧には未登録 |
| `qwen3.5:0.8b-q4_k_m` | 既存設定と比較再現用baselineだけに保持。現在の選択一覧から非表示。選定・品質合格ではない |

公開値でscreenを通過した候補はHy-MT2 Q4_K_MとCAT-Translate 0.8B/1.4Bの3構成です。CAT-Translateは圧縮方式ではなく、小型の日英翻訳比較候補です。Hy-MT2は実験用runtime候補として登録済みですが、CAT-Translateは研究記録のみです。どれもこのアプリでの実モデル評価・M1資格は未実施です。研究記録は [`docs/research/compression-screen.md`](docs/research/compression-screen.md) を参照してください。

| 圧縮方式・候補 | 公開値による判定 |
|---|---|
| Hy-MT2 1.8B Q4_K_M | FLORES-200 98.48%、IFMTBench 91.51%をBF16比で維持し、公開screen通過 |
| CAT-Translate 0.8B | BLEUは日→英29.71、英→日30.68。同じcardのTranslateGemma 4B値29.41 / 26.76を両方向で上回る |
| Hy-MT2 1.8B 2-bit | IFMTBench維持率85.05%のため対象外 |
| Hy-MT2 AngelSlim 1.25-bit | 正確な量子化版の翻訳品質値がなく保留 |
| Hy-MT2-30B-A3B MoE | 30B全体の重みを保持するため、active 3BでもM1の10GiB推論予算外 |
| MoE | Hy-MT2-30B-A3Bは全30Bの重みがあり、10GiBの推論予算外 |
| Knowledge distillation | 蒸留Kotoba ASRの日本語CERは比較元より悪く、合格する日英翻訳版も未確認 |
| Pruning | 確認したCULL-MTの評価方向に日英なし |
| Low-rank factorization | CAT-Translateは学習にLoRAを使うが、配布推論artifactは低rank化されていない |
| Weight sharing | 適切な日英比較値のある正確なartifactを未確認 |

TranslateGemma 4Bは英→日の公開値のみで、日→英の4B数値が確認できず実験shortlist外です。Shisa V2.1 1.2Bは評価方向が明示された両方向の数値を確認できず保留です。蒸留Kotoba ASRの日本語ReazonSpeech CERは16.8で、比較元のWhisper large-v3の14.9を下回るためASR候補から除外しています。

公式Qwen3.8 FP8版も27Bで、日本語翻訳の数値はなく、FP8の生重みだけでも10GiB推論予算を超えます。旧Qwen、Hy-MT2 7B、CALM3 22B、Bonsai、Gemma 4などは現行一覧から外しました。保存済みの明示モデル名は互換警告付きで解決し、既存設定は自動で置換しません。

公開ベンチマークscreenは実品質評価ではありません。重み、利用条件、tokenizer / template / EOS、nativeまたはMLX実行、実メモリ、Metal利用、会議字幕の確定遅延、Meet統合が未確認の候補は `DEFERRED` のままです。会議中の追加ASRやモデル検索・更新は行いません。

## 辞書（Glossary）による精度向上

起動時に辞書ファイルを自動読み込みし、2 段階で精度を向上させます。

```
macOS/Linux: ~/.config/meet-translator/glossary.json
Windows:     %APPDATA%\meet-translator\glossary.json
```

初回起動時は **SWE/AI エンジニア向けのデフォルト辞書**（ASR 修正 17 件・専門用語約 70 件）が
自動生成されます。ファイルを直接編集するか REST API で管理できます。

### 辞書の種類

| 種類 | 用途 | 動作 |
|---|---|---|
| `corrections` | ASR 誤認識の修正 | Whisper 出力後にテキスト置換（例: "a pie" → "API"） |
| `terms` | 専門用語の翻訳マッピング | LLM プロンプトに注入し、一貫した訳語を強制 |

### REST API

```bash
# 全エントリ確認
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

# 外部から学習結果を送信 (kind = "correction" | "term")
curl -X POST http://127.0.0.1:17070/glossary/learn \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"correction","source":"get hub","target":"GitHub"}'
```

現行Meet内UIには同じglossary APIを使う辞書フィードバックwidgetがあります。

### ホットリロード

`glossary.json` はテキストエディタで直接編集できます。
サーバーは **30 秒ごとにファイルの更新を監視**し、変更があれば自動再読み込みします。
再起動不要でリアルタイムに辞書を更新できます。

### バックグラウンド自己改善

翻訳が **5 件**蓄積されるたびに、バックグラウンドで LLM が自動解析します:

1. **ASR 誤認識候補**を検出して `corrections` に追加
2. **一貫した訳語が必要な専門用語**を検出して `terms` に追加

追加エントリには `"description": "auto-improved"` タグが付きます。
不要なエントリは REST API または直接編集で削除できます。

詳細な API リファレンスは [server/README.md](server/README.md) を参照してください。

---

## LLM 翻訳ベンチマーク

`cmd/benchmark` は従来のMT-only比較用ツールで、モデルを選択する機能はありません。

### テストケース

英語⇔日本語の双方向で各 20 件、計 40 件の会議シーン向けフレーズを収録しています。

| カテゴリ | 件数 | 内容 |
|---|---|---|
| greeting | 8 (4+4) | 挨拶・日常会話 |
| technical | 12 (6+6) | pull request / API / CI / refactor 等の技術用語 |
| action | 8 (4+4) | 依頼・指示 |
| question | 8 (4+4) | 質問文 |
| complex | 4 (2+2) | 複合文 |

### 品質指標: ChrF

文字 n-gram F スコア（n=1,2,3 平均）を使用します。
形態素解析なしに日本語・英語の両方で機能し、部分一致もスコアに反映されます。

| 指標 | 説明 |
|---|---|
| **Quality** | ChrF スコア (0.0〜1.0) |
| **Latency** | 翻訳 1 件あたりの平均レイテンシ |
| **Score** | `quality×0.6 + speed×0.4`（speed = 1/(1+latency/300ms)）|

### 実行方法

```bash
# 1. サーバーを起動（計測したいモデルを指定）
./server --llama-model bonsai-8b

# 2. ベンチマークを実行して結果を保存
make bench OUTPUT=results/bonsai-8b.json

# 3. 別モデルで繰り返す（サーバーを再起動）
./server --llama-model qwen3:4b-q4_k_m
make bench OUTPUT=results/qwen3-4b.json

# 4. 結果を比較してモデル順位を表示
go run ./cmd/benchmark/ --compare results/
```

実行時はサーバーと同じ `MEET_TRANSLATOR_API_TOKEN` を環境変数へ設定してください。
benchmark CLIはこのtokenをBearer headerで送信します。

その他のフラグ:

```
--server  URL   サーバーアドレス (デフォルト: http://127.0.0.1:17070)
--runs    N     各テストケースの実行回数 (デフォルト: 3)
--warmup  N     ウォームアップ回数 (デフォルト: 2)
--dir     STR   方向フィルタ: "en-ja" | "ja-en" | "both" (デフォルト: both)
--verbose       各テストケースの入出力を詳細表示
```

### ベンチマークの状態

従来のベンチマークはMT-onlyで、内部実装のChrF類似スコアを使います。
SacreBLEU chrF2、ASR-only、音声から公開字幕までの証拠ではありません。
実際のモデルartifactと実行条件が十分pinされていない過去の例示スコアは削除しました。
benchmark CLIは `MEET_TRANSLATOR_API_TOKEN` を読み、Bearer headerで送信します。
`eval/` の三track manifestは現在synthetic fixtureのみで、モデル品質を計測していません。

---

## 拡張機能のセットアップ

### 開発版（ソースから読み込む）

1. Chrome / Edge で `chrome://extensions` を開く
2. **デベロッパーモード** を有効にする
3. **「パッケージ化されていない拡張機能を読み込む」** → `extension/` フォルダを選択

### リリース版（zip から読み込む）

1. `meet-translator-extension.zip` をダウンロードして任意のフォルダに展開
2. Chrome / Edge で `chrome://extensions` を開く
3. **デベロッパーモード** を有効にする
4. **「パッケージ化されていない拡張機能を読み込む」** → 展開したフォルダを選択

### 設定

拡張機能アイコン → **⚙ 設定** を開き、以下を確認・設定します:

| 設定項目 | 説明 |
|---|---|
| サーバー URL | `http://127.0.0.1:17070`（新規設定のデフォルト） |
| ローカルAPI token | サーバー起動環境の `MEET_TRANSLATOR_API_TOKEN` と同じ値 |
| 許可する拡張Origin | 表示値を `MEET_TRANSLATOR_EXTENSION_ORIGIN` へ設定 |
| 翻訳元言語 | 自動検出 または 言語を指定 |
| 翻訳先言語 | 翻訳後の言語（デフォルト: 日本語） |
| **「サーバー疎通確認」** ボタン | サーバーに接続できるか確認 |

---

## 現在の利用範囲

ポップアップから字幕ページと訂正ページを開けます。字幕を共有するときは、Meetの画面共有から字幕ページをホストが明示的に選びます。訂正ページは共有しないでください。Meetの実会議での共有・訂正・stop/restart結合試験とM1 Maxのモデル性能評価は未完了です。要件ごとの状態は [implementation status](docs/implementation-status.md) を参照してください。

---

## リリース（GitHub Actions）

`main` ブランチへのマージ時に conventional commits を解析し、
自動でバージョンを決定して git タグと GitHub Release を作成します。

| コミットプレフィックス | バンプ | 例 |
|---|---|---|
| `feat:` | minor | `0.1.0 → 0.2.0` |
| `fix:` | patch | `0.1.0 → 0.1.1` |

リリースが作成されると各プラットフォームのバイナリと拡張機能 zip が
自動ビルドされ GitHub Release にアップロードされます。

---

## CI

プルリクエスト時に以下の 2 種類のワークフローが 4 プラットフォームで実行されます:

**Test** (`test.yml`): ビルド + Go テスト  
**Execute Test** (`execute-test.yml`): ビルド環境と実行環境を分離し、クリーンなランナーでバイナリの動作を検証

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
| `scripting` | コンテンツスクリプトの動的実行 |
| `storage` | 設定の永続化 |
| `offscreen` | MV3 Service Worker では使用できない AudioContext を Offscreen Document で実行するため |
| `tabs` | 設定ページを開くため |
| `http://localhost/*`, `http://127.0.0.1/*` | ローカルサーバーへのリクエストを許可するため |

---

## Third-Party Licenses

本ソフトウェアは [whisper.cpp](https://github.com/ggerganov/whisper.cpp) **v1.8.4** および
[llama.cpp](https://github.com/ggerganov/llama.cpp) **b8699** を組み込んでいます。いずれも MIT ライセンスで公開されています。

モデル実行エンジンのライセンスは、ダウンロードする重みの条件とは別です。
利用・再配布の前に正確なモデルと変換済みartifactの条件を確認してください。
現在のQwen再現baselineは公式カード上Apache 2.0です。Tencent公式GGUFページはApache 2.0を表示しますが、変換artifactの条件は未確認です。研究だけで扱うモデルはruntime registryに含めていません。

完全な著作権表示およびモデルのライセンス詳細は [THIRDPARTY.md](../THIRDPARTY.md) を参照してください。
