package main

import (
	"strings"
	"testing"
)

func TestIsMeaningfulTranscription(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		// ノイズトークン – false であるべき
		{name: "half-paren music", text: "(音楽)", want: false},
		{name: "full-paren music", text: "（音楽）", want: false},
		{name: "bracket applause", text: "[拍手]", want: false},
		{name: "full-bracket noise", text: "【BGM】", want: false},
		{name: "music note", text: "♪", want: false},
		{name: "multiple noise tokens", text: "(音楽) (拍手)", want: false},
		{name: "empty", text: "", want: false},
		{name: "whitespace only", text: "   ", want: false},
		{name: "single punct", text: "。", want: false},
		{name: "noise + space", text: "(音楽)  ", want: false},

		// 有意な発話 – true であるべき
		{name: "moshi moshi", text: "もしもし。", want: true},
		{name: "hello", text: "こんにちは。", want: true},
		{name: "long sentence", text: "「ご視聴ありがとうございました」と言われません。", want: true},
		{name: "english sentence", text: "Hello, how are you?", want: true},
		{name: "noise + real speech", text: "(音楽) Hello world", want: true},
		{name: "two chars", text: "はい", want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isMeaningfulTranscription(tt.text)
			if got != tt.want {
				t.Errorf("isMeaningfulTranscription(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

// ─── isRepeatTranscription ───────────────────────────────────────────────────

func TestIsRepeatTranscription(t *testing.T) {
	history := []contextEntry{
		{Transcription: "Hello everyone.", Translation: "皆さんこんにちは。"},
		{Transcription: "Good morning.", Translation: "おはようございます。"},
		{Transcription: "Let's move on to the next topic.", Translation: "次の議題に移りましょう。"},
	}

	tests := []struct {
		name string
		text string
		want bool
	}{
		{"exact match", "Hello everyone.", true},
		{"case difference", "hello everyone.", true},
		{"punctuation difference", "Hello everyone", true},
		{"different text", "Good afternoon.", false},
		{"partial overlap is not dup", "Hello", false},
		{"empty input", "", false},
		{"second entry match", "Good morning.", true},
		{"history loop replay", "Let's move on to the next topic. Let's move on to the next topic.", true},
		{"double long sentence loop", strings.Repeat("Project update starts now. ", 2), true},
		{"long micro loop", strings.Repeat("Project update starts now. ", 3), true},
		{"dominant repeated suffix with preamble", "お待ちしています。 次の動画でお会いしましょう。 次の動画でお会いしましょう。 次の動画でお会いしましょう。", true},
		{"repeated suffix below dominant coverage", strings.Repeat("Actual agenda item discussion. ", 3) + strings.Repeat("Project update starts now. ", 3), false},
		{"short repeated emphasis allowed", "yes yes yes yes", false},
		{"repeated word in normal sentence", "This is very very important.", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isRepeatTranscription(tt.text, history)
			if got != tt.want {
				t.Errorf("isRepeatTranscription(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestIsRepeatTranscription_MicroLoopWithoutHistory(t *testing.T) {
	if !isRepeatTranscription(strings.Repeat("Project update starts now. ", 3), nil) {
		t.Error("long micro-loop should be filtered even without history")
	}
}

func TestIsRepeatTranscription_EmptyHistory(t *testing.T) {
	if isRepeatTranscription("hello", nil) {
		t.Error("plain non-loop text should not match with empty history")
	}
}

// ─── isKnownHallucination ────────────────────────────────────────────────────

func TestIsKnownHallucination(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		// ── ブロック: 日本語ハルシネーション ──────────────────────────────
		{"ja exact: ご視聴ありがとうございました", "ご視聴ありがとうございました", true},
		{"ja exact with punct", "ご視聴ありがとうございました。", true},
		{"ja exact: おやすみなさい", "おやすみなさい", true},
		{"ja exact: 次の動画でお会いしましょう", "次の動画でお会いしましょう。", true},
		{"ja exact: チャンネル登録お願いします", "チャンネル登録お願いします", true},
		{"ja exact: malformed phrase", "私たちのことを 持っています。", true},
		{"ja substring: チャンネル登録", "チャンネル登録よろしくお願いします！", true},
		{"ja substring: ご視聴", "今日もご視聴ありがとう", true},
		{"ja exact: 字幕は自動生成されています", "字幕は自動生成されています", true},
		{"ja exact: ご清聴ありがとうございました", "ご清聴ありがとうございました", true},
		// ── ブロック: 英語ハルシネーション ───────────────────────────────
		{"en exact: thank you for watching", "Thank you for watching.", true},
		{"en exact: thanks for watching", "Thanks for watching!", true},
		{"en exact: please subscribe", "Please subscribe.", true},
		{"en exact: like and subscribe", "Like and subscribe!", true},
		{"en exact: good night", "Good night.", true},
		{"en exact: see you next time", "See you next time!", true},
		{"en_substring: subtitles_by", "Subtitles by someone", true},
		{"en substring: amara.org", "Visit amara.org for more", true},
		// ── 通過: 正常な発話 ──────────────────────────────────────────────
		{"real: hello", "こんにちは", false},
		{"real: question", "次の議題に移りましょう", false},
		{"real: next video in context", "次の動画で確認した内容を議事録にまとめます", false},
		{"real: english", "Can you hear me?", false},
		{"real: ありがとう alone", "ありがとう", false},
		{"real: ありがとうございます alone", "ありがとうございます", false},
		{"empty", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isKnownHallucination(tt.text)
			if got != tt.want {
				t.Errorf("isKnownHallucination(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}
