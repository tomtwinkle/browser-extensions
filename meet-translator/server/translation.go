// translation.go – チャットテンプレートと翻訳ユーティリティ (純粋 Go)
//
// モデル別プロンプト生成と後処理。CGo 非依存のため単体テスト可能。

package main

import (
	"fmt"
	"regexp"
	"strings"
)

var langNames = map[string]string{
	"ja": "Japanese", "en": "English", "zh": "Chinese",
	"ko": "Korean", "fr": "French", "de": "German",
	"es": "Spanish", "pt": "Portuguese", "ru": "Russian",
	"ar": "Arabic", "it": "Italian", "nl": "Dutch",
}

func langLabel(code string) string {
	if n, ok := langNames[code]; ok {
		return n
	}
	if code == "" {
		return "the detected language"
	}
	return code
}

// buildTranslationPrompt はモデルのチャットテンプレートに合わせたプロンプトを生成する。
func buildTranslationPrompt(text, sourceLang, targetLang, template string, opts ModelOptions) string {
	src := langLabel(sourceLang)
	tgt := langLabel(targetLang)
	switch template {
	case "qwen3":
		return buildQwen3Prompt(text, src, tgt, opts)
	case "gemma":
		return buildGemmaPrompt(text, src, tgt)
	default: // "qwen" (Qwen2.5) およびその他
		return buildQwenPrompt(text, src, tgt)
	}
}

// buildQwenPrompt は Qwen2.5 用プロンプトを生成する。
func buildQwenPrompt(text, src, tgt string) string {
	return fmt.Sprintf(
		"<|im_start|>system\nYou are a translator. Translate the given text accurately. Output only the translated text.<|im_end|>\n"+
			"<|im_start|>user\nTranslate from %s to %s:\n%s<|im_end|>\n"+
			"<|im_start|>assistant\n",
		src, tgt, text,
	)
}

// buildQwen3Prompt は Qwen3 用プロンプトを生成する。
// opts.Thinking=false の場合は /no-think タグで思考を抑制する。
func buildQwen3Prompt(text, src, tgt string, opts ModelOptions) string {
	userContent := fmt.Sprintf("Translate from %s to %s:\n%s", src, tgt, text)
	if !opts.Thinking {
		userContent = "/no-think\n" + userContent
	}
	return fmt.Sprintf(
		"<|im_start|>system\nYou are a translator. Translate the given text accurately. Output only the translated text.<|im_end|>\n"+
			"<|im_start|>user\n%s<|im_end|>\n"+
			"<|im_start|>assistant\n",
		userContent,
	)
}

// buildGemmaPrompt は Gemma 3/4 用プロンプトを生成する。
func buildGemmaPrompt(text, src, tgt string) string {
	return fmt.Sprintf(
		"<start_of_turn>user\n"+
			"You are a translator. Translate the given text accurately. Output only the translated text.\n"+
			"Translate from %s to %s:\n%s<end_of_turn>\n"+
			"<start_of_turn>model\n",
		src, tgt, text,
	)
}

// stripThinkingTokens は Qwen3 thinking モードの <think>...</think> ブロックを除去する。
func stripThinkingTokens(text string) string {
	for {
		start := strings.Index(text, "<think>")
		end := strings.Index(text, "</think>")
		if start == -1 || end == -1 || end < start {
			break
		}
		text = text[:start] + text[end+len("</think>"):]
	}
	return strings.TrimSpace(text)
}

// llmArtifactRe はモデルのチャットテンプレートトークンにマッチする。
// LLM が出力に誤って混入させることがある特殊トークンを除去するために使う。
var llmArtifactRe = regexp.MustCompile(
	// Gemma: <start_of_turn>model / <start_of_turn>user / <end_of_turn>
	`<start_of_turn>\w*|<end_of_turn>` +
		// Qwen: <|im_start|>assistant など / <|im_end|>
		`|<\|im_start\|>\w*|<\|im_end\|>` +
		// Llama 2/3 instruct: [INST] [/INST] <<SYS>> <</SYS>>
		`|\[/?INST\]|<</?SYS>>` +
		// その他よくある EOS/BOS トークン表記
		`|<\|eot_id\|>|<\|end_of_text\|>|<\|start_header_id\|>\w*<\|end_header_id\|>`,
)

// stripLLMArtifacts はモデルが出力に混入させたチャットテンプレートトークンを除去する。
// stripThinkingTokens の後に呼び出すことを想定している。
func stripLLMArtifacts(text string) string {
	text = llmArtifactRe.ReplaceAllString(text, "")
	// 除去後に連続する空行や先頭末尾の空白を整理する
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return strings.Join(out, "\n")
}
