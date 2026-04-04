package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ─── configDir ───────────────────────────────────────────────────────────────

func TestConfigDir_ContainsMeetTranslator(t *testing.T) {
	got := configDir()
	if !strings.Contains(got, "meet-translator") {
		t.Errorf("expected 'meet-translator' in configDir, got %q", got)
	}
}

func TestConfigDir_NotEmpty(t *testing.T) {
	if got := configDir(); got == "" {
		t.Error("configDir should not be empty")
	}
}

// ─── configFilePath ───────────────────────────────────────────────────────────

func TestConfigFilePath_EnvOverride(t *testing.T) {
	want := "/tmp/test-config.json"
	t.Setenv("MEET_TRANSLATOR_CONFIG", want)
	if got := configFilePath(); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestConfigFilePath_Default_ContainsConfigJSON(t *testing.T) {
	t.Setenv("MEET_TRANSLATOR_CONFIG", "")
	got := configFilePath()
	if !strings.HasSuffix(got, "config.json") {
		t.Errorf("expected path ending in config.json, got %q", got)
	}
}

// ─── loadConfigFile ───────────────────────────────────────────────────────────

func TestLoadConfigFile_NotExist_ReturnsEmpty(t *testing.T) {
	t.Setenv("MEET_TRANSLATOR_CONFIG", filepath.Join(t.TempDir(), "nonexistent.json"))
	cfg, err := loadConfigFile()
	if err != nil {
		t.Fatalf("expected no error for missing file, got %v", err)
	}
	if cfg.WhisperModel != "" || cfg.LlamaModel != "" {
		t.Errorf("expected empty config, got %+v", cfg)
	}
}

func TestLoadConfigFile_ValidJSON(t *testing.T) {
	n := -1
	saved := persistedConfig{
		Port:           "8080",
		WhisperModel:   "small",
		LlamaModel:     "qwen3:8b-q4_k_m",
		LlamaGPULayers: &n,
	}
	path := writeConfigFile(t, saved)
	t.Setenv("MEET_TRANSLATOR_CONFIG", path)

	got, err := loadConfigFile()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Port != "8080" {
		t.Errorf("Port=%q, want 8080", got.Port)
	}
	if got.WhisperModel != "small" {
		t.Errorf("WhisperModel=%q, want small", got.WhisperModel)
	}
	if got.LlamaModel != "qwen3:8b-q4_k_m" {
		t.Errorf("LlamaModel=%q", got.LlamaModel)
	}
	if got.LlamaGPULayers == nil || *got.LlamaGPULayers != -1 {
		t.Errorf("LlamaGPULayers=%v, want -1", got.LlamaGPULayers)
	}
}

func TestLoadConfigFile_InvalidJSON_ReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	os.WriteFile(path, []byte("{bad json}"), 0o644)
	t.Setenv("MEET_TRANSLATOR_CONFIG", path)

	_, err := loadConfigFile()
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

// ─── saveConfigFile ───────────────────────────────────────────────────────────

func TestSaveConfigFile_CreatesFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "subdir", "config.json")
	t.Setenv("MEET_TRANSLATOR_CONFIG", path)

	n := 0
	cfg := persistedConfig{WhisperModel: "base", LlamaModel: "gemma4:e4b-q4_k_m", LlamaGPULayers: &n}
	if err := saveConfigFile(cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("config file not created: %v", err)
	}
}

func TestSaveConfigFile_RoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("MEET_TRANSLATOR_CONFIG", path)

	n := 32
	original := persistedConfig{
		Port:           "9090",
		WhisperModel:   "medium",
		LlamaModel:     "qwen2.5:7b-instruct-q4_k_m",
		LlamaGPULayers: &n,
		ModelCacheDir:  "/tmp/models",
	}
	if err := saveConfigFile(original); err != nil {
		t.Fatal(err)
	}

	loaded, err := loadConfigFile()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Port != original.Port {
		t.Errorf("Port: got %q, want %q", loaded.Port, original.Port)
	}
	if loaded.WhisperModel != original.WhisperModel {
		t.Errorf("WhisperModel: got %q", loaded.WhisperModel)
	}
	if loaded.LlamaModel != original.LlamaModel {
		t.Errorf("LlamaModel: got %q", loaded.LlamaModel)
	}
	if loaded.LlamaGPULayers == nil || *loaded.LlamaGPULayers != n {
		t.Errorf("LlamaGPULayers: got %v, want %d", loaded.LlamaGPULayers, n)
	}
	if loaded.ModelCacheDir != original.ModelCacheDir {
		t.Errorf("ModelCacheDir: got %q", loaded.ModelCacheDir)
	}
}

func TestSaveConfigFile_OmitsEmptyFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("MEET_TRANSLATOR_CONFIG", path)

	cfg := persistedConfig{LlamaModel: "qwen3:4b-q4_k_m"}
	if err := saveConfigFile(cfg); err != nil {
		t.Fatal(err)
	}

	raw, _ := os.ReadFile(path)
	var m map[string]any
	json.Unmarshal(raw, &m)

	// 空文字フィールドは JSON に出力されないこと
	if _, ok := m["port"]; ok {
		t.Error("empty port should be omitted from JSON")
	}
	if _, ok := m["whisper_model"]; ok {
		t.Error("empty whisper_model should be omitted from JSON")
	}
	if m["llama_model"] != "qwen3:4b-q4_k_m" {
		t.Errorf("llama_model=%v", m["llama_model"])
	}
}

func TestSaveConfigFile_IsValidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("MEET_TRANSLATOR_CONFIG", path)

	n := -1
	if err := saveConfigFile(persistedConfig{WhisperModel: "base", LlamaGPULayers: &n}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Errorf("saved file is not valid JSON: %v\n%s", err, raw)
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func writeConfigFile(t *testing.T, cfg persistedConfig) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, data, 0o644)
	return path
}
