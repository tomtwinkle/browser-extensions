# meet-translator – Local Google Meet Speech Translation

A Chrome / Edge extension (Manifest V3) and local Go server for transcribing and translating Google Meet audio. It includes a host-only correction page and a caption page the host can choose in Meet's screen-sharing UI.

**Inference runs on the local server.** whisper.cpp and llama.cpp are embedded in the
server; no cloud inference path is used.

The popup opens the caption page and the private correction page. Opening the caption page does not start sharing; the host must select that tab in Meet's normal screen-sharing UI. Keep the correction page private. Actual Meet integration and M1 Max model performance remain unverified. See [`docs/implementation-status.md`](docs/implementation-status.md) for verified and blocked work.

[日本語版 README](README.ja.md)

---

## Architecture

```
[ Google Meet tab ]
       │  tabCapture (audio)
       ▼
[ offscreen.js ]  ── collects audio via Web Audio API → encodes to WAV (PCM 16-bit)
       │               silent chunks are skipped by VAD
       ▼
[ background.js ]  ── authenticated loopback HTTP requests
       │
       ▼
[ meet-translator-server ]  ← single binary (Go + CGo)
  ├─ whisper.cpp (embedded) ── speech-to-text
  └─ llama.cpp   (embedded) ── LLM translation
       │
       ▼
[ current Meet content script ]  ── legacy in-Meet overlay and feedback UI
```

---

## Directory Structure

```
meet-translator/
├── extension/                Chrome / Edge extension
│   ├── manifest.json         Manifest V3 configuration
│   ├── shared.js             Shared pure helpers for runtime + tests
│   ├── background.js         Service Worker: audio capture & translation control
│   ├── offscreen.html/js     Offscreen Document: Web Audio API + WAV encoder
│   ├── content.js            Content Script: in-Meet overlay and glossary UI
│   ├── caption-presenter.html/js  Public caption page to select for sharing
│   ├── sidepanel.html/js          Host-only history and correction page
│   ├── caption-store.js           Session/revision caption state
│   ├── caption-protocol.js        Public projection without private fields
│   ├── popup.html/js         Popup UI (start/stop + settings link)
│   ├── options.html/js       Settings page (server URL, languages)
│   ├── tests/                Node-based extension unit tests
│   └── icons/                Icons (16 / 32 / 48 / 128 px)
│
└── server/                   Local inference server
    ├── main.go               HTTP server + graceful shutdown + CLI flags
    ├── whisper.go            CGo bridge → whisper.cpp (transcription)
    ├── llama.go              CGo bridge → llama.cpp (translation)
    ├── whisper_bridge.h/cpp  whisper.cpp C++ bridge implementation
    ├── llama_bridge.h/cpp    llama.cpp C++ bridge implementation
    ├── audio.go              WAV parser + 16 kHz resampler (stdlib only)
    ├── model_manager.go      Model registry, path resolution, auto-download
    ├── model_download.go     GGUF download from HuggingFace (with progress)
    ├── model_options.go      Per-model options (Thinking mode, etc.)
    ├── ollama_cache.go       Search models in Ollama cache
    ├── server_config.go      Read/write config file (remembers first-run choices)
    ├── preflight.go          Pre-flight checks (model file verification, OS guidance)
    ├── translation.go        Translation logic (prompt construction)
    ├── glossary.go           Glossary management (ASR corrections, term mappings)
    ├── glossary_improver.go  Background glossary self-improvement
    ├── gpu_cpu.go            CGo LDFLAGS: CPU build
    ├── gpu_cuda.go           CGo LDFLAGS: NVIDIA CUDA build
    ├── gpu_metal.go          CGo LDFLAGS: Apple Metal build
    ├── CMakeLists.txt        Builds whisper.cpp + llama.cpp with shared ggml
    └── Makefile              GPU auto-detection, cmake + Go build
```

---

## Setup

### Using a release build (recommended)

Download and extract the archive for your OS from
[GitHub Releases](https://github.com/tomtwinkle/browser-extensions/releases).

| File | Target |
|---|---|
| `meet-translator-server-linux-amd64.tar.gz` | Linux (x86_64) |
| `meet-translator-server-linux-arm64.tar.gz` | Linux (ARM64) |
| `meet-translator-server-darwin-arm64.tar.gz` | macOS (Apple Silicon) |
| `meet-translator-server-windows-amd64.zip` | Windows (x64) |
| `meet-translator-extension.zip` | Chrome / Edge extension |

### Building from source

**Prerequisites**: Go 1.23+, cmake 3.21+, C++ compiler

```bash
cd meet-translator/server/

make                  # auto-detects GPU and builds both server + server-prism
make all GPU=metal    # force Apple Metal and build both variants
make all GPU=cuda     # force NVIDIA CUDA and build both variants
make all GPU=cpu      # CPU-only build for both variants
make build GPU=cpu    # standard binary only
make prism GPU=cpu    # PrismML compatibility binary
```

`make` automatically clones and cmake-builds whisper.cpp and llama.cpp on first run,
refreshes those vendored checkouts when the pinned upstream versions change after a `git pull`,
and produces both `server` and `server-prism`.

### Rebuilding

After making changes, choose the appropriate command:

| Command | When to use |
|---|---|
| `make build` | Rebuild only the standard binary (`server`) |
| `make prism` | Rebuild only the PrismML compatibility binary (`server-prism`) |
| `make` / `make all` | Rebuild both binaries for standard and PrismML targets |
| `make rebuild` | Bridge C++ files changed (`whisper_bridge.cpp`, etc.) – re-runs cmake then `go build`; pinned vendor versions still auto-refresh if needed |
| `make distclean && make` | Full reset when you want to re-clone vendor and rebuild everything from scratch |

```bash
# Example: Go source changed and you want both binaries refreshed
make all

# Example: bridge C++ updated (e.g. after git pull)
make rebuild

# Example: full clean rebuild
make distclean
make
```

### Testing

```bash
# extension unit tests
node --test meet-translator/extension/tests/*.test.js

# server tests
cd meet-translator/server && make test
```

---

## Starting the Server

### First run

The default model identifiers `large-v3-turbo` + `qwen3.5:0.8b-q4_k_m` are retained as the current reproducibility baseline. Hardware capacity alone does not promote another model. This baseline has not passed the quality, memory, latency, or integration qualification gates.

```bash
./meet-translator-server
```

Startup requires an API token and the exact extension origin as described in [the server security setup](server/README.md#ローカルapiの設定). Existing saved model and port settings are preserved.

### Specifying models manually

```bash
./meet-translator-server \
  --whisper-model large-v3-turbo \
  --llama-model qwen3.5:0.8b-q4_k_m
```

The specified model names are saved to the config file. A registry entry does not mean a model is qualified. Prepare only authorized model files and review the candidate status in `docs/research/candidates.json` before loading an experimental candidate.

```bash
./meet-translator-server   # subsequent runs work without flags
```

### Sharing the Ollama cache

If you already have GGUF models fetched via Ollama, the server detects and uses them automatically — no extra download needed.

### Key startup flags

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--port` | `PORT` | `17070` | Loopback listen port |
| `--whisper-model` | `WHISPER_MODEL` | `auto` (reproduction baseline: `large-v3-turbo`) | Whisper model name or file path |
| `--llama-model` | `LLAMA_MODEL` | `auto` (reproduction baseline: `qwen3.5:0.8b-q4_k_m`) | LLM model name or file path |
| `--llama-gpu-layers` | `LLAMA_GPU_LAYERS` | `-1` | GPU offload layers (`0`=CPU, `-1`=all) |
| `--whisper-gpu-layers` | `WHISPER_GPU_LAYERS` | `-1` | Same for Whisper |
| `--model-cache-dir` | `MODEL_CACHE_DIR` | OS default | Model cache directory |
| `--config` | `MEET_TRANSLATOR_CONFIG` | OS default | Override config file path |

> **Priority**: CLI flag > config file > environment variable > default

Config file locations:

| OS | Path |
|---|---|
| Linux | `~/.config/meet-translator/config.json` |
| macOS | `~/Library/Application Support/meet-translator/config.json` |
| Windows | `%APPDATA%\meet-translator\config.json` |

### Health check

```bash
curl http://127.0.0.1:17070/health \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN"
```

The server binds to `127.0.0.1`, rejects unconfigured Host/Origin values, requires a bearer token on every API (including `/health`), and caps audio requests at 8 MiB. The extension stores the token in trusted extension storage and sends it from the service worker; it is not passed to Meet content scripts.

---

## Supported Models

A model appearing in the runtime registry or passing the public benchmark screen does not mean it has passed M1 quality, memory, latency, or Meet integration qualification. The product target includes Meet caption sharing and the private correction UI running alongside local ASR and translation.

### Whisper and ASR

| Current comparison identifier | Purpose and status |
|---|---|
| `large-v3-turbo` | Reproduction ASR baseline; not selected or qualified |
| `large-v3` | Whisper comparison alias; not selected or qualified |
| `kotoba-whisper-v2.2` / `kotoba-tech/kotoba-whisper-v2.2` | Author checkpoint for Japanese ASR comparison; not qualified |
| `sensevoice`, `whisperx`, `whisperx-large-v3` | Optional local Python ASR routes; each model requires its own evaluation |

Whisper `tiny`, `base`, `small`, `medium`, `large-v1`, and `large-v2`, Kotoba-Whisper v2.0, and third-party Kotoba conversions are hidden from the current list. Explicit saved identifiers still resolve with a compatibility warning. Advanced `sensevoice:<model-ref>` and `whisperx:<model-name>` forms remain explicit experiment routes.

SenseVoice, WhisperX, and Kotoba Transformers use the local Python worker. If `uv` is unavailable, install only the backend's dependencies:

```bash
cd server
python3.11 -m pip install -r ./python/requirements-asr-whisperx.txt
```

Use `requirements-asr-sensevoice.txt` for SenseVoice and `requirements-asr-transformers.txt` for Kotoba v2.2. Backends that need `ffmpeg` require it on `PATH`.

### Translation models

| Current comparison identifier | Purpose and status |
|---|---|
| `tencent/Hy-MT2-1.8B` | Q4_K_M quantization candidate; passes the published benchmark pre-screen; not M1-qualified |
| `CyberAgent/CAT-Translate-0.8b` | 0.8B compact bilingual research candidate; author BLEU exceeds the same-card TranslateGemma 4B values in both directions; not a runtime choice |
| `qwen3.5:0.8b-q4_k_m` | Retained only for saved-setting compatibility and baseline reproduction; hidden from the current selectable list; not selected or quality-qualified |

Three candidates pass the published-results screen: Hy-MT2 Q4_K_M and CAT-Translate 0.8B and 1.4B. CAT-Translate is a compact bilingual comparator, not a compressed-model claim. Hy-MT2 is registered as an experimental runtime candidate; both CAT sizes remain research-only. None has been run through this application or qualified. See [`docs/research/compression-screen.md`](docs/research/compression-screen.md).

| Compression family or candidate | Published-score decision |
|---|---|
| Hy-MT2 1.8B Q4_K_M | Retains 98.48% on FLORES-200 and 91.51% on IFMTBench versus BF16; passes the screen |
| CAT-Translate 0.8B | BLEU 29.71 JA→EN / 30.68 EN→JA versus TranslateGemma 4B 29.41 / 26.76 on the same card; passes the bilingual screen |
| Hy-MT2 1.8B 2-bit | Excluded: 85.05% IFMTBench retention |
| Hy-MT2 AngelSlim 1.25-bit | Deferred: no exact-variant translation quality score |
| Hy-MT2-30B-A3B MoE | Outside the 10 GiB inference budget based on 30B total weights, despite 3B active parameters |
| MoE | Hy-MT2-30B-A3B is outside the 10 GiB budget based on 30B total weights |
| Knowledge distillation | Distilled Kotoba ASR CER is worse on the reviewed Japanese set; no distilled JA↔EN translation artifact passes |
| Pruning | Reviewed CULL-MT results do not cover Japanese-English |
| Low-rank factorization | CAT-Translate used LoRA for training, but the published inference artifact is not factorized |
| Weight sharing | No reviewed exact Japanese-English artifact has qualifying comparative results |

TranslateGemma 4B has a published English-to-Japanese result, but the reviewed 4B sources do not give the reverse direction, so it is outside the experiment shortlist. Shisa V2.1 1.2B lacks clear published values in both directions and remains deferred. The distilled Kotoba ASR card reports Japanese ReazonSpeech CER 16.8 versus 14.9 for Whisper large-v3, so it is not shortlisted as a Japanese ASR replacement.

The reviewed official Qwen3.8 FP8 checkpoint is still 27B; the card gives no Japanese-English translation scores, and raw FP8 weights alone exceed the 10 GiB process budget. Older Qwen generations, Hy-MT2 7B, CALM3 22B, Bonsai, and Gemma 4 are hidden from the current choices. Explicit saved identifiers remain compatible with a warning and are not silently replaced.

A public benchmark screen is not a local quality result. Candidates remain `DEFERRED` until their exact weights, terms, tokenizer/template/EOS, native or MLX route, process memory, Metal execution, final-caption latency, and Meet integration are verified. The app does not search for or update models during a meeting.

## Glossary for Improved Accuracy

A glossary file is loaded automatically at startup and improves accuracy in two stages.

```
macOS/Linux: ~/.config/meet-translator/glossary.json
Windows:     %APPDATA%\meet-translator\glossary.json
```

On first run a **default glossary for SWE/AI engineers** (17 ASR corrections, ~70 technical terms) is generated automatically. You can edit it directly or manage it via the REST API.

### Glossary types

| Type | Purpose | Behavior |
|---|---|---|
| `corrections` | Fix ASR misrecognitions | Text-replace Whisper output (e.g. "a pie" → "API") |
| `terms` | Translation term mappings | Injected into the LLM prompt to enforce consistent terminology |

### REST API

```bash
# List all entries
curl http://127.0.0.1:17070/glossary \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN"

# Add an ASR correction
curl -X POST http://127.0.0.1:17070/glossary/corrections \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"a pie","target":"API","description":"Common Whisper misrecognition"}'

# Add a term mapping
curl -X POST http://127.0.0.1:17070/glossary/terms \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"pull request","target":"プルリクエスト"}'

# Delete an entry
curl -X DELETE http://127.0.0.1:17070/glossary/corrections/a%20pie \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN"

# Submit a learning signal (kind = "correction" | "term")
curl -X POST http://127.0.0.1:17070/glossary/learn \
  -H "Authorization: Bearer $MEET_TRANSLATOR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"correction","source":"get hub","target":"GitHub"}'
```

The Meet UI also exposes a small **dictionary feedback** widget that sends the same glossary updates without leaving the call.

### Hot reload

`glossary.json` can be edited in any text editor.
The server **polls for file changes every 30 seconds** and reloads automatically — no restart needed.

### Background self-improvement

Every **5 translations**, the LLM analyses the accumulated results in the background:

1. Detects **ASR misrecognition candidates** and adds them to `corrections`
2. Detects **technical terms needing consistent translation** and adds them to `terms`

Auto-added entries are tagged with `"description": "auto-improved"`.
Remove unwanted entries via the REST API or by editing the file directly.

For the full API reference see [server/README.md](server/README.md).

---

## LLM Translation Benchmark

`cmd/benchmark` is a legacy MT-only comparison utility; it does not choose a model.

### Test cases

40 meeting-scene phrases in total: 20 English→Japanese and 20 Japanese→English.

| Category | Count | Content |
|---|---|---|
| greeting | 8 (4+4) | Greetings & small talk |
| technical | 12 (6+6) | pull request / API / CI / refactor, etc. |
| action | 8 (4+4) | Requests & instructions |
| question | 8 (4+4) | Questions |
| complex | 4 (2+2) | Multi-clause sentences |

### Quality metric: ChrF

Character n-gram F-score (average of n=1,2,3).
Works for both Japanese and English without morphological analysis, and reflects partial matches.

| Metric | Description |
|---|---|
| **Quality** | ChrF score (0.0–1.0) |
| **Latency** | Average latency per translation |
| **Score** | `quality×0.6 + speed×0.4` (speed = 1/(1+latency/300ms)) |

### Running the benchmark

```bash
# 1. Start the server with the model you want to measure
./server --llama-model bonsai-8b

# 2. Run the benchmark and save results
make bench OUTPUT=results/bonsai-8b.json

# 3. Repeat with another model (restart server first)
./server --llama-model qwen3:4b-q4_k_m
make bench OUTPUT=results/qwen3-4b.json

# 4. Compare results and display rankings
go run ./cmd/benchmark/ --compare results/
```

Additional flags:

```
--server  URL   Server address (default: http://127.0.0.1:17070)
--runs    N     Runs per test case (default: 3)
--warmup  N     Warm-up runs (default: 2)
--dir     STR   Direction filter: "en-ja" | "ja-en" | "both" (default: both)
--verbose       Show input/output for each test case
```

### Benchmark status

The repository's older benchmark is MT-only and uses an internal ChrF-like score. It is not SacreBLEU chrF2, ASR-only, or audio-to-caption evidence. Historical sample scores were removed because their model artifacts and run conditions are not pinned well enough to qualify a candidate. The benchmark CLI now requires `MEET_TRANSLATOR_API_TOKEN` and sends it as a bearer header. Use the separate three-track manifests in `eval/` for reproducible evaluation contracts; they currently contain synthetic fixtures only and do not measure model quality.

---

## Extension Setup

### Development build (load from source)

1. Open `chrome://extensions` in Chrome / Edge
2. Enable **Developer mode**
3. Click **"Load unpacked"** → select the `extension/` folder

### Release build (load from zip)

1. Download `meet-translator-extension.zip` and extract it to any folder
2. Open `chrome://extensions` in Chrome / Edge
3. Enable **Developer mode**
4. Click **"Load unpacked"** → select the extracted folder

### Configuration

Click the extension icon → **⚙ Settings** and configure:

| Setting | Description |
|---|---|
| Server URL | `http://127.0.0.1:17070` (default) |
| Local API token | Same value as `MEET_TRANSLATOR_API_TOKEN` in the server environment |
| Allowed extension origin | Copy the displayed value to `MEET_TRANSLATOR_EXTENSION_ORIGIN` |
| Source language | Auto-detect or specify a language |
| Target language | Language to translate into (default: Japanese) |
| **"Check server connection"** button | Verify the server is reachable |

---

## Usage

The popup opens the public caption page and separate private correction page. To share captions, the host selects the caption tab through Meet's normal screen-sharing UI; opening the page does not share it automatically. Do not share the correction page. Actual Meet integration and M1 model evaluation remain unfinished. See `docs/implementation-status.md` for the verified scope and remaining work.

---

## Release (GitHub Actions)

On merge to the `main` branch, conventional commits are analysed to automatically determine the version, create a git tag, and publish a GitHub Release.

| Commit prefix | Bump | Example |
|---|---|---|
| `feat:` | minor | `0.1.0 → 0.2.0` |
| `fix:` | patch | `0.1.0 → 0.1.1` |

When a release is created, binaries for each platform and the extension zip are built and uploaded to the GitHub Release automatically.

---

## CI

Two workflow types run across 4 platforms on every pull request:

**Test** (`test.yml`): build + Go tests  
**Execute Test** (`execute-test.yml`): separates build and execution environments to verify binary behaviour on a clean runner

| Platform | Runner |
|---|---|
| linux-amd64 | ubuntu-latest |
| linux-arm64 | ubuntu-24.04-arm |
| macos-arm64 | macos-latest (Apple Silicon) |
| windows-amd64 | windows-latest |

---

## Permissions

| Permission | Reason |
|---|---|
| `tabCapture` | Capture the audio stream from the Meet tab |
| `activeTab` | Get the active tab ID when the popup is used |
| `scripting` | Dynamically execute the content script |
| `storage` | Persist settings |
| `offscreen` | Run AudioContext (unavailable in MV3 service workers) in an Offscreen Document |
| `tabs` | Open the settings page |
| `http://localhost/*`, `http://127.0.0.1/*` | Allow requests to the loopback local server |

---

## Third-Party Licenses

This software embeds [whisper.cpp](https://github.com/ggerganov/whisper.cpp) **v1.8.4** and
[llama.cpp](https://github.com/ggerganov/llama.cpp) **b8699**, both released under the MIT License.

The model engine licenses do not determine the license for downloaded weights.
Review terms for the exact model and any converted artifact before use or
redistribution. The current Qwen reproduction baseline references Qwen's
Apache 2.0 card; Tencent's GGUF page displays Apache 2.0, while the exact
converted-artifact terms remain under review. Research-only models are not
included in the runtime registry.

See [THIRDPARTY.md](../THIRDPARTY.md) for full copyright notices and model license details.
