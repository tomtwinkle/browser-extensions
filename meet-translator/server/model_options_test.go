package main

import (
	"encoding/json"
	"testing"
)

// ─── parseModelOptions ───────────────────────────────────────────────────────

func TestParseModelOptions_ValidJSON_ThinkingTrue(t *testing.T) {
	opts := parseModelOptions(`{"thinking":true}`, "qwen3:8b-q4_k_m")
	if !opts.Thinking {
		t.Error("expected Thinking=true")
	}
}

func TestParseModelOptions_ValidJSON_ThinkingFalse(t *testing.T) {
	opts := parseModelOptions(`{"thinking":false}`, "qwen3:8b-q4_k_m")
	if opts.Thinking {
		t.Error("expected Thinking=false")
	}
}

func TestParseModelOptions_Empty_UsesDefaults(t *testing.T) {
	// Qwen3 デフォルトは thinking=true
	opts := parseModelOptions("", "qwen3:8b-q4_k_m")
	if !opts.Thinking {
		t.Error("expected Qwen3 default Thinking=true")
	}
}

func TestParseModelOptions_InvalidJSON_UsesDefaults(t *testing.T) {
	opts := parseModelOptions("{invalid}", "qwen3:4b-q4_k_m")
	if !opts.Thinking {
		t.Error("invalid JSON should fall back to defaults (Thinking=true for Qwen3)")
	}
}

func TestParseModelOptions_NonThinkingModel(t *testing.T) {
	opts := parseModelOptions("", "gemma4:e4b-q4_k_m")
	if opts.Thinking {
		t.Error("gemma4 should default to Thinking=false")
	}
}

func TestParseModelOptions_RoundTrip(t *testing.T) {
	original := ModelOptions{Thinking: false}
	data, _ := json.Marshal(original)
	parsed := parseModelOptions(string(data), "qwen3:8b-q4_k_m")
	if parsed.Thinking != original.Thinking {
		t.Errorf("round-trip failed: got %+v, want %+v", parsed, original)
	}
}

// ─── defaultModelOptions ─────────────────────────────────────────────────────

func TestDefaultModelOptions_Qwen3_ThinkingTrue(t *testing.T) {
	for _, name := range []string{
		"qwen3:0.6b-q4_k_m",
		"qwen3:1.7b-q4_k_m",
		"qwen3:4b-q4_k_m",
		"qwen3:8b-q4_k_m",
		"mlx-community/Qwen3-0.6B-4bit",
		"bonsai-1.7b",
		"bonsai-4b",
		"bonsai-8b",
		bonsai8BMLXModelRef,
	} {
		opts := defaultModelOptions(name)
		if !opts.Thinking {
			t.Errorf("%s: expected Thinking=true", name)
		}
	}
}

func TestDefaultModelOptions_Qwen25_ThinkingFalse(t *testing.T) {
	for _, name := range []string{"qwen2.5:3b-instruct-q4_k_m", "qwen2.5:7b-instruct-q4_k_m", "qwen2.5:14b-instruct-q4_k_m"} {
		opts := defaultModelOptions(name)
		if opts.Thinking {
			t.Errorf("%s: expected Thinking=false", name)
		}
	}
}

func TestDefaultModelOptions_Gemma4_ThinkingFalse(t *testing.T) {
	for _, name := range []string{
		"gemma4:e2b-q4_k_m",
		"gemma4:e4b-q4_k_m",
		"gemma4:26b-q4_k_m",
		"mlx-community/gemma-4-e2b-it-4bit",
	} {
		opts := defaultModelOptions(name)
		if opts.Thinking {
			t.Errorf("%s: expected Thinking=false", name)
		}
	}
}

func TestDefaultModelOptions_UnknownModel_ThinkingFalse(t *testing.T) {
	opts := defaultModelOptions("some-unknown-model")
	if opts.Thinking {
		t.Error("unknown model should default to Thinking=false")
	}
}
