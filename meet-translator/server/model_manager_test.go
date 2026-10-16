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
	entry, ok := whisperRegistry[modelName]
	if !ok {
		entry = WhisperEntry{URL: "https://example.invalid/ggml-" + modelName + ".bin"}
	}
	dest := filepath.Join(cacheDir, "whisper", cacheFilenameForWhisperEntry(modelName, entry))
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
func patchWhisperRegistry(t *testing.T, m map[string]WhisperEntry) {
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

func patchPlatform(t *testing.T, goos, goarch string) {
	t.Helper()
	origGOOS, origGOARCH := currentGOOS, currentGOARCH
	currentGOOS, currentGOARCH = goos, goarch
	t.Cleanup(func() {
		currentGOOS, currentGOARCH = origGOOS, origGOARCH
	})
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
	if got.Backend != asrBackendWhisperCPP {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperCPP)
	}
	if got.ResolvedSpec != f.Name() {
		t.Errorf("got %q, want %q", got.ResolvedSpec, f.Name())
	}
}

func TestResolveWhisperModel_CacheHit(t *testing.T) {
	cacheDir := setTestModelCacheDir(t)
	cachedPath := setupWhisperCache(t, cacheDir, "base")
	patchWhisperRegistry(t, map[string]WhisperEntry{
		"base": {
			Backend:       asrBackendWhisperCPP,
			URL:           "http://should-not-be-called/ggml-base.bin",
			CacheFilename: "ggml-base.bin",
		},
	})

	got, err := resolveWhisperModel("base")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperCPP {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperCPP)
	}
	if got.ResolvedSpec != cachedPath {
		t.Errorf("got %q, want %q", got.ResolvedSpec, cachedPath)
	}
}

func TestResolveWhisperModel_Download(t *testing.T) {
	srv := startFakeModelServer(t, "fake whisper model data")
	defer srv.Close()

	setTestModelCacheDir(t)
	patchWhisperRegistry(t, map[string]WhisperEntry{
		"tiny-test": {
			Backend:       asrBackendWhisperCPP,
			URL:           srv.URL + "/ggml-tiny-test.bin",
			CacheFilename: "ggml-tiny-test.bin",
		},
	})

	got, err := resolveWhisperModel("tiny-test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperCPP {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperCPP)
	}
	if _, err := os.Stat(got.ResolvedSpec); err != nil {
		t.Errorf("downloaded file not found: %v", err)
	}
}

func TestResolveWhisperModel_UnknownName(t *testing.T) {
	setTestModelCacheDir(t)
	patchWhisperRegistry(t, map[string]WhisperEntry{
		"base": {
			Backend: asrBackendWhisperCPP,
			URL:     "http://example.com",
		},
	})

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

func TestResolveWhisperModel_SenseVoiceAlias(t *testing.T) {
	got, err := resolveWhisperModel("sensevoice")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendSenseVoice {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendSenseVoice)
	}
	if got.ResolvedSpec != "iic/SenseVoiceSmall" {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, "iic/SenseVoiceSmall")
	}
}

func TestResolveWhisperModel_SenseVoicePrefix(t *testing.T) {
	got, err := resolveWhisperModel("sensevoice:SenseVoiceSmall")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendSenseVoice {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendSenseVoice)
	}
	if got.ResolvedSpec != "iic/SenseVoiceSmall" {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, "iic/SenseVoiceSmall")
	}
}

func TestResolveWhisperModel_WhisperXAlias(t *testing.T) {
	got, err := resolveWhisperModel("whisperx")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperX {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperX)
	}
	if got.ResolvedSpec != whisperXLatestModelRef {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, whisperXLatestModelRef)
	}
}

func TestResolveWhisperModel_WhisperXPrefix(t *testing.T) {
	got, err := resolveWhisperModel("whisperx:small")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperX {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperX)
	}
	if got.ResolvedSpec != "small" {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, "small")
	}
}

func TestResolveWhisperModel_WhisperXLatestCompatibilityPrefix(t *testing.T) {
	got, err := resolveWhisperModel("whisperx:large-v3-turbo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperX {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperX)
	}
	if got.ResolvedSpec != whisperXLatestModelRef {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, whisperXLatestModelRef)
	}
}

func TestResolveWhisperModel_WhisperXTurboAlias(t *testing.T) {
	got, err := resolveWhisperModel("whisperx-turbo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperX {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperX)
	}
	if got.ResolvedSpec != whisperXLatestModelRef {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, whisperXLatestModelRef)
	}
}

func TestResolveWhisperModel_WhisperXLargeV3Alias(t *testing.T) {
	got, err := resolveWhisperModel("whisperx-large-v3")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperX {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperX)
	}
	if got.ResolvedSpec != whisperXLargeV3ModelRef {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, whisperXLargeV3ModelRef)
	}
}

func TestResolveWhisperModel_TransformersAlias(t *testing.T) {
	got, err := resolveWhisperModel("kotoba-whisper-v2.2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendTransformersWhisper {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendTransformersWhisper)
	}
	if got.ResolvedSpec != "kotoba-tech/kotoba-whisper-v2.2" {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, "kotoba-tech/kotoba-whisper-v2.2")
	}
}

func TestResolveWhisperModel_TransformersModelRef(t *testing.T) {
	got, err := resolveWhisperModel("kotoba-tech/kotoba-whisper-v2.2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendTransformersWhisper {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendTransformersWhisper)
	}
	if got.ResolvedSpec != "kotoba-tech/kotoba-whisper-v2.2" {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, "kotoba-tech/kotoba-whisper-v2.2")
	}
}

func TestResolveWhisperModel_KotobaWhisperXFasterAlias(t *testing.T) {
	got, err := resolveWhisperModel("kotoba-whisper-v2.2-faster")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperX {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperX)
	}
	if got.ResolvedSpec != "RoachLin/kotoba-whisper-v2.2-faster" {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, "RoachLin/kotoba-whisper-v2.2-faster")
	}
}

func TestResolveWhisperModel_KotobaWhisperXFasterModelRef(t *testing.T) {
	got, err := resolveWhisperModel("RoachLin/kotoba-whisper-v2.2-faster")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperX {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperX)
	}
	if got.ResolvedSpec != "RoachLin/kotoba-whisper-v2.2-faster" {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, "RoachLin/kotoba-whisper-v2.2-faster")
	}
}

func TestResolveWhisperModel_WhisperXUppercaseAlias(t *testing.T) {
	got, err := resolveWhisperModel("whisperX")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperX {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperX)
	}
	if got.ResolvedSpec != whisperXLatestModelRef {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, whisperXLatestModelRef)
	}
}

func TestResolveWhisperModel_WhisperXUppercasePrefix(t *testing.T) {
	got, err := resolveWhisperModel("whisperX:small")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != asrBackendWhisperX {
		t.Fatalf("backend = %q, want %q", got.Backend, asrBackendWhisperX)
	}
	if got.ResolvedSpec != "small" {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, "small")
	}
}

// ─── resolveLlamaModel ───────────────────────────────────────────────────────

func TestCanonicalLlamaSpecLeavesUnspecifiedModelEmpty(t *testing.T) {
	if got := canonicalLlamaSpec(""); got != "" {
		t.Fatalf("canonical empty model = %q, want empty", got)
	}
	if got := templateFor(""); got != "qwen" {
		t.Fatalf("template for an unspecified model = %q, want stable default qwen", got)
	}
}

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
	if got.Backend != llmBackendLlamaCPP {
		t.Fatalf("backend = %q, want %q", got.Backend, llmBackendLlamaCPP)
	}
	if got.ResolvedSpec != f.Name() {
		t.Errorf("got %q, want %q", got.ResolvedSpec, f.Name())
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
	if got.Backend != llmBackendLlamaCPP {
		t.Fatalf("backend = %q, want %q", got.Backend, llmBackendLlamaCPP)
	}
	if got.ResolvedSpec != cachedPath {
		t.Errorf("got %q, want %q", got.ResolvedSpec, cachedPath)
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
	if got.Backend != llmBackendLlamaCPP {
		t.Fatalf("backend = %q, want %q", got.Backend, llmBackendLlamaCPP)
	}
	if got.ResolvedSpec != blobPath {
		t.Errorf("got %q, want %q", got.ResolvedSpec, blobPath)
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
	if got.Backend != llmBackendLlamaCPP {
		t.Fatalf("backend = %q, want %q", got.Backend, llmBackendLlamaCPP)
	}
	if _, err := os.Stat(got.ResolvedSpec); err != nil {
		t.Errorf("downloaded file not found: %v", err)
	}
	if !strings.HasSuffix(got.ResolvedSpec, "test-dl-q4_k_m.gguf") {
		t.Errorf("unexpected filename: %q", got.ResolvedSpec)
	}
}

func TestResolveLlamaModel_HyMT2AliasesUseCache(t *testing.T) {
	patchPlatform(t, "linux", "amd64")
	cacheDir := setTestModelCacheDir(t)
	t.Setenv("OLLAMA_MODELS", t.TempDir())

	path18 := setupLlamaCache(t, cacheDir, "Hy-MT2-1.8B-Q4_K_M.gguf")
	path7 := setupLlamaCache(t, cacheDir, "Hy-MT2-7B-Q4_K_M.gguf")

	tests := []struct {
		spec string
		want string
	}{
		{spec: "tencent/Hy-MT2-1.8B", want: path18},
		{spec: "Hy-MT2-1.8B-GGUF", want: path18},
		{spec: "tencent/Hy-MT2-7B", want: path7},
		{spec: "Hy-MT2-7B-GGUF", want: path7},
		{spec: "Hy-MT2-7BGGUF", want: path7},
	}

	for _, tt := range tests {
		t.Run(tt.spec, func(t *testing.T) {
			got, err := resolveLlamaModel(tt.spec)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Backend != llmBackendLlamaCPP {
				t.Fatalf("backend = %q, want %q", got.Backend, llmBackendLlamaCPP)
			}
			if got.ResolvedSpec != tt.want {
				t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, tt.want)
			}
		})
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

func TestResolveLlamaModel_MLXPreferredOnAppleSilicon(t *testing.T) {
	patchPlatform(t, "darwin", "arm64")

	got, err := resolveLlamaModel("bonsai-8b")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != llmBackendMLX {
		t.Fatalf("backend = %q, want %q", got.Backend, llmBackendMLX)
	}
	if got.ResolvedSpec != bonsai8BMLXModelRef {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, bonsai8BMLXModelRef)
	}
}

func TestResolveLlamaModel_QwenMLXPreferredOnAppleSilicon(t *testing.T) {
	patchPlatform(t, "darwin", "arm64")

	got, err := resolveLlamaModel("qwen3:0.6b-q4_k_m")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != llmBackendMLX {
		t.Fatalf("backend = %q, want %q", got.Backend, llmBackendMLX)
	}
	if got.ResolvedSpec != "mlx-community/Qwen3-0.6B-4bit" {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, "mlx-community/Qwen3-0.6B-4bit")
	}
}

func TestRuntimeIdentityForModelSpecUsesExistingLocalFileBeforeMLXAlias(t *testing.T) {
	patchPlatform(t, "darwin", "arm64")
	const alias = "mlx-community/Qwen3-0.6B-4bit"

	previousDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	temporaryDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(temporaryDir, filepath.Dir(alias)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(temporaryDir, alias), []byte("local model"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(temporaryDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previousDir); err != nil {
			t.Errorf("restore working directory: %v", err)
		}
	})

	resolved, err := resolveLlamaModel(alias)
	if err != nil {
		t.Fatalf("resolve local model file: %v", err)
	}
	if resolved.Backend != llmBackendLlamaCPP {
		t.Fatalf("resolved backend = %q, want existing-file backend %q", resolved.Backend, llmBackendLlamaCPP)
	}
	if got, want := runtimeIdentityForModelSpec(alias), runtimeIdentityForResolvedModel(resolved); got != want {
		t.Fatalf("runtime identity = %q, want resolved backend identity %q", got, want)
	}

	s := newServer(config{}, nil, nil, "", resolved, nil)
	model, runtime := s.loadedLlamaIdentity()
	if model != alias {
		t.Fatalf("server model identity = %q, want startup alias %q", model, alias)
	}
	if want := runtimeIdentityForResolvedModel(resolved); runtime != want {
		t.Fatalf("server runtime identity = %q, want resolved backend identity %q", runtime, want)
	}
}

func TestResolveLlamaModel_MLXAliasFallsBackOnNonApple(t *testing.T) {
	patchPlatform(t, "linux", "amd64")
	cacheDir := setTestModelCacheDir(t)
	cachedPath := setupLlamaCache(t, cacheDir, "Bonsai-8B.gguf")

	got, err := resolveLlamaModel(bonsai8BMLXModelRef)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != llmBackendLlamaCPP {
		t.Fatalf("backend = %q, want %q", got.Backend, llmBackendLlamaCPP)
	}
	if got.ResolvedSpec != cachedPath {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, cachedPath)
	}
}

func TestResolveLlamaModel_QwenMLXAliasFallsBackOnNonApple(t *testing.T) {
	patchPlatform(t, "linux", "amd64")
	cacheDir := setTestModelCacheDir(t)
	cachedPath := setupLlamaCache(t, cacheDir, "Qwen3-0.6B-Q4_K_M.gguf")

	got, err := resolveLlamaModel("mlx-community/Qwen3-0.6B-4bit")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Backend != llmBackendLlamaCPP {
		t.Fatalf("backend = %q, want %q", got.Backend, llmBackendLlamaCPP)
	}
	if got.ResolvedSpec != cachedPath {
		t.Errorf("resolved spec = %q, want %q", got.ResolvedSpec, cachedPath)
	}
}

func TestResolveLlamaModel_MLXOnlyRequiresAppleSilicon(t *testing.T) {
	patchPlatform(t, "linux", "amd64")
	setTestModelCacheDir(t)

	_, err := resolveLlamaModel("bonsai-4b")
	if err == nil {
		t.Fatal("expected error for MLX-only model on non-Apple platform")
	}
	if !strings.Contains(err.Error(), "Apple Silicon MLX") {
		t.Fatalf("unexpected error: %v", err)
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

func TestVisibleModelCatalogOmitsLegacyAndDuplicateAliases(t *testing.T) {
	whisper := strings.Split(sortedWhisperKeys(), ", ")
	for _, hidden := range []string{"tiny", "base", "small", "medium", "large-v1", "large-v2", "kotoba-whisper", "kotoba-whisper-v2.2-faster"} {
		for _, visible := range whisper {
			if visible == hidden {
				t.Errorf("legacy Whisper alias %q is visible", hidden)
			}
		}
	}
	for _, current := range []string{"large-v3-turbo", "kotoba-whisper-v2.2", "sensevoice", "whisperx:<model-name>"} {
		found := false
		for _, visible := range whisper {
			if visible == current {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("current Whisper comparison option %q is missing", current)
		}
	}

	llama := strings.Split(sortedLlamaKeys(), ", ")
	for _, hidden := range []string{
		"qwen2.5:7b-instruct-q4_k_m", "qwen2.5:14b-instruct-q4_k_m", "qwen3:0.6b-q4_k_m", "qwen3:1.7b-q4_k_m",
		"qwen3:4b-q4_k_m", "qwen3:8b-q4_k_m", "qwen3.5:0.8b-q4_k_m", "qwen3.5:2b-q4_k_m",
		"qwen3.5:4b-q4_k_m", "qwen3.5:9b-q4_k_m", "tencent/Hy-MT2-7B", "Hy-MT2-1.8B",
		"Hy-MT2-1.8B-GGUF", "tencent/Hy-MT2-1.8B-GGUF", "Hy-MT2-7B-GGUF", "calm3:22b-q4_k_m",
		"bonsai-8b", "bonsai-4b", "bonsai-1.7b", "gemma4:e2b-q4_k_m", "gemma4:e4b-q4_k_m", "gemma4:26b-q4_k_m",
	} {
		for _, visible := range llama {
			if visible == hidden {
				t.Errorf("legacy, oversized, or duplicate translation alias %q is visible", hidden)
			}
		}
	}
	for _, current := range []string{"tencent/Hy-MT2-1.8B"} {
		found := false
		for _, visible := range llama {
			if visible == current {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("current translation comparison option %q is missing", current)
		}
	}
}

func TestLegacyModelSettingsStillResolveFromCache(t *testing.T) {
	patchPlatform(t, "linux", "amd64")
	cacheDir := setTestModelCacheDir(t)
	t.Setenv("OLLAMA_MODELS", t.TempDir())

	whisperPath := setupWhisperCache(t, cacheDir, "small")
	gotWhisper, err := resolveWhisperModel("small")
	if err != nil {
		t.Fatalf("saved Whisper setting should remain resolvable: %v", err)
	}
	if gotWhisper.ResolvedSpec != whisperPath {
		t.Errorf("Whisper resolved spec = %q, want %q", gotWhisper.ResolvedSpec, whisperPath)
	}

	llamaPath := setupLlamaCache(t, cacheDir, "Qwen3-8B-Q4_K_M.gguf")
	gotLlama, err := resolveLlamaModel("qwen3:8b-q4_k_m")
	if err != nil {
		t.Fatalf("saved translation setting should remain resolvable: %v", err)
	}
	if gotLlama.ResolvedSpec != llamaPath {
		t.Errorf("translation resolved spec = %q, want %q", gotLlama.ResolvedSpec, llamaPath)
	}

	baselinePath := setupLlamaCache(t, cacheDir, "Qwen3.5-0.8B-Q4_K_M.gguf")
	gotBaseline, err := resolveLlamaModel("qwen3.5:0.8b-q4_k_m")
	if err != nil {
		t.Fatalf("configured reproduction baseline should remain resolvable: %v", err)
	}
	if gotBaseline.ResolvedSpec != baselinePath {
		t.Errorf("baseline translation resolved spec = %q, want %q", gotBaseline.ResolvedSpec, baselinePath)
	}
}
