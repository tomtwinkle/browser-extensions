package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ─── helpers ─────────────────────────────────────────────────────────────────

func setTestModelCacheDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("MODEL_CACHE_DIR", dir)
	return dir
}

// setupWhisperCache は指定モデル名に対応するキャッシュファイルを事前作成する。
func setupWhisperCache(t *testing.T, cacheDir, modelName string) string {
	t.Helper()
	dest := filepath.Join(cacheDir, "whisper", "ggml-"+modelName+".bin")
	os.MkdirAll(filepath.Dir(dest), 0o755)
	os.WriteFile(dest, []byte("cached whisper model"), 0o644)
	return dest
}

// setupLlamaCache はモデル URL の末尾ファイル名でキャッシュファイルを事前作成する。
func setupLlamaCache(t *testing.T, cacheDir, filename string) string {
	t.Helper()
	dest := filepath.Join(cacheDir, "llama", filename)
	os.MkdirAll(filepath.Dir(dest), 0o755)
	os.WriteFile(dest, []byte("cached llama model"), 0o644)
	return dest
}

// startFakeModelServer は常に 200 OK で固定データを返すテスト用 HTTP サーバーを起動する。
func startFakeModelServer(t *testing.T, content string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(content)))
		fmt.Fprint(w, content)
	}))
}

// patchWhisperRegistry はテスト中だけ whisperRegistry を差し替える。
func patchWhisperRegistry(t *testing.T, m map[string]string) {
	t.Helper()
	orig := whisperRegistry
	whisperRegistry = m
	t.Cleanup(func() { whisperRegistry = orig })
}

// patchLlamaRegistry はテスト中だけ llamaRegistry を差し替える。
func patchLlamaRegistry(t *testing.T, m map[string]LlamaEntry) {
	t.Helper()
	orig := llamaRegistry
	llamaRegistry = m
	t.Cleanup(func() { llamaRegistry = orig })
}

// ─── resolveWhisperModel ─────────────────────────────────────────────────────

func TestResolveWhisperModel_ExistingFile(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "ggml-*.bin")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()

	got, err := resolveWhisperModel(f.Name())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != f.Name() {
		t.Errorf("got %q, want %q", got, f.Name())
	}
}

func TestResolveWhisperModel_CacheHit(t *testing.T) {
	cacheDir := setTestModelCacheDir(t)
	cachedPath := setupWhisperCache(t, cacheDir, "base")
	patchWhisperRegistry(t, map[string]string{
		"base": "http://should-not-be-called/ggml-base.bin",
	})

	got, err := resolveWhisperModel("base")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != cachedPath {
		t.Errorf("got %q, want %q", got, cachedPath)
	}
}

func TestResolveWhisperModel_Download(t *testing.T) {
	srv := startFakeModelServer(t, "fake whisper model data")
	defer srv.Close()

	setTestModelCacheDir(t)
	patchWhisperRegistry(t, map[string]string{
		"tiny-test": srv.URL + "/ggml-tiny-test.bin",
	})

	got, err := resolveWhisperModel("tiny-test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := os.Stat(got); err != nil {
		t.Errorf("downloaded file not found: %v", err)
	}
}

func TestResolveWhisperModel_UnknownName(t *testing.T) {
	setTestModelCacheDir(t)
	patchWhisperRegistry(t, map[string]string{"base": "http://example.com"})

	_, err := resolveWhisperModel("not-a-real-model")
	if err == nil {
		t.Fatal("expected error for unknown model name")
	}
}

func TestResolveWhisperModel_EmptySpec(t *testing.T) {
	_, err := resolveWhisperModel("")
	if err == nil {
		t.Fatal("expected error for empty spec")
	}
}

func TestResolveWhisperModel_BrokenPath(t *testing.T) {
	_, err := resolveWhisperModel("/nonexistent/path/to/model.bin")
	if err == nil {
		t.Fatal("expected error for non-existent file path")
	}
}

// ─── resolveLlamaModel ───────────────────────────────────────────────────────

func TestResolveLlamaModel_ExistingFile(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "model-*.gguf")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()

	got, err := resolveLlamaModel(f.Name())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != f.Name() {
		t.Errorf("got %q, want %q", got, f.Name())
	}
}

func TestResolveLlamaModel_CacheHit(t *testing.T) {
	cacheDir := setTestModelCacheDir(t)
	cachedPath := setupLlamaCache(t, cacheDir, "test-7b-q4_k_m.gguf")
	patchLlamaRegistry(t, map[string]LlamaEntry{
		"test:7b-q4_k_m": {
			URL:      "http://should-not-be-called/test-7b-q4_k_m.gguf",
			Template: "qwen",
		},
	})

	got, err := resolveLlamaModel("test:7b-q4_k_m")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != cachedPath {
		t.Errorf("got %q, want %q", got, cachedPath)
	}
}

func TestResolveLlamaModel_OllamaCache(t *testing.T) {
	ollamaDir := t.TempDir()
	t.Setenv("OLLAMA_MODELS", ollamaDir)
	setTestModelCacheDir(t)

	// Ollama キャッシュにブロブを作成
	digest := "sha256:cafebabe9999"
	blobPath := writeBlobFile(t, ollamaDir, digest)
	writeOllamaManifest(t, ollamaDir, "llama3", "latest", []map[string]string{
		{"mediaType": "application/vnd.ollama.image.model", "digest": digest},
	})

	// llamaRegistry にエントリがなくても Ollama キャッシュから取得できること
	patchLlamaRegistry(t, map[string]LlamaEntry{})

	got, err := resolveLlamaModel("llama3")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != blobPath {
		t.Errorf("got %q, want %q", got, blobPath)
	}
}

func TestResolveLlamaModel_Download(t *testing.T) {
	srv := startFakeModelServer(t, "fake llama model data")
	defer srv.Close()

	setTestModelCacheDir(t)
	t.Setenv("OLLAMA_MODELS", t.TempDir()) // Ollama ミスを回避
	patchLlamaRegistry(t, map[string]LlamaEntry{
		"test:dl-q4_k_m": {
			URL:      srv.URL + "/test-dl-q4_k_m.gguf",
			Template: "qwen",
		},
	})

	got, err := resolveLlamaModel("test:dl-q4_k_m")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := os.Stat(got); err != nil {
		t.Errorf("downloaded file not found: %v", err)
	}
	if !strings.HasSuffix(got, "test-dl-q4_k_m.gguf") {
		t.Errorf("unexpected filename: %q", got)
	}
}

func TestResolveLlamaModel_UnknownName(t *testing.T) {
	setTestModelCacheDir(t)
	t.Setenv("OLLAMA_MODELS", t.TempDir())
	patchLlamaRegistry(t, map[string]LlamaEntry{})

	_, err := resolveLlamaModel("nonexistent:model")
	if err == nil {
		t.Fatal("expected error for unknown model name")
	}
}

func TestResolveLlamaModel_EmptySpec(t *testing.T) {
	_, err := resolveLlamaModel("")
	if err == nil {
		t.Fatal("expected error for empty spec")
	}
}

// ─── modelCacheDir ────────────────────────────────────────────────────────────

func TestModelCacheDir_EnvOverride(t *testing.T) {
	want := t.TempDir()
	t.Setenv("MODEL_CACHE_DIR", want)
	if got := modelCacheDir(); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestModelCacheDir_Default_NotEmpty(t *testing.T) {
	t.Setenv("MODEL_CACHE_DIR", "")
	if got := modelCacheDir(); got == "" {
		t.Error("default cache dir should not be empty")
	}
}

func TestModelCacheDir_Default_ContainsMeetTranslator(t *testing.T) {
	t.Setenv("MODEL_CACHE_DIR", "")
	got := modelCacheDir()
	if !strings.Contains(got, "meet-translator") {
		t.Errorf("expected 'meet-translator' in path, got %q", got)
	}
}
