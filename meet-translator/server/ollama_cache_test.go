package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// setupOllamaDir は t.TempDir() 配下に Ollama のディレクトリ構造を作成する。
// OLLAMA_MODELS 環境変数をそのパスに設定して返す。
func setupOllamaDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("OLLAMA_MODELS", dir)
	return dir
}

func writeOllamaManifest(t *testing.T, modelsDir, name, tag string, layers []map[string]string) {
	t.Helper()
	manifestDir := filepath.Join(modelsDir, "manifests", "registry.ollama.ai", "library", name)
	if err := os.MkdirAll(manifestDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{"layers": layers})
	if err := os.WriteFile(filepath.Join(manifestDir, tag), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeBlobFile(t *testing.T, modelsDir, digest string) string {
	t.Helper()
	blobDir := filepath.Join(modelsDir, "blobs")
	if err := os.MkdirAll(blobDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// digest "sha256:abc" → filename "sha256-abc"
	filename := digest
	for i := 0; i < len(filename); i++ {
		if filename[i] == ':' {
			filename = filename[:i] + "-" + filename[i+1:]
			break
		}
	}
	path := filepath.Join(blobDir, filename)
	if err := os.WriteFile(path, []byte("fake gguf content"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// ─── findInOllamaCache ───────────────────────────────────────────────────────

func TestFindInOllamaCache_Hit(t *testing.T) {
	dir := setupOllamaDir(t)
	digest := "sha256:deadbeef1234"
	blobPath := writeBlobFile(t, dir, digest)

	writeOllamaManifest(t, dir, "qwen3", "8b-q4_k_m", []map[string]string{
		{"mediaType": "application/vnd.ollama.image.model", "digest": digest},
	})

	got, ok := findInOllamaCache("qwen3:8b-q4_k_m")
	if !ok {
		t.Fatal("expected cache hit")
	}
	if got != blobPath {
		t.Errorf("got %q, want %q", got, blobPath)
	}
}

func TestFindInOllamaCache_NoManifest(t *testing.T) {
	setupOllamaDir(t)
	_, ok := findInOllamaCache("notexist:7b")
	if ok {
		t.Error("expected cache miss for missing manifest")
	}
}

func TestFindInOllamaCache_InvalidJSON(t *testing.T) {
	dir := setupOllamaDir(t)
	manifestDir := filepath.Join(dir, "manifests", "registry.ollama.ai", "library", "bad")
	os.MkdirAll(manifestDir, 0o755)
	os.WriteFile(filepath.Join(manifestDir, "latest"), []byte("{not valid json}"), 0o644)

	_, ok := findInOllamaCache("bad:latest")
	if ok {
		t.Error("expected cache miss for invalid JSON")
	}
}

func TestFindInOllamaCache_BlobMissing(t *testing.T) {
	dir := setupOllamaDir(t)
	writeOllamaManifest(t, dir, "qwen3", "4b", []map[string]string{
		{"mediaType": "application/vnd.ollama.image.model", "digest": "sha256:nonexistent"},
	})

	_, ok := findInOllamaCache("qwen3:4b")
	if ok {
		t.Error("expected cache miss when blob file does not exist")
	}
}

func TestFindInOllamaCache_DefaultTag(t *testing.T) {
	dir := setupOllamaDir(t)
	digest := "sha256:aaaa1111"
	blobPath := writeBlobFile(t, dir, digest)

	// タグなし → "latest"
	writeOllamaManifest(t, dir, "llama3", "latest", []map[string]string{
		{"mediaType": "application/vnd.ollama.image.model", "digest": digest},
	})

	got, ok := findInOllamaCache("llama3") // タグ省略
	if !ok {
		t.Fatal("expected cache hit with default tag 'latest'")
	}
	if got != blobPath {
		t.Errorf("got %q, want %q", got, blobPath)
	}
}

func TestFindInOllamaCache_SkipsNonModelLayers(t *testing.T) {
	dir := setupOllamaDir(t)
	// モデル以外のレイヤーが含まれる場合
	writeOllamaManifest(t, dir, "llama3", "latest", []map[string]string{
		{"mediaType": "application/vnd.ollama.image.params", "digest": "sha256:params"},
		{"mediaType": "application/vnd.ollama.image.template", "digest": "sha256:tmpl"},
	})

	_, ok := findInOllamaCache("llama3:latest")
	if ok {
		t.Error("should not find non-model layers")
	}
}
