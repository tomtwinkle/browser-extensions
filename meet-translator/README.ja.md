# meet-translator – Google Meet 自動翻訳チャット

Google Meet の音声をリアルタイムでキャプチャし、文字起こし・翻訳したテキストを
Meet のチャット欄に自動投稿する Chrome / Edge 拡張機能（Manifest V3）です。

**外部サービスへの依存はゼロ。** whisper.cpp と llama.cpp をローカルサーバーに組み込み、
すべての推論がマシン上で完結します。

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
[ content.js ]  ── Meet チャット DOM に翻訳テキストを投稿
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
│   ├── content.js            Content Script: Meet チャット DOM 操作
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
| `make` / `make all` | 両方のバイナリを再ビルド。autoconfig やリリース同等の導線で `bonsai-8b` まで自動遷移したい場合はこちら |
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

### 初回起動（モデル自動選択）

モデル未指定で起動すると、まず保守的な floor
`large-v3-turbo` + `qwen3.5:0.8b-q4_k_m` から始め、
**RAM/GPU に余裕があれば `bonsai-8b`、さらに大きいモデルへ段階的に引き上げて**設定ファイルに保存します。

```bash
./meet-translator-server
```

リリースアーカイブと `make` は標準バイナリに加えて PrismML 用の companion binary も同梱するため、
`bonsai-8b` が選ばれた場合も自動で切り替えられます。

自動選択されるモデル（GPU あり）:

| RAM | whisper | llama |
|---|---|---|
| ≥ 64 GB | `large-v3` | `calm3:22b-q4_k_m` |
| ≥ 32 GB | `large-v3-turbo` | `calm3:22b-q4_k_m` |
| ≥ 16 GB | `large-v3-turbo` | `qwen3:8b-q4_k_m` |
| ≥  8 GB | `large-v3-turbo` | `bonsai-8b` |
| < 8 GB  | `large-v3-turbo` | `qwen3.5:0.8b-q4_k_m` |

CPU のみの場合:

| RAM | whisper | llama |
|---|---|---|
| ≥ 8 GB | `large-v3-turbo` | `bonsai-8b` |
| < 8 GB | `large-v3-turbo` | `qwen3.5:0.8b-q4_k_m` |

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
| `--port` | `PORT` | `7070` | リッスンポート |
| `--whisper-model` | `WHISPER_MODEL` | `auto`（floor: `large-v3-turbo`） | Whisper モデル名またはファイルパス |
| `--llama-model` | `LLAMA_MODEL` | `auto`（floor: `qwen3.5:0.8b-q4_k_m`） | LLM モデル名またはファイルパス |
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

### ヘルスチェック

```bash
curl http://localhost:7070/health
```

---

## 対応モデル

### Whisper モデル（音声認識）

モデル名を `--whisper-model` に指定すると自動ダウンロードします。

| モデル名 | サイズ | 精度 |
|---|---|---|
| `tiny` | 75 MB | △ |
| `base` | 142 MB | ○ |
| `small` | 466 MB | ○ |
| `medium` | 1.5 GB | ◎ |
| `large-v3` | 3.1 GB | ◎◎ |
| `large-v3-turbo` | 809 MB | ◎ **default floor** (高速) |
| `kotoba-whisper` | 3.1 GB | ◎◎ 日本語特化の Kotoba-Whisper v2.0 |
| `kotoba-whisper-q5_0` | ≈ 1.0 GB | ◎ 量子化版 Kotoba-Whisper v2.0 |
| `sensevoice` | モデル側で管理 | ◎ ローカル Python worker 経由の高速多言語 ASR |
| `whisperx` | モデル側で管理 | ◎ ローカル Python worker 経由の WhisperX large-v3 |

`sensevoice:<model-ref>` と `whisperx:<model-name>` の高度な指定にも対応します。

SenseVoice / WhisperX を使う場合は、先にローカル Python 依存を入れ、`ffmpeg` を `PATH` から参照できるようにしてください。

```bash
cd server
python3 -m pip install -r ./python/requirements-asr.txt
```

### LLM モデル（翻訳）

モデル名を `--llama-model` に指定すると自動ダウンロードします。

| モデル名 | サイズ | ライセンス | 備考 |
|---|---|---|---|
| `qwen3.5:0.8b-q4_k_m` | ≈ 0.6 GB | Apache 2.0 | **default floor**、Thinking 対応 |
| `bonsai-8b` | ≈ 1.15 GB | Apache 2.0 | **最初の step-up**、1-bit 8B (PrismML)、Thinking 対応 |
| `qwen3:8b-q4_k_m` | ≈ 5.2 GB | Apache 2.0 | 上位 tier、Thinking 対応 |
| `calm3:22b-q4_k_m` | ≈ 13 GB | Apache 2.0 | 最上位 tier、日英特化、要 16 GB VRAM |
| `gemma4:e4b-q4_k_m` | ≈ 2.6 GB | Apache 2.0 | 高速・軽量 (Google Gemma 4) |
| `gemma4:e2b-q4_k_m` | ≈ 1.3 GB | Apache 2.0 | 最軽量 (Google Gemma 4) |
| `gemma4:26b-q4_k_m` | ≈ 16 GB | Apache 2.0 | 高精度 (Google Gemma 4) |
| `qwen3.5:2b-q4_k_m` | ≈ 1.4 GB | Apache 2.0 | Thinking 対応 |
| `qwen3.5:4b-q4_k_m` | ≈ 3.2 GB | Apache 2.0 | Thinking 対応 |
| `qwen3.5:9b-q4_k_m` | ≈ 5.3 GB | Apache 2.0 | 高精度、Thinking 対応 |
| `qwen3:0.6b-q4_k_m` | ≈ 0.4 GB | Apache 2.0 | Thinking 対応 |
| `qwen3:1.7b-q4_k_m` | ≈ 1.1 GB | Apache 2.0 | Thinking 対応 |
| `qwen3:4b-q4_k_m` | ≈ 2.6 GB | Apache 2.0 | Thinking 対応 |
| `qwen2.5:7b-instruct-q4_k_m` | ≈ 4.7 GB | Apache 2.0 | 安定版 |
| `qwen2.5:14b-instruct-q4_k_m` | ≈ 8.7 GB | Apache 2.0 | 高精度版 |

> **Note**: `bonsai-8b` は Q1_0_g128 形式のため、[PrismML fork の llama.cpp](https://github.com/PrismML-Eng/llama.cpp) が必要です。
> リリースアーカイブと `make` では必要な companion binary が自動で同梱されます。
> 標準バイナリだけをビルドした場合は、`bonsai-8b` を使う前に `make prism` を実行してください。

ファイルパスを直接指定することも可能です:

```bash
./meet-translator-server --llama-model /path/to/model.gguf
```

### Thinking モード（Qwen3 / Qwen3.5）

Qwen3 系および Qwen3.5 系モデルは **Thinking モード** に対応しています。
`<think>...</think>` で推論を展開してから翻訳するため精度が向上しますが、レイテンシが増加します。

リクエスト時に `llama_options` フィールドで制御できます:

```json
{"thinking": true}   // Thinking 有効 (Qwen3/Qwen3.5 のデフォルト)
{"thinking": false}  // Thinking 無効 (高速)
```

---

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

# 外部から学習結果を送信 (kind = "correction" | "term")
curl -X POST http://localhost:7070/glossary/learn \
  -H "Content-Type: application/json" \
  -d '{"kind":"correction","source":"get hub","target":"GitHub"}'
```

Meet 画面の UI にも同じ glossary API を使う **辞書修正** ウィジェットがあり、通話中にそのまま誤認識や誤訳を登録できます。

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

`cmd/benchmark` はモデルの翻訳品質と速度を計測し、autoconfig の ladder を見直すための参考データを出すツールです。

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

その他のフラグ:

```
--server  URL   サーバーアドレス (デフォルト: http://localhost:7070)
--runs    N     各テストケースの実行回数 (デフォルト: 3)
--warmup  N     ウォームアップ回数 (デフォルト: 2)
--dir     STR   方向フィルタ: "en-ja" | "ja-en" | "both" (デフォルト: both)
--verbose       各テストケースの入出力を詳細表示
```

### 比較出力例（macOS Apple M1 Max, GPU Metal, 2026-04）

```
=== Benchmark Comparison (5 models) ===

Rank Model                          Quality   Latency     Score
────────────────────────────────────────────────────────────────────
   1 qwen3.5:0.8b-q4_k_m              0.636     230ms     0.608
   2 qwen3:4b-q4_k_m                  0.814     730ms     0.605
   3 qwen3:8b-q4_k_m                  0.833    1360ms     0.572
   4 bonsai-8b                        0.454    7168ms     0.288
   5 gemma4:e4b-q4_k_m                0.256   11707ms     0.163

Score = quality×0.6 + speed×0.4  (speed = 1/(1 + latency/300ms))
```

> **Note:**
> - `qwen3.5:0.8b-q4_k_m` は速度重み付きベンチマークでは最上位ですが、autoconfig は生の順位ではなく
>   floor → `bonsai-8b` → より大きいモデル、という段階的な ladder を使います。
> - `bonsai-8b` は GPU ベンチマークで Thinking モードのタイムアウトが多発しスコアが低め。
>   それでも巨大モデルへ飛ぶ前の小さな step-up として維持しています。
> - `gemma4:e4b` は EN↔JA 翻訳タスクに不適（quality 0.256）。autoconfig 対象外。
> - 実際の数値は実行環境・GPU の有無によって異なります。

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
| サーバー URL | `http://localhost:7070`（デフォルト） |
| 翻訳元言語 | 自動検出 または 言語を指定 |
| 翻訳先言語 | 翻訳後の言語（デフォルト: 日本語） |
| **「サーバー疎通確認」** ボタン | サーバーに接続できるか確認 |

---

## 使い方

1. `https://meet.google.com/` でミーティングに参加します
2. 拡張機能アイコンをクリックし **「自動翻訳チャット開始」** を押します
3. 音声キャプチャが開始され、約 5 秒ごとに翻訳テキストがチャットへ投稿されます
   - 無音区間は VAD でスキップされ、セッション中のノイズフロアにも追従して低 SNR / 非音声チャンクを抑えます
   - Meet が現在の発話者をハイライトしている場合、その表示名をチャットとオーバーレイに付けて区別します
   - Meet 画面上の **辞書修正** ボタンから、誤った聞き取り語句や翻訳語句をその場で glossary に反映できます
   - 同じ話者の短い連続発話は少しだけまとめてから送るため、細切れの投稿を減らせます
   - チャットパネルが閉じている場合は自動的に開きます
4. **「自動翻訳チャット停止」** で停止します

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
| `http://localhost:7070/*` | ローカルサーバーへのリクエストを許可するため |

---

## Third-Party Licenses

本ソフトウェアは [whisper.cpp](https://github.com/ggerganov/whisper.cpp) **v1.8.4** および
[llama.cpp](https://github.com/ggerganov/llama.cpp) **b8699** を組み込んでいます。いずれも MIT ライセンスで公開されています。

実行時にダウンロードされるモデル（Whisper、Qwen3.5、Qwen3、Qwen2.5-7B/14B、Gemma4）は
MIT または Apache 2.0 で公開されています。Qwen2.5-3B は非商用限定ライセンスのためレジストリ対象外です。

完全な著作権表示およびモデルのライセンス詳細は [THIRDPARTY.md](../THIRDPARTY.md) を参照してください。
