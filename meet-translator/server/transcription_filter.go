package main

// transcription_filter.go – Whisper 文字起こし結果の品質フィルター
//
// Whisper は無音・BGM・雑音を検出した際に "(音楽)" や "(拍手)" などの
// 非音声アノテーションを返すことがある。これらをフィルタして
// 実際の発話のみを処理対象にする。

import (
	"regexp"
	"strings"
	"unicode"
)

// noiseTokenRe は Whisper が出力する非音声アノテーション表記にマッチする。
//
// マッチ対象:
//   - (音楽) / （音楽） : 半角・全角かっこ
//   - [拍手] / 【拍手】 : 半角・全角ブラケット
//   - ♪ ♫ ♬ 🎵 🎶      : 音楽記号
//
// 非マッチ (実際の発話で使われる):
//   - 「ご視聴ありがとう」 : 日本語引用符
var noiseTokenRe = regexp.MustCompile(
	`[\(（].*?[\)）]|[\[【].*?[\]】]|[♪♫♬🎵🎶]`,
)

// minMeaningfulRunes は「有意な発話」とみなすための最小文字数。
// 日本語は 1 文字で意味を持つケースもあるため、2 以上を基準とする。
const minMeaningfulRunes = 2

// isMeaningfulTranscription は文字起こしテキストが実際の発話かどうかを判定する。
//
// false を返す条件:
//   - ノイズトークンを除去した残りが minMeaningfulRunes 文字未満
//   - 除去後に空白・句読点・記号のみ
func isMeaningfulTranscription(text string) bool {
	// 1. ノイズトークンを除去
	cleaned := noiseTokenRe.ReplaceAllString(text, "")

	// 2. 先頭・末尾の空白 / 句読点 / 記号を除去
	cleaned = strings.TrimFunc(cleaned, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r)
	})

	// 3. 残ったルーン数が閾値以上なら有意と判断
	return len([]rune(cleaned)) >= minMeaningfulRunes
}
