package main

import (
	"strings"
	"testing"
)

// ─── buildTranslationPrompt ──────────────────────────────────────────────────

func TestBuildQwenPrompt(t *testing.T) {
	got := buildTranslationPrompt("Hello", "en", "ja", "qwen", ModelOptions{})
	assertContains(t, got, "<|im_start|>system")
	assertContains(t, got, "<|im_start|>user")
	assertContains(t, got, "Translate from English to Japanese")
	assertContains(t, got, "Hello")
	assertContains(t, got, "<|im_start|>assistant")
	assertNotContains(t, got, "/no-think")
	assertNotContains(t, got, "<start_of_turn>")
}

func TestBuildQwen3Prompt_ThinkingOn(t *testing.T) {
	opts := ModelOptions{Thinking: true}
	got := buildTranslationPrompt("Hello", "en", "ja", "qwen3", opts)
	assertContains(t, got, "<|im_start|>system")
	assertContains(t, got, "Translate from English to Japanese")
	assertNotContains(t, got, "/no-think")
}

func TestBuildQwen3Prompt_ThinkingOff(t *testing.T) {
	opts := ModelOptions{Thinking: false}
	got := buildTranslationPrompt("Hello", "en", "ja", "qwen3", opts)
	assertContains(t, got, "/no-think")
	assertContains(t, got, "Hello")
}

func TestBuildGemmaPrompt(t *testing.T) {
	got := buildTranslationPrompt("Hello", "en", "ja", "gemma", ModelOptions{})
	assertContains(t, got, "<start_of_turn>user")
	assertContains(t, got, "<end_of_turn>")
	assertContains(t, got, "<start_of_turn>model")
	assertContains(t, got, "Translate from English to Japanese")
	assertContains(t, got, "Hello")
	assertNotContains(t, got, "<|im_start|>")
}

func TestBuildTranslationPrompt_UnknownTemplateUsesQwen(t *testing.T) {
	got := buildTranslationPrompt("Hi", "en", "fr", "unknown-template", ModelOptions{})
	assertContains(t, got, "<|im_start|>system")
	assertContains(t, got, "French")
}

func TestBuildTranslationPrompt_EmptySourceLang(t *testing.T) {
	got := buildTranslationPrompt("Hi", "", "ja", "qwen", ModelOptions{})
	assertContains(t, got, "the detected language")
}

// ─── stripThinkingTokens ─────────────────────────────────────────────────────

func TestStripThinkingTokens_Basic(t *testing.T) {
	in := "<think>step1\nstep2</think>translation result"
	want := "translation result"
	if got := stripThinkingTokens(in); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestStripThinkingTokens_NoTokens(t *testing.T) {
	in := "direct translation"
	if got := stripThinkingTokens(in); got != in {
		t.Errorf("got %q, want %q", got, in)
	}
}

func TestStripThinkingTokens_Multiple(t *testing.T) {
	in := "<think>a</think>result1<think>b</think>result2"
	got := stripThinkingTokens(in)
	assertNotContains(t, got, "<think>")
	assertContains(t, got, "result1")
	assertContains(t, got, "result2")
}

func TestStripThinkingTokens_LeadingWhitespace(t *testing.T) {
	in := "<think>reasoning</think>\n\n  actual answer  "
	got := stripThinkingTokens(in)
	if strings.TrimSpace(got) == "" {
		t.Error("expected non-empty result after stripping")
	}
	assertNotContains(t, got, "<think>")
}

func TestStripThinkingTokens_UnclosedTag(t *testing.T) {
	in := "<think>unclosed"
	if got := stripThinkingTokens(in); got != in {
		t.Errorf("unclosed tag should not be stripped, got %q", got)
	}
}

// ─── langLabel ───────────────────────────────────────────────────────────────

func TestLangLabel_KnownCode(t *testing.T) {
	cases := map[string]string{
		"ja": "Japanese", "en": "English", "zh": "Chinese",
		"ko": "Korean", "fr": "French", "de": "German",
	}
	for code, want := range cases {
		if got := langLabel(code); got != want {
			t.Errorf("langLabel(%q) = %q, want %q", code, got, want)
		}
	}
}

func TestLangLabel_Empty(t *testing.T) {
	if got := langLabel(""); got != "the detected language" {
		t.Errorf("got %q", got)
	}
}

func TestLangLabel_Unknown(t *testing.T) {
	code := "xx"
	if got := langLabel(code); got != code {
		t.Errorf("unknown code should be returned as-is, got %q", got)
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func assertContains(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("expected %q to contain %q", haystack, needle)
	}
}

func assertNotContains(t *testing.T, haystack, needle string) {
	t.Helper()
	if strings.Contains(haystack, needle) {
		t.Errorf("expected %q NOT to contain %q", haystack, needle)
	}
}
