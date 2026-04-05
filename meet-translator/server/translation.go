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
// history に直前の発話ペアを渡すと few-shot context として組み込まれ、
// 代名詞解決・専門用語の一貫性が向上する。
func buildTranslationPrompt(text, sourceLang, targetLang, template string, opts ModelOptions, history []contextEntry, termsHint string) string {
	src := langLabel(sourceLang)
	tgt := langLabel(targetLang)
	switch template {
	case "qwen3":
		return buildQwen3Prompt(text, src, tgt, opts, history, termsHint)
	case "gemma":
		return buildGemmaPrompt(text, src, tgt, termsHint, history)
	default: // "qwen" (Qwen2.5) およびその他
		return buildQwenPrompt(text, src, tgt, termsHint, history)
	}
}

// systemPrompt は翻訳用システムプロンプトを組み立てる。
// termsHint が指定された場合に用語マッピングを付加する。
func systemPrompt(termsHint string) string {
	base := "You are a translator. Translate the given text accurately. Output only the translated text."
	if termsHint == "" {
		return base
	}
	return base + "\nUse these term translations: " + termsHint
}

// buildQwenPrompt は Qwen2.5 用プロンプトを生成する。
func buildQwenPrompt(text, src, tgt, termsHint string, history []contextEntry) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("<|im_start|>system\n%s<|im_end|>\n", systemPrompt(termsHint)))
	for _, h := range history {
		sb.WriteString(fmt.Sprintf("<|im_start|>user\nTranslate from %s to %s:\n%s<|im_end|>\n", src, tgt, h.Transcription))
		sb.WriteString(fmt.Sprintf("<|im_start|>assistant\n%s<|im_end|>\n", h.Translation))
	}
	sb.WriteString(fmt.Sprintf("<|im_start|>user\nTranslate from %s to %s:\n%s<|im_end|>\n", src, tgt, text))
	sb.WriteString("<|im_start|>assistant\n")
	return sb.String()
}

// buildQwen3Prompt は Qwen3 用プロンプトを生成する。
// opts.Thinking=false の場合は /no-think タグで思考を抑制する。
func buildQwen3Prompt(text, src, tgt string, opts ModelOptions, history []contextEntry, termsHint string) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("<|im_start|>system\n%s<|im_end|>\n", systemPrompt(termsHint)))
	for _, h := range history {
		sb.WriteString(fmt.Sprintf("<|im_start|>user\nTranslate from %s to %s:\n%s<|im_end|>\n", src, tgt, h.Transcription))
		sb.WriteString(fmt.Sprintf("<|im_start|>assistant\n%s<|im_end|>\n", h.Translation))
	}
	userContent := fmt.Sprintf("Translate from %s to %s:\n%s", src, tgt, text)
	if !opts.Thinking {
		userContent = "/no-think\n" + userContent
	}
	sb.WriteString(fmt.Sprintf("<|im_start|>user\n%s<|im_end|>\n", userContent))
	sb.WriteString("<|im_start|>assistant\n")
	return sb.String()
}

// buildGemmaPrompt は Gemma 3/4 用プロンプトを生成する。
func buildGemmaPrompt(text, src, tgt, termsHint string, history []contextEntry) string {
	var sb strings.Builder
	for _, h := range history {
		sb.WriteString(fmt.Sprintf("<start_of_turn>user\nTranslate from %s to %s:\n%s<end_of_turn>\n", src, tgt, h.Transcription))
		sb.WriteString(fmt.Sprintf("<start_of_turn>model\n%s<end_of_turn>\n", h.Translation))
	}
	sb.WriteString(fmt.Sprintf(
		"<start_of_turn>user\n"+
			"%s\n"+
			"Translate from %s to %s:\n%s<end_of_turn>\n"+
			"<start_of_turn>model\n",
		systemPrompt(termsHint), src, tgt, text,
	))
	return sb.String()
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
	// [/INST] は instruction と response の区切りとして改行に変換してから除去する
	text = strings.ReplaceAll(text, "[/INST]", "\n")
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

// ---------------------------------------------------------------------------
// Analysis prompt (辞書自己改善用)
// ---------------------------------------------------------------------------

// buildAnalysisPrompt は GlossaryImprover が LLM に渡す解析プロンプトを生成する。
// 翻訳レコードのリストを受け取り、ASR 誤認識と専門用語を JSON で返すよう指示する。
func buildAnalysisPrompt(records []TranslationRecord, template string) string {
	var sb strings.Builder
	sb.WriteString("Review these speech-to-text transcriptions and their translations.\n\n")
	for i, r := range records {
		sb.WriteString(fmt.Sprintf("%d. \"%s\" → \"%s\"\n", i+1, r.Transcription, r.Translation))
	}
	sb.WriteString("\nTasks:\n")
	sb.WriteString("1. Find ASR errors: words likely misheard (e.g. 'poll request' should be 'pull request')\n")
	sb.WriteString("2. Extract technical terms worth adding to a translation glossary\n\n")
	sb.WriteString("Output ONLY valid JSON (no explanation):\n")
	sb.WriteString(`{"corrections":[{"source":"...","target":"..."}],"terms":[{"source":"...","target":"..."}]}`)
	sb.WriteString("\nIf nothing to suggest: {\"corrections\":[],\"terms\":[]}\n")
	userContent := sb.String()
	sys := "You are a linguistic analysis assistant. Identify speech recognition errors and translation glossary terms. Output only valid JSON."

	switch template {
	case "qwen3":
		return fmt.Sprintf(
			"<|im_start|>system\n%s<|im_end|>\n<|im_start|>user\n/no-think\n%s<|im_end|>\n<|im_start|>assistant\n",
			sys, userContent,
		)
	case "gemma":
		return fmt.Sprintf(
			"<start_of_turn>user\n%s\n%s<end_of_turn>\n<start_of_turn>model\n",
			sys, userContent,
		)
	default:
		return fmt.Sprintf(
			"<|im_start|>system\n%s<|im_end|>\n<|im_start|>user\n%s<|im_end|>\n<|im_start|>assistant\n",
			sys, userContent,
		)
	}
}
