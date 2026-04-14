package main

// transcription_filter.go – Whisper 文字起こし結果の品質フィルター
//
// Whisper は以下の条件でハルシネーションを起こしやすい:
//   - 無音 / 低音量セグメント
//   - BGM・環境音のみのセグメント
//
// このファイルでは 3 種類のフィルターを提供する:
//  1. isMeaningfulTranscription  – ノイズアノテーション除去 + 最小文字数チェック
//  2. isRepeatTranscription      – 直近発話との重複 / 反復ループ検出
//  3. isKnownHallucination       – 既知ハルシネーションフレーズのブロックリスト

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
var noiseTokenRe = regexp.MustCompile(
	`[\(（].*?[\)）]|[\[【].*?[\]】]|[♪♫♬🎵🎶]`,
)

const (
	// minMeaningfulRunes は「有意な発話」とみなすための最小文字数。
	minMeaningfulRunes = 2

	// 長時間セッションで発生しやすい「同じフレーズのループ再生」を低リスクで弾く閾値。
	// 短い単位は 4 回以上、十分に長い単位は 2 回以上の完全反復を hallucination とみなす。
	minLoopUnitRunes      = 4
	minLoopRepeats        = 4
	minLongLoopUnitRunes  = 8
	minLongLoopRepeats    = 2
	minHistoryLoopRunes   = 8
	minHistoryLoopRepeats = 2

	// 先頭/末尾に少量の別文が混ざっていても、本文の大半が長い反復なら hallucination とみなす。
	dominantLoopCoverageNumerator   = 2
	dominantLoopCoverageDenominator = 3
)

// ── ブロックリスト ──────────────────────────────────────────────────────────

// hallucinationExactPhrases は正規化後に完全一致でフィルタするフレーズ一覧。
//
// 選定基準: ビジネスミーティングでは通常発生しない
//
//	YouTube/放送コンテンツ特有の締め言葉・字幕クレジット・システム通知。
//
// 参照:
//   - https://github.com/openai/whisper/discussions/1873
//   - https://github.com/openai/whisper/discussions/2377
var hallucinationExactPhrases = []string{
	// ── 日本語: YouTube/放送 締め言葉 ────────────────────────────────────
	"ご視聴ありがとうございました",
	"ご視聴ありがとうございます",
	"ご視聴いただきありがとうございました",
	"ご視聴いただきありがとうございます",
	"ご清聴ありがとうございました",
	"お聞きいただきありがとうございました",
	"見てくれてありがとう",
	"見てくれてありがとうございます",
	"ご覧いただきありがとうございました",
	"ご覧いただきありがとうございます",
	// ── 日本語: 挨拶系ハルシネーション ───────────────────────────────────
	"おやすみなさい",
	"おやすみ",
	"またお会いしましょう",
	"次の動画でお会いしましょう",
	"また次の動画でお会いしましょう",
	"次回の動画でお会いしましょう",
	"次回もお楽しみに",
	"またね",
	"バイバイ",
	"私たちのことを持っています",
	// ── 日本語: チャンネル登録・高評価 ───────────────────────────────────
	"チャンネル登録よろしくお願いします",
	"チャンネル登録お願いします",
	"チャンネル登録してね",
	"チャンネル登録はこちら",
	"高評価チャンネル登録お願いします",
	"チャンネル登録と高評価お願いします",
	// ── 日本語: 字幕・翻訳クレジット ─────────────────────────────────────
	"字幕は自動生成されています",
	"字幕はai自動生成されています",
	"字幕はai生成されています",
	// ── 英語: YouTube 締め言葉 ────────────────────────────────────────────
	"thank you for watching",
	"thanks for watching",
	"thank you for watching my video",
	"thank you for watching until the end",
	"thank you for watching this video",
	"thanks for watching this video",
	// ── 英語: 購読・高評価促進 ───────────────────────────────────────────
	"please subscribe",
	"subscribe to my channel",
	"like and subscribe",
	"don't forget to subscribe",
	"don't forget to like and subscribe",
	"hit the subscribe button",
	"click the subscribe button",
	"click subscribe",
	// ── 英語: 挨拶系ハルシネーション ────────────────────────────────────
	"good night",
	"see you next time",
	"see you in the next video",
	"bye bye",
	// ── 英語: 字幕・翻訳クレジット ──────────────────────────────────────
	"translated by amara",
	"translated by amara.org community",
	"transcribed by amara.org community",
}

// hallucinationSubstrings は正規化後に部分一致でフィルタするパターン一覧。
//
// 選定基準: ビジネスミーティングでは「絶対に」使われない固有表現。
//
//	サブストリングとして含むだけでハルシネーションと断定できるもの。
var hallucinationSubstrings = []string{
	// "ご視聴" は YouTube アウトロ特有; ビジネスMTGには登場しない
	"ご視聴",
	// チャンネル登録系はすべて YouTube/SNS 文脈
	"チャンネル登録",
	// 字幕制作・翻訳字幕クレジットはコンテンツ制作文脈のみ
	"字幕制作",
	"翻訳字幕",
	// 字幕・翻訳クレジット ("Subtitles by Name" 等のバリアントも捕捉)
	"subtitles by",
	"closed captions by",
	// Amara 字幕プラットフォームのドメイン
	"amara.org",
	// Touhou 固有ハルシネーション (openai/whisper#1873 で報告)
	"this video is a derivative work of the touhou",
	"it is based on the touhou project",
}

// ── フィルター関数 ──────────────────────────────────────────────────────────

// normalizeForDedup はテキストを小文字化・句読点/空白除去して正規化する。
// 発話重複検出・ハルシネーション判定の比較キーとして使用する。
func normalizeForDedup(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func runeSlicesEqual(a, b []rune) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// isRepeatedNormalizedUnit は norm が unit の完全反復で構成されているかを判定する。
func isRepeatedNormalizedUnit(norm, unit string, minUnitRunes, minRepeats int) bool {
	if norm == "" || unit == "" {
		return false
	}
	normRunes := []rune(norm)
	unitRunes := []rune(unit)
	if len(unitRunes) < minUnitRunes || len(normRunes) < len(unitRunes)*minRepeats {
		return false
	}
	if len(normRunes)%len(unitRunes) != 0 {
		return false
	}
	repeats := len(normRunes) / len(unitRunes)
	if repeats < minRepeats {
		return false
	}
	for start := 0; start < len(normRunes); start += len(unitRunes) {
		if !runeSlicesEqual(normRunes[start:start+len(unitRunes)], unitRunes) {
			return false
		}
	}
	return true
}

// isRepeatedNormalizedPattern は norm 全体が短い単位の反復で構成されるかを判定する。
// Whisper が長時間セッションで陥る「同一句の無限ループ」検出に使用する。
func isRepeatedNormalizedPattern(norm string, minUnitRunes, minRepeats int) bool {
	normRunes := []rune(norm)
	total := len(normRunes)
	if total < minUnitRunes*minRepeats {
		return false
	}
	for unitLen := minUnitRunes; unitLen <= total/minRepeats; unitLen++ {
		if total%unitLen != 0 {
			continue
		}
		repeats := total / unitLen
		if repeats < minRepeats {
			continue
		}
		unit := normRunes[:unitLen]
		match := true
		for start := unitLen; start < total; start += unitLen {
			if !runeSlicesEqual(normRunes[start:start+unitLen], unit) {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// hasDominantRepeatedNormalizedRun は、norm 全体ではなく一部だけが長い反復でも、
// その反復が本文の大半を占めるなら hallucination とみなす。
func hasDominantRepeatedNormalizedRun(norm string, minUnitRunes, minRepeats int) bool {
	normRunes := []rune(norm)
	total := len(normRunes)
	if total < minUnitRunes*minRepeats {
		return false
	}
	for unitLen := minUnitRunes; unitLen <= total/minRepeats; unitLen++ {
		maxStart := total - unitLen*minRepeats
		for start := 0; start <= maxStart; start++ {
			unit := normRunes[start : start+unitLen]
			repeats := 1
			next := start + unitLen
			for next+unitLen <= total && runeSlicesEqual(normRunes[next:next+unitLen], unit) {
				repeats++
				next += unitLen
			}
			if repeats < minRepeats {
				continue
			}
			repeatedRunes := unitLen * repeats
			if repeatedRunes*dominantLoopCoverageDenominator >= total*dominantLoopCoverageNumerator {
				return true
			}
		}
	}
	return false
}

// isKnownHallucination は text が Whisper の既知ハルシネーションフレーズかどうかを判定する。
//
// 判定ロジック:
//  1. 正規化後に hallucinationExactPhrases のいずれかと完全一致
//  2. 正規化後に hallucinationSubstrings のいずれかを部分一致で含む
func isKnownHallucination(text string) bool {
	norm := normalizeForDedup(text)
	if norm == "" {
		return false
	}
	for _, phrase := range hallucinationExactPhrases {
		if norm == normalizeForDedup(phrase) {
			return true
		}
	}
	for _, sub := range hallucinationSubstrings {
		if strings.Contains(norm, normalizeForDedup(sub)) {
			return true
		}
	}
	return false
}

// isRepeatTranscription は text が直近の発話履歴と実質同一、または
// 反復ループ状の hallucination かどうかを判定する。
// Whisper が initial_prompt なしでも過去発話を幻覚再生した場合や、
// 長時間セッションで同一句を連打する場合を検出する。
func isRepeatTranscription(text string, history []contextEntry) bool {
	norm := normalizeForDedup(text)
	if norm == "" {
		return false
	}
	if isRepeatedNormalizedPattern(norm, minLongLoopUnitRunes, minLongLoopRepeats) ||
		isRepeatedNormalizedPattern(norm, minLoopUnitRunes, minLoopRepeats) ||
		hasDominantRepeatedNormalizedRun(norm, minLongLoopUnitRunes, minLongLoopRepeats) ||
		hasDominantRepeatedNormalizedRun(norm, minLoopUnitRunes, minLoopRepeats) {
		return true
	}
	for _, e := range history {
		histNorm := normalizeForDedup(e.Transcription)
		if histNorm == norm {
			return true
		}
		if isRepeatedNormalizedUnit(norm, histNorm, minHistoryLoopRunes, minHistoryLoopRepeats) {
			return true
		}
	}
	return false
}

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
