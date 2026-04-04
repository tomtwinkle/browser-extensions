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
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// ─── Whisper レジストリ ───────────────────────────────────────────────────────

var whisperRegistry = map[string]string{
	"tiny":           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
	"tiny.en":        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
	"base":           "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
	"base.en":        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
	"small":          "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
	"small.en":       "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
	"medium":         "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
	"medium.en":      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin",
	"large-v1":       "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v1.bin",
	"large-v2":       "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v2.bin",
	"large-v3":       "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
	"large-v3-turbo": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
}

// ─── Llama レジストリ ─────────────────────────────────────────────────────────

// LlamaEntry はレジストリ内の各モデルのメタデータ。
type LlamaEntry struct {
	URL         string
	Template    string // "qwen" | "qwen3" | "gemma"
	HasThinking bool   // Qwen3 の thinking モードに対応しているか
}

var llamaRegistry = map[string]LlamaEntry{
	// ── Qwen2.5 ──────────────────────────────────────────────────────────────
	"qwen2.5:3b-instruct-q4_k_m": {
		URL:      "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
		Template: "qwen",
	},
	"qwen2.5:7b-instruct-q4_k_m": {
		URL:      "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf",
		Template: "qwen",
	},
	"qwen2.5:14b-instruct-q4_k_m": {
		URL:      "https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF/resolve/main/qwen2.5-14b-instruct-q4_k_m.gguf",
		Template: "qwen",
	},

	// ── Qwen3 (thinking 対応) ────────────────────────────────────────────────
	"qwen3:0.6b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf",
		Template:    "qwen3",
		HasThinking: true,
	},
	"qwen3:1.7b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
		Template:    "qwen3",
		HasThinking: true,
	},
	"qwen3:4b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
		Template:    "qwen3",
		HasThinking: true,
	},
	"qwen3:8b-q4_k_m": {
		URL:         "https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf",
		Template:    "qwen3",
		HasThinking: true,
	},

	// ── Gemma 4 ──────────────────────────────────────────────────────────────
	"gemma4:e2b-q4_k_m": {
		URL:      "https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/google_gemma-4-E2B-it-Q4_K_M.gguf",
		Template: "gemma",
	},
	"gemma4:e4b-q4_k_m": {
		URL:      "https://huggingface.co/bartowski/google_gemma-4-E4B-it-GGUF/resolve/main/google_gemma-4-E4B-it-Q4_K_M.gguf",
		Template: "gemma",
	},
	"gemma4:26b-q4_k_m": {
		URL:      "https://huggingface.co/bartowski/google_gemma-4-26b-it-GGUF/resolve/main/google_gemma-4-26b-it-Q4_K_M.gguf",
		Template: "gemma",
	},
}

// templateFor はモデル名からチャットテンプレート識別子を返す。
// レジストリに存在しない場合はデフォルト "qwen" を返す。
func templateFor(modelName string) string {
	if e, ok := llamaRegistry[modelName]; ok {
		return e.Template
	}
	return "qwen"
}

// hasThinkingSupport はモデルが thinking モードに対応しているか返す。
func hasThinkingSupport(modelName string) bool {
	e, ok := llamaRegistry[modelName]
	return ok && e.HasThinking
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

// resolveWhisperModel はモデル名またはファイルパスを実際のパスに解決する。
func resolveWhisperModel(spec string) (string, error) {
	if spec == "" {
		return "", fmt.Errorf("WHISPER_MODEL が設定されていません\n  利用可能なモデル名: %s", sortedKeys(whisperRegistry))
	}
	if _, err := os.Stat(spec); err == nil {
		return spec, nil
	}
	if strings.ContainsAny(spec, "/\\") {
		return "", fmt.Errorf("ファイルが見つかりません: %s", spec)
	}

	url, ok := whisperRegistry[spec]
	if !ok {
		return "", fmt.Errorf("不明な whisper モデル名: %q\n  利用可能: %s", spec, sortedKeys(whisperRegistry))
	}

	dest := filepath.Join(modelCacheDir(), "whisper", "ggml-"+spec+".bin")
	if _, err := os.Stat(dest); err == nil {
		fmt.Printf("[model] whisper/%s: キャッシュ使用 %s\n", spec, dest)
		return dest, nil
	}

	fmt.Printf("[model] whisper/%s をダウンロード中...\n  %s\n", spec, url)
	if err := downloadModel(url, dest); err != nil {
		return "", fmt.Errorf("ダウンロード失敗 (%s): %w", spec, err)
	}
	return dest, nil
}

// resolveLlamaModel はモデル名またはファイルパスを実際のパスに解決する。
// 優先順位: 既存ファイル → Ollama キャッシュ → ローカルキャッシュ → ダウンロード
func resolveLlamaModel(spec string) (string, error) {
	if spec == "" {
		return "", fmt.Errorf("LLAMA_MODEL が設定されていません\n  利用可能なモデル名: %s", sortedLlamaKeys())
	}
	if _, err := os.Stat(spec); err == nil {
		return spec, nil
	}
	if strings.ContainsAny(spec, "/\\") {
		return "", fmt.Errorf("ファイルが見つかりません: %s", spec)
	}

	// Ollama キャッシュを優先確認
	if path, ok := findInOllamaCache(spec); ok {
		fmt.Printf("[model] llama/%s: Ollama キャッシュ使用 %s\n", spec, path)
		return path, nil
	}

	entry, ok := llamaRegistry[spec]
	if !ok {
		return "", fmt.Errorf("不明な llama モデル名: %q\n  利用可能: %s", spec, sortedLlamaKeys())
	}

	parts := strings.Split(entry.URL, "/")
	filename := parts[len(parts)-1]
	dest := filepath.Join(modelCacheDir(), "llama", filename)
	if _, err := os.Stat(dest); err == nil {
		fmt.Printf("[model] llama/%s: キャッシュ使用 %s\n", spec, dest)
		return dest, nil
	}

	fmt.Printf("[model] llama/%s をダウンロード中 (大容量ファイルです)...\n  %s\n", spec, entry.URL)
	if err := downloadModel(entry.URL, dest); err != nil {
		return "", fmt.Errorf("ダウンロード失敗 (%s): %w", spec, err)
	}
	return dest, nil
}

func sortedKeys(m map[string]string) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
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
