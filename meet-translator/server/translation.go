// translation.go – チャットテンプレートと翻訳ユーティリティ (純粋 Go)
//
// モデル別プロンプト生成と後処理。CGo 非依存のため単体テスト可能。

package main

import (
	"fmt"
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
