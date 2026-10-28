package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPromptContractsMatchPinnedFixtures(t *testing.T) {
	type promptContract struct {
		SchemaVersion int    `json:"schemaVersion"`
		TemplateID    string `json:"templateId"`
		Input         struct {
			SourceLanguage string `json:"sourceLanguage"`
			TargetLanguage string `json:"targetLanguage"`
			SourceText     string `json:"sourceText"`
		} `json:"input"`
		ExpectedPrompt string `json:"expectedPrompt"`
	}

	for _, fixtureName := range []string{"qwen35-0.8b.json", "hy-mt2-1.8b.json"} {
		t.Run(fixtureName, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata", "templates", fixtureName))
			if err != nil {
				t.Fatal(err)
			}
			var fixture promptContract
			if err := json.Unmarshal(data, &fixture); err != nil {
				t.Fatal(err)
			}
			got := buildTranslationPrompt(
				fixture.Input.SourceText,
				fixture.Input.SourceLanguage,
				fixture.Input.TargetLanguage,
				fixture.TemplateID,
				ModelOptions{},
				nil,
				"",
			)
			if got != fixture.ExpectedPrompt {
				t.Fatalf("prompt mismatch\n got: %q\nwant: %q", got, fixture.ExpectedPrompt)
			}
		})
	}
}

// ─── buildTranslationPrompt ──────────────────────────────────────────────────

func TestBuildQwenPrompt(t *testing.T) {
	got := buildTranslationPrompt("Hello", "en", "ja", "qwen", ModelOptions{}, nil, "")
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
	got := buildTranslationPrompt("Hello", "en", "ja", "qwen3", opts, nil, "")
	assertContains(t, got, "<|im_start|>system")
	assertContains(t, got, "Translate from English to Japanese")
	assertNotContains(t, got, "/no-think")
}

func TestBuildQwen3Prompt_ThinkingOff(t *testing.T) {
	opts := ModelOptions{Thinking: false}
	got := buildTranslationPrompt("Hello", "en", "ja", "qwen3", opts, nil, "")
	assertContains(t, got, "/no_think")
	assertNotContains(t, got, "/no-think")
	assertContains(t, got, "Hello")
}

func TestBuildGemmaPrompt(t *testing.T) {
	got := buildTranslationPrompt("Hello", "en", "ja", "gemma", ModelOptions{}, nil, "")
	assertContains(t, got, "<start_of_turn>user")
	assertContains(t, got, "<end_of_turn>")
	assertContains(t, got, "<start_of_turn>model")
	assertContains(t, got, "Translate from English to Japanese")
	assertContains(t, got, "Hello")
	assertNotContains(t, got, "<|im_start|>")
}

func TestBuildHyPrompt(t *testing.T) {
	got := buildTranslationPrompt("Hello", "en", "ja", "hy", ModelOptions{}, nil, "")
	assertContains(t, got, "<｜hy_begin▁of▁sentence｜>")
	assertContains(t, got, "<｜hy_User｜>")
	assertContains(t, got, "<｜hy_Assistant｜>")
	assertContains(t, got, "Translate the following text into Japanese.")
	assertContains(t, got, "only output the translated result without any additional explanation")
	assertContains(t, got, "Hello")
	assertNotContains(t, got, "You are a translator")
	assertNotContains(t, got, "<|im_start|>")
}

func TestBuildHyPromptUsesOfficialTerminologyAndTargetLanguageInstruction(t *testing.T) {
	got := buildTranslationPrompt(
		"Open a pull request",
		"en",
		"ja",
		"hy",
		ModelOptions{},
		nil,
		"pull request -> プルリクエスト",
	)
	assertContains(t, got, "Reference the following translations:")
	assertContains(t, got, "pull request -> プルリクエスト")
	assertContains(t, got, "Translate the following text into Japanese.")
	assertNotContains(t, got, "Translate from English to Japanese")
	assertNotContains(t, got, "<｜hy_place▁holder▁no▁3｜>")
}

func TestBuildQwen35PromptUsesDefaultNonThinkingMode(t *testing.T) {
	got := buildTranslationPrompt("Hello", "en", "ja", "qwen35", ModelOptions{}, nil, "")
	assertContains(t, got, "<|im_start|>user")
	assertContains(t, got, "Translate the following text from English into Japanese")
	assertContains(t, got, "Return only the translation, without additional explanation")
	assertNotContains(t, got, "/no-think")
	assertNotContains(t, got, "You are a translator")
}

func TestBuildHy7Prompt(t *testing.T) {
	got := buildTranslationPrompt("Hello", "en", "ja", "hy7", ModelOptions{}, nil, "")
	assertContains(t, got, "<|startoftext|>")
	assertContains(t, got, "<|extra_0|>")
	assertContains(t, got, "Translate the following text into Japanese.")
	assertContains(t, got, "Hello")
	assertNotContains(t, got, "<|extra_4|>")
	assertNotContains(t, got, "<|im_start|>")
}

func TestBuildTranslationPrompt_UnknownTemplateUsesQwen(t *testing.T) {
	got := buildTranslationPrompt("Hi", "en", "fr", "unknown-template", ModelOptions{}, nil, "")
	assertContains(t, got, "<|im_start|>system")
	assertContains(t, got, "French")
}

func TestBuildTranslationPrompt_EmptySourceLang(t *testing.T) {
	got := buildTranslationPrompt("Hi", "", "ja", "qwen", ModelOptions{}, nil, "")
	assertContains(t, got, "the detected language")
}

func TestBuildTranslationPrompt_WithHistory(t *testing.T) {
	history := []contextEntry{
		{Transcription: "Good morning", Translation: "おはようございます"},
	}
	got := buildTranslationPrompt("Hello", "en", "ja", "qwen", ModelOptions{}, history, "")
	assertContains(t, got, "Good morning")
	assertContains(t, got, "おはようございます")
	assertContains(t, got, "Hello")
}

func TestBuildGemmaPrompt_WithHistory(t *testing.T) {
	history := []contextEntry{
		{Transcription: "Good morning", Translation: "おはようございます"},
	}
	got := buildTranslationPrompt("Hello", "en", "ja", "gemma", ModelOptions{}, history, "")
	assertContains(t, got, "Good morning")
	assertContains(t, got, "おはようございます")
	// history turns should appear before the current question
	historyIdx := strings.Index(got, "Good morning")
	currentIdx := strings.Index(got, "Hello")
	if historyIdx >= currentIdx {
		t.Errorf("history should appear before current text in prompt")
	}
}

func TestTemplateFor_HyMT2Aliases(t *testing.T) {
	if got := templateFor("tencent/Hy-MT2-1.8B"); got != "hy" {
		t.Errorf("templateFor(1.8B) = %q, want %q", got, "hy")
	}
	if got := templateFor("Hy-MT2-7BGGUF"); got != "hy7" {
		t.Errorf("templateFor(7B) = %q, want %q", got, "hy7")
	}
}

func TestTemplateForQwen35UsesItsOwnTemplate(t *testing.T) {
	if got := templateFor("qwen3.5:0.8b-q4_k_m"); got != "qwen35" {
		t.Errorf("templateFor(Qwen3.5 0.8B) = %q, want %q", got, "qwen35")
	}
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
	// 閉じタグなし（max_tokens 途中切断）は <think> 以降を全除去する
	in := "<think>unclosed"
	want := ""
	if got := stripThinkingTokens(in); got != want {
		t.Errorf("unclosed tag: got %q, want %q", got, want)
	}
}

func TestStripThinkingTokens_UnclosedTagWithPrefix(t *testing.T) {
	// 翻訳結果の後に unclosed think block が続く場合は翻訳部分を保持する
	in := "translation result<think>unclosed reasoning"
	want := "translation result"
	if got := stripThinkingTokens(in); got != want {
		t.Errorf("unclosed with prefix: got %q, want %q", got, want)
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

// ─── stripLLMArtifacts ────────────────────────────────────────────────────────

func TestStripLLMArtifacts(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "gemma end_of_turn",
			input: "(スタッフ)<end_of_turn>",
			want:  "(スタッフ)",
		},
		{
			name:  "gemma full turn artifact",
			input: "(スタッフ)<end_of_turn>\n<start_of_turn>model\n(スタッフ)<end_of_turn>",
			want:  "(スタッフ)\n(スタッフ)",
		},
		{
			name:  "qwen im tokens",
			input: "こんにちは<|im_end|>",
			want:  "こんにちは",
		},
		{
			name:  "qwen im_start assistant",
			input: "<|im_start|>assistant\nこんにちは<|im_end|>",
			want:  "こんにちは",
		},
		{
			name:  "hy 1.8b tokens",
			input: "<｜hy_Assistant｜>\nこんにちは<｜hy_place▁holder▁no▁2｜>",
			want:  "こんにちは",
		},
		{
			name:  "hy 7b tokens",
			input: "<|startoftext|><|extra_0|>こんにちは<|eos|>",
			want:  "こんにちは",
		},
		{
			name:  "llama inst tokens",
			input: "[INST] hello [/INST] こんにちは",
			want:  "hello\nこんにちは",
		},
		{
			name:  "clean text unchanged",
			input: "こんにちは、元気ですか？",
			want:  "こんにちは、元気ですか？",
		},
		{
			name:  "multiline clean",
			input: "Hello\nWorld",
			want:  "Hello\nWorld",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stripLLMArtifacts(tt.input)
			if got != tt.want {
				t.Errorf("stripLLMArtifacts(%q)\n  got  %q\n  want %q", tt.input, got, tt.want)
			}
		})
	}
}
