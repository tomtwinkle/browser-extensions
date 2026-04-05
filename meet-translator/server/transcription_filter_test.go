package main

import "testing"

func TestIsMeaningfulTranscription(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		// ノイズトークン – false であるべき
		{name: "half-paren music",       text: "(音楽)",                     want: false},
		{name: "full-paren music",       text: "（音楽）",                    want: false},
		{name: "bracket applause",       text: "[拍手]",                     want: false},
		{name: "full-bracket noise",     text: "【BGM】",                     want: false},
		{name: "music note",             text: "♪",                          want: false},
		{name: "multiple noise tokens",  text: "(音楽) (拍手)",                want: false},
		{name: "empty",                  text: "",                           want: false},
		{name: "whitespace only",        text: "   ",                        want: false},
		{name: "single punct",           text: "。",                          want: false},
		{name: "noise + space",          text: "(音楽)  ",                    want: false},

		// 有意な発話 – true であるべき
		{name: "moshi moshi",            text: "もしもし。",                  want: true},
		{name: "hello",                  text: "こんにちは。",                 want: true},
		{name: "long sentence",          text: "「ご視聴ありがとうございました」と言われません。", want: true},
		{name: "english sentence",       text: "Hello, how are you?",       want: true},
		{name: "noise + real speech",    text: "(音楽) Hello world",         want: true},
		{name: "two chars",              text: "はい",                        want: true},
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
