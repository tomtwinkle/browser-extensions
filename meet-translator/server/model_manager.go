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
	bonsai8BMLXModelRef  = "prism-ml/Ternary-Bonsai-8B-mlx-2bit"
	bonsai4BMLXModelRef  = "prism-ml/Ternary-Bonsai-4B-mlx-2bit"
	bonsai17BMLXModelRef = "prism-ml/Ternary-Bonsai-1.7B-mlx-2bit"
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
		ModelRef: "large-v3",
	},
	"whisperx-large-v3": {
		Backend:  asrBackendWhisperX,
		ModelRef: "large-v3",
	},
}

// ─── Llama レジストリ ─────────────────────────────────────────────────────────

// LlamaEntry はレジストリ内の各モデルのメタデータ。
type LlamaEntry struct {
	URL         string
	MLXModelRef string
	Template    string // "qwen" | "qwen3" | "gemma"
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
		Template:    "qwen3",
		HasThinking: true,
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

// templateFor はモデル名からチャットテンプレート識別子を返す。
// レジストリに存在しない場合はデフォルト "qwen" を返す。
func templateFor(modelName string) string {
	if e, ok := llamaRegistry[canonicalLlamaSpec(modelName)]; ok {
		return e.Template
	}
	return "qwen"
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
	if strings.ContainsAny(spec, "/\\") {
		return ResolvedWhisperModel{}, fmt.Errorf("file not found: %s", spec)
	}

	entry, ok := whisperRegistry[spec]
	if !ok {
		return ResolvedWhisperModel{}, fmt.Errorf("unknown whisper model: %q\n  available: %s", spec, sortedWhisperKeys())
	}

	if entry.Backend != asrBackendWhisperCPP {
		return ResolvedWhisperModel{
			Backend:      entry.Backend,
			Spec:         spec,
			ResolvedSpec: entry.ModelRef,
		}, nil
	}

	dest := filepath.Join(modelCacheDir(), "whisper", cacheFilenameForWhisperEntry(spec, entry))
	if _, err := os.Stat(dest); err == nil {
		logV("whisper/%s: using cache %s", spec, dest)
		return ResolvedWhisperModel{
			Backend:      asrBackendWhisperCPP,
			Spec:         spec,
			ResolvedSpec: dest,
		}, nil
	}

	fmt.Printf("[model] downloading whisper/%s...\n  %s\n", spec, entry.URL)
	if err := downloadModel(entry.URL, dest); err != nil {
		return ResolvedWhisperModel{}, fmt.Errorf("download failed (%s): %w", spec, err)
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
		keys = append(keys, k)
	}
	sort.Strings(keys)
	keys = append(keys, "sensevoice:<model-ref>", "whisperx:<model-name>")
	return strings.Join(keys, ", ")
}

func sortedLlamaKeys() string {
	keys := make([]string, 0, len(llamaRegistry))
	for k := range llamaRegistry {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

func resolveSpecialWhisperSpec(spec string) (ResolvedWhisperModel, bool, error) {
	if strings.HasPrefix(spec, "sensevoice:") {
		ref := strings.TrimSpace(strings.TrimPrefix(spec, "sensevoice:"))
		if ref == "" {
			return ResolvedWhisperModel{}, true, fmt.Errorf("sensevoice backend requires a model ref after sensevoice:")
		}
		return ResolvedWhisperModel{
			Backend:      asrBackendSenseVoice,
			Spec:         spec,
			ResolvedSpec: normalizeSenseVoiceModelRef(ref),
		}, true, nil
	}

	if strings.HasPrefix(spec, "whisperx:") {
		ref := strings.TrimSpace(strings.TrimPrefix(spec, "whisperx:"))
		if ref == "" {
			return ResolvedWhisperModel{}, true, fmt.Errorf("whisperx backend requires a model name after whisperx:")
		}
		return ResolvedWhisperModel{
			Backend:      asrBackendWhisperX,
			Spec:         spec,
			ResolvedSpec: ref,
		}, true, nil
	}

	return ResolvedWhisperModel{}, false, nil
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
