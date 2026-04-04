// ollama_cache.go – Ollama モデルキャッシュとの共有
//
// Ollama がダウンロード済みの GGUF モデルを再利用する。
// ~/.ollama/models/manifests/ でマニフェストを検索し、
// GGUF ブロブのファイルパスを返す。
//
// OLLAMA_MODELS 環境変数でディレクトリを上書き可能。

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type ollamaManifest struct {
	Layers []struct {
		MediaType string `json:"mediaType"`
		Digest    string `json:"digest"`
	} `json:"layers"`
}

// ollamaModelsDir は Ollama のモデルルートディレクトリを返す。
func ollamaModelsDir() string {
	if d := os.Getenv("OLLAMA_MODELS"); d != "" {
		return d
	}
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("USERPROFILE"), ".ollama", "models")
	default:
		return filepath.Join(os.Getenv("HOME"), ".ollama", "models")
	}
}

// findInOllamaCache は Ollama のコンテンツアドレス型ストアから
// モデルの GGUF ブロブファイルを探す。
//
// modelName は Ollama 形式: "qwen3:8b-q4_k_m" など。
// タグを省略した場合は "latest" を使用する。
func findInOllamaCache(modelName string) (string, bool) {
	name, tag, _ := strings.Cut(modelName, ":")
	if tag == "" {
		tag = "latest"
	}

	manifestPath := filepath.Join(
		ollamaModelsDir(), "manifests", "registry.ollama.ai", "library", name, tag,
	)
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", false
	}

	var m ollamaManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return "", false
	}

	for _, layer := range m.Layers {
		if layer.MediaType == "application/vnd.ollama.image.model" {
			// "sha256:abcd..." → "sha256-abcd..."
			blobName := strings.ReplaceAll(layer.Digest, ":", "-")
			blobPath := filepath.Join(ollamaModelsDir(), "blobs", blobName)
			if _, err := os.Stat(blobPath); err == nil {
				return blobPath, true
			}
		}
	}
	return "", false
}
