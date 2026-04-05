// scorer_test.go — ChrF スコアラーの単体テスト

package main

import (
	"math"
	"testing"
)

func TestChrF_Identical(t *testing.T) {
	score := ChrF("始めましょう。", "始めましょう。")
	if score != 1.0 {
		t.Errorf("identical strings: want 1.0, got %.4f", score)
	}
}

func TestChrF_IdenticalASCII(t *testing.T) {
	score := ChrF("Let's get started.", "Let's get started.")
	if score != 1.0 {
		t.Errorf("identical ASCII strings: want 1.0, got %.4f", score)
	}
}

func TestChrF_EmptyHypothesis(t *testing.T) {
	score := ChrF("", "始めましょう。")
	if score != 0.0 {
		t.Errorf("empty hypothesis: want 0.0, got %.4f", score)
	}
}

func TestChrF_EmptyReference(t *testing.T) {
	score := ChrF("始めましょう。", "")
	if score != 0.0 {
		t.Errorf("empty reference: want 0.0, got %.4f", score)
	}
}

func TestChrF_PartialMatch(t *testing.T) {
	// 参照翻訳の一部のみマッチ
	score := ChrF("始めましょう", "始めましょう。")
	if score <= 0 || score >= 1 {
		t.Errorf("partial match: want 0 < score < 1, got %.4f", score)
	}
}

func TestChrF_Ordering(t *testing.T) {
	ref := "プルリクエストをレビューしてください。"
	// perfect > good > bad
	perfect := ChrF(ref, ref)
	good := ChrF("プルリクエストをレビューしてください", ref)   // 句読点なし
	bad := ChrF("全く異なる文字列のテスト", ref)
	if !(perfect >= good && good > bad) {
		t.Errorf("ordering failed: perfect=%.3f good=%.3f bad=%.3f", perfect, good, bad)
	}
}

func TestChrF_EnglishPartial(t *testing.T) {
	// 英語でも部分一致スコアが機能することを確認
	full := ChrF("Please review the pull request.", "Please review the pull request.")
	partial := ChrF("Please review pull request.", "Please review the pull request.")
	if full != 1.0 {
		t.Errorf("full match: want 1.0, got %.4f", full)
	}
	if partial <= 0 || partial >= 1 {
		t.Errorf("partial English match: want 0 < score < 1, got %.4f", partial)
	}
}

func TestSpeedScore_AtReference(t *testing.T) {
	// 基準レイテンシでスコア = 0.5
	score := speedScore(300, 300)
	if math.Abs(score-0.5) > 0.001 {
		t.Errorf("at reference latency: want ~0.5, got %.4f", score)
	}
}

func TestSpeedScore_FasterIsHigher(t *testing.T) {
	faster := speedScore(100, 300)
	slower := speedScore(500, 300)
	if faster <= slower {
		t.Errorf("faster should score higher: fast=%.3f, slow=%.3f", faster, slower)
	}
}

func TestSpeedScore_Zero(t *testing.T) {
	// 0ms (理論値) は 1.0
	score := speedScore(0, 300)
	if score != 1.0 {
		t.Errorf("zero latency: want 1.0, got %.4f", score)
	}
}

func TestCombinedScore_Range(t *testing.T) {
	// quality=1.0, latency=0ms → 最高スコア
	high := combinedScore(1.0, 0)
	// quality=0.0, latency=9999ms → 最低スコア
	low := combinedScore(0.0, 9999)
	if high <= low {
		t.Errorf("high should exceed low: high=%.3f, low=%.3f", high, low)
	}
	if high > 1.0 || low < 0.0 {
		t.Errorf("scores out of range: high=%.3f, low=%.3f", high, low)
	}
}

func TestDataset_AllIDs_Unique(t *testing.T) {
	seen := make(map[string]bool)
	for _, tc := range meetingDataset {
		if seen[tc.ID] {
			t.Errorf("duplicate ID: %s", tc.ID)
		}
		seen[tc.ID] = true
	}
}

func TestDataset_BidirectionalCount(t *testing.T) {
	if len(enToJaDataset) != len(jaToEnDataset) {
		t.Errorf("EN→JA (%d) と JA→EN (%d) の件数が一致しない",
			len(enToJaDataset), len(jaToEnDataset))
	}
	if len(meetingDataset) != len(enToJaDataset)+len(jaToEnDataset) {
		t.Errorf("meetingDataset の件数が不正: got %d, want %d",
			len(meetingDataset), len(enToJaDataset)+len(jaToEnDataset))
	}
}
