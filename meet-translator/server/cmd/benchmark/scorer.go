// scorer.go — ChrF (character n-gram F-score) による翻訳品質評価
//
// ChrF は機械翻訳評価の標準指標のひとつ。
// 文字 n-gram の precision/recall F1 を計算するため、
// 形態素解析なしに日本語・英語の両方に適用できる。
//
// 参考: Popović (2015) "chrF: character n-gram F-score for automatic MT evaluation"

package main

// charNgrams は文字列から文字 n-gram の出現回数マップを返す。
// 日本語は 1 文字 = 1 ルーン単位、ASCII は 1 文字単位で扱う。
func charNgrams(s string, n int) map[string]int {
	runes := []rune(s)
	if len(runes) < n {
		return map[string]int{}
	}
	counts := make(map[string]int, len(runes)-n+1)
	for i := 0; i <= len(runes)-n; i++ {
		ngram := string(runes[i : i+n])
		counts[ngram]++
	}
	return counts
}

// ngramTotal は n-gram マップの合計出現回数を返す。
func ngramTotal(m map[string]int) int {
	total := 0
	for _, c := range m {
		total += c
	}
	return total
}

// ngramF は hypothesis と reference 間の n-gram F1 スコアを計算する。
// clipped matching (BLEU スタイル) で過剰生成ペナルティを与える。
func ngramF(hyp, ref string, n int) float64 {
	hypNgrams := charNgrams(hyp, n)
	refNgrams := charNgrams(ref, n)
	hypTotal := ngramTotal(hypNgrams)
	refTotal := ngramTotal(refNgrams)
	if hypTotal == 0 || refTotal == 0 {
		return 0
	}
	matches := 0
	for ng, hypCnt := range hypNgrams {
		if refCnt, ok := refNgrams[ng]; ok {
			if hypCnt < refCnt {
				matches += hypCnt
			} else {
				matches += refCnt
			}
		}
	}
	precision := float64(matches) / float64(hypTotal)
	recall := float64(matches) / float64(refTotal)
	if precision+recall == 0 {
		return 0
	}
	return 2 * precision * recall / (precision + recall)
}

// ChrF は文字 n-gram F-score (ChrF) を計算する。
// n=1,2,3 の平均値を返す。範囲 0.0〜1.0。
// hypothesis が reference と完全一致する場合 1.0 を返す。
func ChrF(hypothesis, reference string) float64 {
	const maxN = 3
	total := 0.0
	for n := 1; n <= maxN; n++ {
		total += ngramF(hypothesis, reference, n)
	}
	return total / maxN
}

// speedScore はレイテンシ (ms) を 0.0〜1.0 の速度スコアに変換する。
// refMS を基準として、速いほど 1 に近く、遅いほど 0 に近い。
// speedScore(refMS, refMS) = 0.5
func speedScore(latencyMs, refMS float64) float64 {
	return 1.0 / (1.0 + latencyMs/refMS)
}

// combinedScore は品質と速度を合算した総合スコア (0.0〜1.0) を返す。
// qualityWeight=0.6, speedWeight=0.4 で加重平均。
// 速度の基準は 300ms (会議翻訳のリアルタイム要件)。
func combinedScore(quality, latencyMs float64) float64 {
	const refLatencyMs = 300.0
	const qualityWeight = 0.6
	ss := speedScore(latencyMs, refLatencyMs)
	return qualityWeight*quality + (1-qualityWeight)*ss
}
