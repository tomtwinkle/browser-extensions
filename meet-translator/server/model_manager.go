// model_manager.go – モデルレジストリとパス解決
//
// 環境変数またはリクエストで指定されたモデル名を実際のファイルパスに解決する。
//
// 解決優先順位:
//   1. os.Stat で既存ファイルとして検索
//   2. (llama のみ) Ollama キャッシュを検索
//   3. ローカルキャッシュを確認
//   4. HuggingFace からダウンロード
//
// キャッシュディレクトリ:
//   Linux:   $XDG_CACHE_HOME/meet-translator/models  (or ~/.cache/...)
//   macOS:   ~/Library/Caches/meet-translator/models
//   Windows: %LOCALAPPDATA%\meet-translator\models
//   override: MODEL_CACHE_DIR 環境変数

package main

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

var (
	currentGOOS   = runtime.GOOS
	currentGOARCH = runtime.GOARCH
)

const (
	bonsai8BMLXModelRef     = "prism-ml/Ternary-Bonsai-8B-mlx-2bit"
	bonsai4BMLXModelRef     = "prism-ml/Ternary-Bonsai-4B-mlx-2bit"
	bonsai17BMLXModelRef    = "prism-ml/Ternary-Bonsai-1.7B-mlx-2bit"
	hyMT218BQ4KMURL         = "https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/1cd5208700acedef4ef93019b6cfc148b8522d45/Hy-MT2-1.8B-Q4_K_M.gguf"
	hyMT27BQ4KMURL          = "https://huggingface.co/tencent/Hy-MT2-7B-GGUF/resolve/ab8472660ac61fac25f1af43fac2599d52a8a775/Hy-MT2-7B-Q4_K_M.gguf"
	whisperXLatestModelRef  = "turbo"
	whisperXLargeV3ModelRef = "large-v3"
)

// ─── Whisper レジストリ ───────────────────────────────────────────────────────

var whisperRegistry = map[string]WhisperEntry{
	"tiny": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
		CacheFilename: "ggml-tiny.bin",
	},
	"tiny.en": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
		CacheFilename: "ggml-tiny.en.bin",
	},
	"base": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
		CacheFilename: "ggml-base.bin",
	},
	"base.en": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
		CacheFilename: "ggml-base.en.bin",
	},
	"small": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
		CacheFilename: "ggml-small.bin",
	},
	"small.en": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
		CacheFilename: "ggml-small.en.bin",
	},
	"medium": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
		CacheFilename: "ggml-medium.bin",
	},
	"medium.en": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin",
		CacheFilename: "ggml-medium.en.bin",
	},
	"large-v1": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v1.bin",
		CacheFilename: "ggml-large-v1.bin",
	},
	"large-v2": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v2.bin",
		CacheFilename: "ggml-large-v2.bin",
	},
	"large-v3": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
		CacheFilename: "ggml-large-v3.bin",
	},
	"large-v3-turbo": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
		CacheFilename: "ggml-large-v3-turbo.bin",
	},
	"kotoba-whisper": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/main/ggml-kotoba-whisper-v2.0.bin",
		CacheFilename: "ggml-kotoba-whisper-v2.0.bin",
	},
	"kotoba-whisper-q5_0": {
		Backend:       asrBackendWhisperCPP,
		URL:           "https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/main/ggml-kotoba-whisper-v2.0-q5_0.bin",
		CacheFilename: "ggml-kotoba-whisper-v2.0-q5_0.bin",
	},
	"kotoba-whisper-v2.2": {
		Backend:  asrBackendTransformersWhisper,
		ModelRef: "kotoba-tech/kotoba-whisper-v2.2",
	},
	"kotoba-tech/kotoba-whisper-v2.2": {
		Backend:  asrBackendTransformersWhisper,
		ModelRef: "kotoba-tech/kotoba-whisper-v2.2",
	},
	"kotoba-whisper-v2.2-faster": {
		Backend:  asrBackendWhisperX,
		ModelRef: "RoachLin/kotoba-whisper-v2.2-faster",
	},
	"RoachLin/kotoba-whisper-v2.2-faster": {
		Backend:  asrBackendWhisperX,
		ModelRef: "RoachLin/kotoba-whisper-v2.2-faster",
	},
	"sensevoice": {
		Backend:  asrBackendSenseVoice,
		ModelRef: "iic/SenseVoiceSmall",
	},
	"sensevoice-small": {
		Backend:  asrBackendSenseVoice,
		ModelRef: "iic/SenseVoiceSmall",
	},
	"whisperx": {
		Backend:  asrBackendWhisperX,
		ModelRef: whisperXLatestModelRef,
	},
	"whisperX": {
		Backend:  asrBackendWhisperX,
		ModelRef: whisperXLatestModelRef,
	},
	"whisperx-turbo": {
		Backend:  asrBackendWhisperX,
		ModelRef: whisperXLatestModelRef,
	},
	"whisperx-large-v3": {
		Backend:  asrBackendWhisperX,
		ModelRef: whisperXLargeV3ModelRef,
	},
	"whisperx-large-v3-turbo": {
		Backend:  asrBackendWhisperX,
		ModelRef: whisperXLatestModelRef,
	},
}

// legacyWhisperSpecs stay resolvable for explicit saved settings, but do not
// appear in the current model list. Their cache and automatic download behavior
// is unchanged; the warning makes the compatibility status visible at startup.
var legacyWhisperSpecs = map[string]string{
	"tiny":                                "below the current large-v3-turbo comparison floor",
	"tiny.en":                             "below the current large-v3-turbo comparison floor",
	"base":                                "below the current large-v3-turbo comparison floor",
	"base.en":                             "below the current large-v3-turbo comparison floor",
	"small":                               "below the current large-v3-turbo comparison floor",
	"small.en":                            "below the current large-v3-turbo comparison floor",
	"medium":                              "below the current large-v3-turbo comparison floor",
	"medium.en":                           "below the current large-v3-turbo comparison floor",
	"large-v1":                            "superseded by Whisper large-v3",
	"large-v2":                            "superseded by Whisper large-v3",
	"kotoba-whisper":                      "superseded by the author's Kotoba-Whisper v2.2 checkpoint",
	"kotoba-whisper-q5_0":                 "superseded by the author's Kotoba-Whisper v2.2 checkpoint",
	"kotoba-whisper-v2.2-faster":          "third-party conversion; use the author's source checkpoint for comparison",
	"RoachLin/kotoba-whisper-v2.2-faster": "third-party conversion; use the author's source checkpoint for comparison",
}

// ─── Llama レジストリ ─────────────────────────────────────────────────────────

// LlamaEntry はレジストリ内の各モデルのメタデータ。
type LlamaEntry struct {
	URL         string
	MLXModelRef string
	Template    string // "qwen" | "qwen3" | "gemma" | "hy" | "hy7"
	HasThinking bool   // Qwen3 の thinking モードに対応しているか
	NeedsPrism  bool   // PrismML ビルドが必要 (Q1_0_g128 量子化を使用するモデル)
}

var llamaRegistry = map[string]LlamaEntry{
	// ── Qwen2.5 ──────────────────────────────────────────────────────────────
	// NOTE: qwen2.5:3b は Qwen Research License（非商用専用）のため除外。
	//       Qwen2.5-7B 以上および Qwen3 全サイズは Apache 2.0。
	"qwen2.5:7b-instruct-q4_k_m": {
		URL:         "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf",
		MLXModelRef: "mlx-community/Qwen2.5-7B-Instruct-4bit",
		Template:    "qwen",
	},
	"qwen2.5:14b-instruct-q4_k_m": {
		URL:         "https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF/resolve/main/qwen2.5-14b-instruct-q4_k_m.gguf",
		MLXModelRef: "mlx-community/Qwen2.5-14B-Instruct-4bit",
		Template:    "qwen",
	},

	// ── Qwen3 (thinking 対応) ────────────────────────────────────────────────
	"qwen3:0.6b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/Qwen3-0.6B-4bit",
		Template:    "qwen3",
		HasThinking: true,
	},
	"qwen3:1.7b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/Qwen3-1.7B-4bit",
		Template:    "qwen3",
		HasThinking: true,
	},
	"qwen3:4b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/Qwen3-4B-4bit",
		Template:    "qwen3",
		HasThinking: true,
	},
	"qwen3:8b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/Qwen3-8B-4bit",
		Template:    "qwen3",
		HasThinking: true,
	},

	// ── Qwen3.5 (thinking 対応, Unsloth GGUF) ────────────────────────────────
	"qwen3.5:0.8b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/Qwen3.5-0.8B-MLX-4bit",
		Template:    "qwen35",
	},
	"qwen3.5:2b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/Qwen3.5-2B-MLX-4bit",
		Template:    "qwen3",
		HasThinking: true,
	},
	"qwen3.5:4b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/Qwen3.5-4B-MLX-4bit",
		Template:    "qwen3",
		HasThinking: true,
	},
	"qwen3.5:9b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/Qwen3.5-9B-MLX-4bit",
		Template:    "qwen3",
		HasThinking: true,
	},

	// ── Hy-MT2 (Tencent Hy, official repo IDs resolve to Q4_K_M GGUF) ────────
	"tencent/Hy-MT2-1.8B": {
		URL:      hyMT218BQ4KMURL,
		Template: "hy",
	},
	"Hy-MT2-1.8B": {
		URL:      hyMT218BQ4KMURL,
		Template: "hy",
	},
	"Hy-MT2-1.8B-GGUF": {
		URL:      hyMT218BQ4KMURL,
		Template: "hy",
	},
	"tencent/Hy-MT2-1.8B-GGUF": {
		URL:      hyMT218BQ4KMURL,
		Template: "hy",
	},
	"tencent/Hy-MT2-7B": {
		URL:      hyMT27BQ4KMURL,
		Template: "hy7",
	},
	"Hy-MT2-7B": {
		URL:      hyMT27BQ4KMURL,
		Template: "hy7",
	},
	"Hy-MT2-7B-GGUF": {
		URL:      hyMT27BQ4KMURL,
		Template: "hy7",
	},
	"Hy-MT2-7BGGUF": {
		URL:      hyMT27BQ4KMURL,
		Template: "hy7",
	},
	"tencent/Hy-MT2-7B-GGUF": {
		URL:      hyMT27BQ4KMURL,
		Template: "hy7",
	},

	// ── CALM3 (日英特化, CyberAgent, Apache 2.0) ──────────────────────────────
	"calm3:22b-q4_k_m": {
		URL:         "https://huggingface.co/grapevine-AI/CALM3-22B-Chat-GGUF/resolve/main/calm3-22b-chat-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/calm3-22b-chat-4bit",
		Template:    "qwen",
	},

	// ── Bonsai 8B (PrismML 1-bit, Qwen3-8B ベース, Apache 2.0) ──────────────
	// Q1_0_g128 形式: ~1.15 GB
	// 注意: 現在のビルドは公式 ggml-org/llama.cpp を使用するため Q1_0_g128 非対応。
	// Bonsai-8B は llama_model_load 時に "unsupported quantization type" エラーで失敗する。
	"bonsai-8b": {
		URL:         "https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/main/Bonsai-8B.gguf",
		MLXModelRef: bonsai8BMLXModelRef,
		Template:    "qwen3",
		HasThinking: true,
		NeedsPrism:  true, // Q1_0_g128 quantization requires PrismML build (make prism)
	},
	"bonsai-4b": {
		MLXModelRef: bonsai4BMLXModelRef,
		Template:    "qwen3",
		HasThinking: true,
	},
	"bonsai-1.7b": {
		MLXModelRef: bonsai17BMLXModelRef,
		Template:    "qwen3",
		HasThinking: true,
	},

	// ── Gemma 4 ──────────────────────────────────────────────────────────────
	"gemma4:e2b-q4_k_m": {
		URL:         "https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/google_gemma-4-E2B-it-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/gemma-4-e2b-it-4bit",
		Template:    "gemma",
	},
	"gemma4:e4b-q4_k_m": {
		URL:         "https://huggingface.co/bartowski/google_gemma-4-E4B-it-GGUF/resolve/main/google_gemma-4-E4B-it-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/gemma-4-e4b-it-4bit",
		Template:    "gemma",
	},
	"gemma4:26b-q4_k_m": {
		URL:         "https://huggingface.co/bartowski/google_gemma-4-26b-it-GGUF/resolve/main/google_gemma-4-26b-it-Q4_K_M.gguf",
		MLXModelRef: "mlx-community/gemma-4-26b-a4b-it-4bit",
		Template:    "gemma",
	},
}

// legacyLlamaSpecs retains explicit configuration and cache compatibility.
// These aliases are omitted from sortedLlamaKeys, the user-visible list of
// current comparison choices. Qwen3.5 0.8B remains the existing reproduction
// baseline until a replacement passes local quality and M1 integration gates.
var legacyLlamaSpecs = map[string]string{
	"qwen2.5:7b-instruct-q4_k_m":  "superseded by newer Qwen generations and outside the 0.8B-4B comparison band",
	"qwen2.5:14b-instruct-q4_k_m": "superseded by newer Qwen generations and outside the 0.8B-4B comparison band",
	"qwen3:0.6b-q4_k_m":           "superseded by Qwen3.5/Qwen3.8; no model-specific qualification in this project",
	"qwen3:1.7b-q4_k_m":           "superseded by Qwen3.5/Qwen3.8; no model-specific qualification in this project",
	"qwen3:4b-q4_k_m":             "superseded by Qwen3.5/Qwen3.8; no model-specific qualification in this project",
	"qwen3:8b-q4_k_m":             "superseded by Qwen3.5/Qwen3.8 and outside the 0.8B-4B comparison band",
	"qwen3.5:0.8b-q4_k_m":         "retained only as the reproduction baseline; not a current experimental recommendation",
	"qwen3.5:2b-q4_k_m":           "thinking mode and the exact GGUF prompt contract are not verified by this project",
	"qwen3.5:4b-q4_k_m":           "thinking mode and the exact GGUF prompt contract are not verified by this project",
	"qwen3.5:9b-q4_k_m":           "outside the 0.8B-4B local translation comparison band",
	"tencent/Hy-MT2-7B":           "outside the 0.8B-4B local translation comparison band",
	"Hy-MT2-1.8B":                 "duplicate spelling of the canonical tencent/Hy-MT2-1.8B comparison candidate",
	"Hy-MT2-1.8B-GGUF":            "duplicate spelling of the canonical tencent/Hy-MT2-1.8B comparison candidate",
	"tencent/Hy-MT2-1.8B-GGUF":    "duplicate spelling of the canonical tencent/Hy-MT2-1.8B comparison candidate",
	"Hy-MT2-7B":                   "outside the 0.8B-4B local translation comparison band",
	"Hy-MT2-7B-GGUF":              "outside the 0.8B-4B local translation comparison band",
	"Hy-MT2-7BGGUF":               "outside the 0.8B-4B local translation comparison band",
	"tencent/Hy-MT2-7B-GGUF":      "outside the 0.8B-4B local translation comparison band",
	"calm3:22b-q4_k_m":            "outside the 0.8B-4B local translation comparison band and the 10 GiB inference-process budget",
	"bonsai-8b":                   "outside the 0.8B-4B band and depends on an unqualified nonstandard quantization/runtime",
	"bonsai-4b":                   "community MLX conversion is not an evaluated comparison candidate",
	"bonsai-1.7b":                 "community MLX conversion is not an evaluated comparison candidate",
	"gemma4:e2b-q4_k_m":           "multimodal model's text-only load path and template are not verified in this application",
	"gemma4:e4b-q4_k_m":           "multimodal model's text-only load path and template are not verified in this application",
	"gemma4:26b-q4_k_m":           "outside the 0.8B-4B local translation comparison band and the 10 GiB inference-process budget",
}

// templateFor はモデル名からチャットテンプレート識別子を返す。
// レジストリに存在しない場合はデフォルト "qwen" を返す。
func templateFor(modelName string) string {
	if e, ok := llamaRegistry[canonicalLlamaSpec(modelName)]; ok {
		return e.Template
	}
	return "qwen"
}

func canonicalWhisperSpec(spec string) string {
	spec = strings.TrimSpace(spec)
	if _, ok := whisperRegistry[spec]; ok {
		return spec
	}
	if strings.ContainsAny(spec, "/\\") {
		return spec
	}
	lower := strings.ToLower(spec)
	if _, ok := whisperRegistry[lower]; ok {
		return lower
	}
	return spec
}

// hasThinkingSupport はモデルが thinking モードに対応しているか返す。
func hasThinkingSupport(modelName string) bool {
	e, ok := llamaRegistry[canonicalLlamaSpec(modelName)]
	return ok && e.HasThinking
}

func canonicalLlamaSpec(spec string) string {
	spec = strings.TrimSpace(spec)
	if _, ok := llamaRegistry[spec]; ok {
		return spec
	}
	for alias, entry := range llamaRegistry {
		if entry.MLXModelRef == spec {
			return alias
		}
	}
	return spec
}

func prefersMLX(entry LlamaEntry) bool {
	return entry.MLXModelRef != "" && currentGOOS == "darwin" && currentGOARCH == "arm64"
}

// ─── キャッシュディレクトリ ────────────────────────────────────────────────────

// modelCacheDir はプラットフォーム標準のキャッシュディレクトリを返す。
// MODEL_CACHE_DIR 環境変数で上書き可能。
func modelCacheDir() string {
	if d := os.Getenv("MODEL_CACHE_DIR"); d != "" {
		return d
	}
	var base string
	switch runtime.GOOS {
	case "windows":
		if v := os.Getenv("LOCALAPPDATA"); v != "" {
			base = v
		} else {
			base = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
		}
	case "darwin":
		base = filepath.Join(os.Getenv("HOME"), "Library", "Caches")
	default:
		if v := os.Getenv("XDG_CACHE_HOME"); v != "" {
			base = v
		} else {
			base = filepath.Join(os.Getenv("HOME"), ".cache")
		}
	}
	return filepath.Join(base, "meet-translator", "models")
}

// ─── モデル解決 ───────────────────────────────────────────────────────────────

// resolveWhisperModel はモデル名またはファイルパスを実際のバックエンド設定に解決する。
func resolveWhisperModel(spec string) (ResolvedWhisperModel, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return ResolvedWhisperModel{}, fmt.Errorf("whisper model not specified\n  available models: %s", sortedWhisperKeys())
	}
	if _, err := os.Stat(spec); err == nil {
		return ResolvedWhisperModel{
			Backend:      asrBackendWhisperCPP,
			Spec:         spec,
			ResolvedSpec: spec,
		}, nil
	}

	if resolved, ok, err := resolveSpecialWhisperSpec(spec); ok || err != nil {
		return resolved, err
	}
	canonicalSpec := canonicalWhisperSpec(spec)
	entry, ok := whisperRegistry[canonicalSpec]
	if !ok {
		if strings.ContainsAny(spec, "/\\") {
			return ResolvedWhisperModel{}, fmt.Errorf("file not found: %s", spec)
		}
		return ResolvedWhisperModel{}, fmt.Errorf("unknown whisper model: %q\n  available: %s", spec, sortedWhisperKeys())
	}
	if reason := legacyWhisperSpecs[canonicalSpec]; reason != "" {
		fmt.Fprintf(os.Stderr, "[model] %q is a compatibility-only ASR alias: %s\n", spec, reason)
	}

	if entry.Backend != asrBackendWhisperCPP {
		return ResolvedWhisperModel{
			Backend:      entry.Backend,
			Spec:         spec,
			ResolvedSpec: resolvedPythonWhisperModelRef(canonicalSpec, entry),
		}, nil
	}

	dest := filepath.Join(modelCacheDir(), "whisper", cacheFilenameForWhisperEntry(canonicalSpec, entry))
	if _, err := os.Stat(dest); err == nil {
		logV("whisper/%s: using cache %s", canonicalSpec, dest)
		return ResolvedWhisperModel{
			Backend:      asrBackendWhisperCPP,
			Spec:         spec,
			ResolvedSpec: dest,
		}, nil
	}

	fmt.Printf("[model] downloading whisper/%s...\n  %s\n", canonicalSpec, entry.URL)
	if err := downloadModel(entry.URL, dest); err != nil {
		return ResolvedWhisperModel{}, fmt.Errorf("download failed (%s): %w", canonicalSpec, err)
	}
	return ResolvedWhisperModel{
		Backend:      asrBackendWhisperCPP,
		Spec:         spec,
		ResolvedSpec: dest,
	}, nil
}

// resolveLlamaModel はモデル名またはファイルパスを実際のバックエンド設定に解決する。
// 優先順位: 既存ファイル → Ollama キャッシュ → ローカルキャッシュ → ダウンロード。
// Apple Silicon では MLX 対応モデルを優先する。
func resolveLlamaModel(spec string) (ResolvedLlamaModel, error) {
	if spec == "" {
		return ResolvedLlamaModel{}, fmt.Errorf("llama model not specified\n  available models: %s", sortedLlamaKeys())
	}
	if _, err := os.Stat(spec); err == nil {
		return ResolvedLlamaModel{
			Backend:      llmBackendLlamaCPP,
			Spec:         spec,
			ResolvedSpec: spec,
		}, nil
	}

	canonicalSpec := canonicalLlamaSpec(spec)
	entry, ok := llamaRegistry[canonicalSpec]
	if reason := legacyLlamaSpecs[canonicalSpec]; reason != "" {
		fmt.Fprintf(os.Stderr, "[model] %q is a legacy translation entry: %s\n", spec, reason)
	}
	if ok && prefersMLX(entry) {
		return ResolvedLlamaModel{
			Backend:      llmBackendMLX,
			Spec:         spec,
			ResolvedSpec: entry.MLXModelRef,
		}, nil
	}

	// Ollama キャッシュを優先確認
	if path, ok := findInOllamaCache(canonicalSpec); ok {
		logV("llama/%s: using Ollama cache %s", canonicalSpec, path)
		return ResolvedLlamaModel{
			Backend:      llmBackendLlamaCPP,
			Spec:         spec,
			ResolvedSpec: path,
		}, nil
	}

	if !ok {
		if strings.ContainsAny(spec, "/\\") {
			return ResolvedLlamaModel{}, fmt.Errorf("file not found: %s", spec)
		}
		return ResolvedLlamaModel{}, fmt.Errorf("unknown llama model: %q\n  available: %s", spec, sortedLlamaKeys())
	}

	if entry.URL == "" {
		return ResolvedLlamaModel{}, fmt.Errorf("model %q requires Apple Silicon MLX (darwin/arm64)", spec)
	}

	parts := strings.Split(entry.URL, "/")
	filename := parts[len(parts)-1]
	dest := filepath.Join(modelCacheDir(), "llama", filename)
	if _, err := os.Stat(dest); err == nil {
		logV("llama/%s: using cache %s", canonicalSpec, dest)
		return ResolvedLlamaModel{
			Backend:      llmBackendLlamaCPP,
			Spec:         spec,
			ResolvedSpec: dest,
		}, nil
	}

	fmt.Printf("[model] downloading llama/%s (large file)...\n  %s\n", canonicalSpec, entry.URL)
	if err := downloadModel(entry.URL, dest); err != nil {
		return ResolvedLlamaModel{}, fmt.Errorf("download failed (%s): %w", canonicalSpec, err)
	}
	return ResolvedLlamaModel{
		Backend:      llmBackendLlamaCPP,
		Spec:         spec,
		ResolvedSpec: dest,
	}, nil
}

func sortedWhisperKeys() string {
	keys := make([]string, 0, len(whisperRegistry)+2)
	for k := range whisperRegistry {
		if _, legacy := legacyWhisperSpecs[k]; !legacy {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	keys = append(keys, "sensevoice:<model-ref>", "whisperx:<model-name>")
	return strings.Join(keys, ", ")
}

func sortedLlamaKeys() string {
	keys := make([]string, 0, len(llamaRegistry))
	for k := range llamaRegistry {
		if _, legacy := legacyLlamaSpecs[k]; !legacy {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

func resolveSpecialWhisperSpec(spec string) (ResolvedWhisperModel, bool, error) {
	spec = strings.TrimSpace(spec)
	lower := strings.ToLower(spec)

	if strings.HasPrefix(lower, "sensevoice:") {
		ref := strings.TrimSpace(spec[len("sensevoice:"):])
		if ref == "" {
			return ResolvedWhisperModel{}, true, fmt.Errorf("sensevoice backend requires a model ref after sensevoice:")
		}
		return ResolvedWhisperModel{
			Backend:      asrBackendSenseVoice,
			Spec:         spec,
			ResolvedSpec: normalizeSenseVoiceModelRef(ref),
		}, true, nil
	}

	if strings.HasPrefix(lower, "whisperx:") {
		ref := strings.TrimSpace(spec[len("whisperx:"):])
		if ref == "" {
			return ResolvedWhisperModel{}, true, fmt.Errorf("whisperx backend requires a model name after whisperx:")
		}
		return ResolvedWhisperModel{
			Backend:      asrBackendWhisperX,
			Spec:         spec,
			ResolvedSpec: normalizeWhisperXModelRef(ref),
		}, true, nil
	}

	return ResolvedWhisperModel{}, false, nil
}

func resolvedPythonWhisperModelRef(spec string, entry WhisperEntry) string {
	if entry.ModelRef != "" {
		if entry.Backend == asrBackendWhisperX {
			return normalizeWhisperXModelRef(entry.ModelRef)
		}
		return entry.ModelRef
	}
	if entry.Backend == asrBackendWhisperX {
		return normalizeWhisperXModelRef(spec)
	}
	return spec
}

// WhisperX/faster-whisper exposes the latest OpenAI Whisper checkpoint as
// "turbo", while the native whisper.cpp backend uses the server-facing
// "large-v3-turbo" naming. Normalize the common server alias here so both
// backends can be selected consistently.
func normalizeWhisperXModelRef(ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ref
	}
	switch strings.ToLower(ref) {
	case "large-v3-turbo":
		return whisperXLatestModelRef
	default:
		return ref
	}
}

func normalizeSenseVoiceModelRef(ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ref
	}
	if strings.Contains(ref, "/") || strings.Contains(ref, "\\") {
		return ref
	}
	return "iic/" + ref
}

func cacheFilenameForWhisperEntry(spec string, entry WhisperEntry) string {
	if entry.CacheFilename != "" {
		return entry.CacheFilename
	}
	if entry.URL != "" {
		return path.Base(strings.Split(entry.URL, "?")[0])
	}
	return "ggml-" + spec + ".bin"
}
