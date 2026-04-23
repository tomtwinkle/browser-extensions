# meet-translator – Google Meet Auto-Translate Chat

A Chrome / Edge extension (Manifest V3) that captures Google Meet audio in real time,
transcribes and translates it, and automatically posts the text to the Meet chat.

**Zero dependency on external services.** whisper.cpp and llama.cpp are embedded in the
local server so all inference runs entirely on your machine.

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
[ background.js ]  ── fetch POST /transcribe-and-translate
       │
       ▼
[ meet-translator-server ]  ← single binary (Go + CGo)
  ├─ whisper.cpp (embedded) ── speech-to-text
  └─ llama.cpp   (embedded) ── LLM translation
       │
       ▼
[ content.js ]  ── posts translated text to the Meet chat DOM
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
│   ├── content.js            Content Script: Meet chat DOM operations
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
make prism GPU=cpu    # PrismML binary only (needed for bonsai-8b / server-prism)
```

`make` automatically clones and cmake-builds whisper.cpp and llama.cpp on first run,
refreshes those vendored checkouts when the pinned upstream versions change after a `git pull`,
and produces both `server` and `server-prism`.

### Rebuilding

After making changes, choose the appropriate command:

| Command | When to use |
|---|---|
| `make build` | Rebuild only the standard binary (`server`) |
| `make prism` | Rebuild only the PrismML binary (`server-prism`) for `bonsai-8b` |
| `make` / `make all` | Rebuild both binaries so autoconfig and release-like setups can step into `bonsai-8b` automatically |
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

### First run (automatic model selection)

Running without model overrides starts from the conservative floor
`large-v3-turbo` + `qwen3.5:0.8b-q4_k_m`, then **steps up to `bonsai-8b` and larger models when RAM/GPU allow**, and saves the chosen pair to a config file.

```bash
./meet-translator-server
```

Release archives and `make` bundle the standard binary plus the PrismML companion binary side by side, so `bonsai-8b` can switch automatically when selected.

Auto-selected models (with GPU):

| RAM | whisper | llama |
|---|---|---|
| ≥ 64 GB | `large-v3` | `calm3:22b-q4_k_m` |
| ≥ 32 GB | `large-v3-turbo` | `calm3:22b-q4_k_m` |
| ≥ 16 GB | `large-v3-turbo` | `qwen3:8b-q4_k_m` |
| ≥  8 GB | `large-v3-turbo` | `bonsai-8b` |
| < 8 GB  | `large-v3-turbo` | `qwen3.5:0.8b-q4_k_m` |

CPU-only:

| RAM | whisper | llama |
|---|---|---|
| ≥ 8 GB | `large-v3-turbo` | `bonsai-8b` |
| < 8 GB | `large-v3-turbo` | `qwen3.5:0.8b-q4_k_m` |

### Specifying models manually

```bash
./meet-translator-server \
  --whisper-model large-v3-turbo \
  --llama-model qwen3.5:0.8b-q4_k_m
```

If the model is not present locally it is **downloaded automatically from HuggingFace**.
The specified models are saved to the config file so **subsequent runs need no arguments**.

```bash
./meet-translator-server   # subsequent runs work without flags
```

### Sharing the Ollama cache

If you already have GGUF models fetched via Ollama, the server detects and uses them automatically — no extra download needed.

### Key startup flags

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--port` | `PORT` | `7070` | Listen port |
| `--whisper-model` | `WHISPER_MODEL` | `auto` (`large-v3-turbo` floor) | Whisper model name or file path |
| `--llama-model` | `LLAMA_MODEL` | `auto` (`qwen3.5:0.8b-q4_k_m` floor) | LLM model name or file path |
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
curl http://localhost:7070/health
```

---

## Supported Models

### Whisper models (speech recognition)

Specify a model name with `--whisper-model` and it will be downloaded automatically.

| Model | Size | Accuracy |
|---|---|---|
| `tiny` | 75 MB | △ |
| `base` | 142 MB | ○ |
| `small` | 466 MB | ○ |
| `medium` | 1.5 GB | ◎ |
| `large-v3` | 3.1 GB | ◎◎ |
| `large-v3-turbo` | 809 MB | ◎ **default floor** (fast) |
| `kotoba-whisper` | 3.1 GB | ◎◎ Japanese-focused Kotoba-Whisper v2.0 |
| `kotoba-whisper-q5_0` | ≈ 1.0 GB | ◎ Quantized Kotoba-Whisper v2.0 |
| `sensevoice` | model-managed | ◎ Fast multilingual ASR via local Python worker |
| `whisperx` | model-managed | ◎ WhisperX large-v3 via local Python worker |

Advanced forms are also supported: `sensevoice:<model-ref>` and `whisperx:<model-name>`.

SenseVoice / WhisperX use the local Python worker. If `uv` is installed, the worker can provision an isolated environment automatically. Otherwise, install the local Python dependencies first and make sure `ffmpeg` is available on your `PATH`:

```bash
cd server
python3 -m pip install -r ./python/requirements-asr.txt
```

### LLM models (translation)

Specify a model name with `--llama-model` and it will be downloaded automatically.

| Model | Size | License | Notes |
|---|---|---|---|
| `qwen3.5:0.8b-q4_k_m` | ≈ 0.6 GB | Apache 2.0 | **Default floor**, Thinking-capable |
| `bonsai-8b` | ≈ 1.15 GB / MLX repo | Apache 2.0 | **First step-up**, Thinking-capable, MLX on Apple Silicon, PrismML elsewhere |
| `bonsai-4b` | MLX repo | Apache 2.0 | Apple Silicon-only MLX Bonsai, Thinking-capable |
| `bonsai-1.7b` | MLX repo | Apache 2.0 | Apple Silicon-only MLX Bonsai, Thinking-capable |
| `qwen3:8b-q4_k_m` | ≈ 5.2 GB | Apache 2.0 | Higher tier, Thinking-capable |
| `calm3:22b-q4_k_m` | ≈ 13 GB | Apache 2.0 | Top tier, Japanese/English specialist, requires 16 GB VRAM |
| `gemma4:e4b-q4_k_m` | ≈ 2.6 GB | Apache 2.0 | Fast & lightweight (Google Gemma 4) |
| `gemma4:e2b-q4_k_m` | ≈ 1.3 GB | Apache 2.0 | Lightest (Google Gemma 4) |
| `gemma4:26b-q4_k_m` | ≈ 16 GB | Apache 2.0 | High accuracy (Google Gemma 4) |
| `qwen3.5:2b-q4_k_m` | ≈ 1.4 GB | Apache 2.0 | Thinking-capable |
| `qwen3.5:4b-q4_k_m` | ≈ 3.2 GB | Apache 2.0 | Thinking-capable |
| `qwen3.5:9b-q4_k_m` | ≈ 5.3 GB | Apache 2.0 | High accuracy, Thinking-capable |
| `qwen3:0.6b-q4_k_m` | ≈ 0.4 GB | Apache 2.0 | Thinking-capable |
| `qwen3:1.7b-q4_k_m` | ≈ 1.1 GB | Apache 2.0 | Thinking-capable |
| `qwen3:4b-q4_k_m` | ≈ 2.6 GB | Apache 2.0 | Thinking-capable |
| `qwen2.5:7b-instruct-q4_k_m` | ≈ 4.7 GB | Apache 2.0 | Stable |
| `qwen2.5:14b-instruct-q4_k_m` | ≈ 8.7 GB | Apache 2.0 | High accuracy |

> **Note**: On Apple Silicon (`darwin/arm64`), models with a known MLX counterpart
> (`bonsai-*`, `qwen2.5:*`, `qwen3:*`, `qwen3.5:*`, `calm3:*`, `gemma4:*`)
> automatically switch to the local MLX backend. If `uv` is installed, the worker can
> provision MLX dependencies automatically. Otherwise install them first with
> `python3 -m pip install -r ./python/requirements-llm.txt`.
> On other platforms, `bonsai-8b` still uses the
> [PrismML fork of llama.cpp](https://github.com/PrismML-Eng/llama.cpp),
> while `bonsai-4b` and `bonsai-1.7b` are unavailable.
> Release archives and `make` bundle the required companion binary automatically.
> If you build only the standard binary, run `make prism` before using `bonsai-8b`.
> Known MLX repo IDs are also accepted directly, for example
> `prism-ml/Ternary-Bonsai-8B-mlx-2bit` or `mlx-community/Qwen3-0.6B-4bit`.

You can also specify a file path directly:

```bash
./meet-translator-server --llama-model /path/to/model.gguf
```

### Thinking mode (Qwen3 / Qwen3.5)

Qwen3 and Qwen3.5 models support **Thinking mode**.
The model reasons inside `<think>...</think>` before producing the translation, which improves quality at the cost of higher latency.

Control it with the `llama_options` field in the request:

```json
{"thinking": true}   // Thinking enabled (default for Qwen3/Qwen3.5)
{"thinking": false}  // Thinking disabled (faster)
```

---

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
curl http://localhost:7070/glossary

# Add an ASR correction
curl -X POST http://localhost:7070/glossary/corrections \
  -H "Content-Type: application/json" \
  -d '{"source":"a pie","target":"API","description":"Common Whisper misrecognition"}'

# Add a term mapping
curl -X POST http://localhost:7070/glossary/terms \
  -H "Content-Type: application/json" \
  -d '{"source":"pull request","target":"プルリクエスト"}'

# Delete an entry
curl -X DELETE http://localhost:7070/glossary/corrections/a%20pie

# Submit a learning signal (kind = "correction" | "term")
curl -X POST http://localhost:7070/glossary/learn \
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

`cmd/benchmark` measures translation quality and speed and provides reference data for the autoconfig ladder.

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
--server  URL   Server address (default: http://localhost:7070)
--runs    N     Runs per test case (default: 3)
--warmup  N     Warm-up runs (default: 2)
--dir     STR   Direction filter: "en-ja" | "ja-en" | "both" (default: both)
--verbose       Show input/output for each test case
```

### Sample comparison output (macOS Apple M1 Max, GPU Metal, 2026-04)

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

> **Notes:**
> - `qwen3.5:0.8b-q4_k_m` tops this speed-weighted benchmark, but autoconfig uses a staged ladder rather than raw rank:
>   floor → `bonsai-8b` → larger models.
> - `bonsai-8b` scored low in the GPU benchmark due to frequent thinking-mode timeouts.
>   It is still kept as the first step-up because it preserves a small download/footprint before jumping to much larger models.
> - `gemma4:e4b` performs poorly on EN↔JA translation tasks (quality 0.256) and is excluded from autoconfig.
> - Actual numbers vary depending on the execution environment and GPU availability.

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
| Server URL | `http://localhost:7070` (default) |
| Source language | Auto-detect or specify a language |
| Target language | Language to translate into (default: Japanese) |
| **"Check server connection"** button | Verify the server is reachable |

---

## Usage

1. Join a meeting at `https://meet.google.com/`
2. Click the extension icon and press **"Start Auto-Translate Chat"**
3. Audio capture begins and translated text is posted to chat approximately every 5 seconds
   - Silent intervals are skipped by VAD, which also adapts to the session noise floor to suppress low-SNR / non-speech chunks
   - When Meet highlights the current speaker, their display name is prefixed in chat and overlay output
   - Use the in-call **dictionary feedback** button on the Meet screen to register misheard words or incorrect translated terms into the glossary immediately
   - Consecutive short utterances from the same highlighted speaker are batched briefly and sent together after a short pause
   - The chat panel is opened automatically if it is closed
4. Press **"Stop Auto-Translate Chat"** to stop

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
| `http://localhost:7070/*` | Allow requests to the local server |

---

## Third-Party Licenses

This software embeds [whisper.cpp](https://github.com/ggerganov/whisper.cpp) **v1.8.4** and
[llama.cpp](https://github.com/ggerganov/llama.cpp) **b8699**, both released under the MIT License.

Models downloaded at runtime (Whisper, Qwen3.5, Qwen3, Qwen2.5-7B/14B, Gemma4) are released
under MIT or Apache 2.0. Qwen2.5-3B is excluded from the registry as it carries a
non-commercial-only license.

See [THIRDPARTY.md](../THIRDPARTY.md) for full copyright notices and model license details.
