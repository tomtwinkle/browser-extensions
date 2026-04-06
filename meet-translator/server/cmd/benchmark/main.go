// cmd/benchmark/main.go — LLM 翻訳品質・速度ベンチマークツール
//
// # 使い方
//
// サーバーを起動した状態でベンチマークを実行:
//
//	./server --llama-model bonsai-8b &
//	go run ./cmd/benchmark/ --output results/bonsai-8b.json
//
// 複数モデルを比較:
//
//	go run ./cmd/benchmark/ --compare results/
//
// # フラグ
//
//	--server   URL   サーバーアドレス (デフォルト: http://localhost:7070)
//	--runs     N     各テストケースの実行回数 (デフォルト: 3)
//	--warmup   N     ウォームアップ回数 (デフォルト: 2)
//	--output   FILE  結果を JSON 保存するファイルパス
//	--compare  DIR   DIR 内の JSON 結果ファイルを比較して順位表を表示
//	--dir      STR   翻訳方向フィルタ: "en-ja" | "ja-en" | "both" (デフォルト: both)
//	--verbose        各テストケースの入出力を詳細表示

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────────────────────────

// CaseResult は 1 テストケースの実行結果。
type CaseResult struct {
	Case      BenchCase `json:"case"`
	Output    string    `json:"output"`
	Quality   float64   `json:"quality"`   // ChrF スコア (0-1)
	LatencyMs float64   `json:"latency_ms"` // 平均レイテンシ (ms)
	Error     string    `json:"error,omitempty"`
}

// DirectionStats は翻訳方向別の集計。
type DirectionStats struct {
	Count      int     `json:"count"`
	AvgQuality float64 `json:"avg_quality"`
	AvgLatency float64 `json:"avg_latency_ms"`
}

// CategoryStats はカテゴリ別の集計。
type CategoryStats struct {
	Count      int     `json:"count"`
	AvgQuality float64 `json:"avg_quality"`
	AvgLatency float64 `json:"avg_latency_ms"`
}

// ModelResult はモデル全体のベンチマーク結果。
type ModelResult struct {
	Model        string                    `json:"model"`
	Server       string                    `json:"server"`
	Timestamp    string                    `json:"timestamp"`
	Runs         int                       `json:"runs"`
	Cases        []CaseResult              `json:"cases"`
	AvgQuality   float64                   `json:"avg_quality"`
	AvgLatencyMs float64                   `json:"avg_latency_ms"`
	Combined     float64                   `json:"combined_score"`
	ByDirection  map[string]DirectionStats `json:"by_direction"`
	ByCategory   map[string]CategoryStats  `json:"by_category"`
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP クライアント
// ─────────────────────────────────────────────────────────────────────────────

func translateViaHTTP(serverURL, text, sourceLang, targetLang string) (string, error) {
	endpoint := strings.TrimRight(serverURL, "/") + "/translate"
	form := url.Values{
		"text":        {text},
		"source_lang": {sourceLang},
		"target_lang": {targetLang},
	}
	resp, err := http.PostForm(endpoint, form)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var result struct {
		Translation string `json:"translation"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}
	return result.Translation, nil
}

// getModelName はサーバーの /health から現在のモデル名を取得する。
func getModelName(serverURL string) (string, error) {
	endpoint := strings.TrimRight(serverURL, "/") + "/health"
	resp, err := http.Get(endpoint) //nolint:noctx
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result struct {
		LlamaModel string `json:"llama_model"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "unknown", nil
	}
	return result.LlamaModel, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// ベンチマーク実行
// ─────────────────────────────────────────────────────────────────────────────

// filterDataset は方向フィルタ ("en-ja" | "ja-en" | "both") でケースを絞り込む。
func filterDataset(dir string) []BenchCase {
	switch dir {
	case "en-ja":
		return enToJaDataset
	case "ja-en":
		return jaToEnDataset
	default:
		return meetingDataset
	}
}

func runBenchmark(serverURL string, runs, warmup int, direction string, verbose bool) (*ModelResult, error) {
	model, err := getModelName(serverURL)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to server at %s: %w", serverURL, err)
	}

	dataset := filterDataset(direction)

	fmt.Printf("=== LLM Translation Benchmark ===\n")
	fmt.Printf("Server:    %s\n", serverURL)
	fmt.Printf("Model:     %s\n", model)
	fmt.Printf("Direction: %s | Cases: %d | Warm-up: %d | Runs: %d\n\n",
		direction, len(dataset), warmup, runs)

	// ウォームアップ
	if warmup > 0 {
		fmt.Printf("Warming up (%d requests)...\n", warmup)
		for i := 0; i < warmup; i++ {
			tc := dataset[i%len(dataset)]
			_, _ = translateViaHTTP(serverURL, tc.Input, tc.Source, tc.Target)
		}
		fmt.Println()
	}

	// 各テストケースを実行
	cases := make([]CaseResult, 0, len(dataset))
	for i, tc := range dataset {
		var latencies []float64
		var lastOutput, lastErr string

		for r := 0; r < runs; r++ {
			start := time.Now()
			out, err := translateViaHTTP(serverURL, tc.Input, tc.Source, tc.Target)
			elapsed := float64(time.Since(start).Milliseconds())
			if err != nil {
				lastErr = err.Error()
			} else {
				lastOutput = out
				latencies = append(latencies, elapsed)
			}
		}

		avgLatency := avg(latencies)
		quality := ChrF(lastOutput, tc.Reference)

		cr := CaseResult{
			Case:      tc,
			Output:    lastOutput,
			Quality:   quality,
			LatencyMs: avgLatency,
			Error:     lastErr,
		}
		cases = append(cases, cr)

		dir := fmt.Sprintf("%s→%s", tc.Source, tc.Target)
		if verbose {
			fmt.Printf("[%d/%d] %-8s %-6s  in:  %s\n", i+1, len(dataset), tc.ID, dir, tc.Input)
			fmt.Printf("                            out: %s\n", lastOutput)
			fmt.Printf("                            ref: %s\n", tc.Reference)
			fmt.Printf("                            score=%.3f  %dms\n\n", quality, int(avgLatency))
		} else {
			fmt.Printf("[%d/%d] %-8s %-6s  score=%.3f  %dms\n",
				i+1, len(dataset), tc.ID, dir, quality, int(avgLatency))
		}
	}

	mr := aggregateResults(model, serverURL, runs, cases)
	return mr, nil
}

func avg(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	total := 0.0
	for _, v := range vals {
		total += v
	}
	return total / float64(len(vals))
}

func aggregateResults(model, server string, runs int, cases []CaseResult) *ModelResult {
	type accumulator struct {
		quality, latency float64
		count            int
	}
	dirMap := make(map[string]*accumulator)
	catMap := make(map[string]*accumulator)
	totalQ, totalL := 0.0, 0.0
	validCount := 0

	for _, cr := range cases {
		if cr.Error != "" {
			continue
		}
		totalQ += cr.Quality
		totalL += cr.LatencyMs
		validCount++

		dirKey := cr.Case.Source + "→" + cr.Case.Target
		if dirMap[dirKey] == nil {
			dirMap[dirKey] = &accumulator{}
		}
		dirMap[dirKey].quality += cr.Quality
		dirMap[dirKey].latency += cr.LatencyMs
		dirMap[dirKey].count++

		cat := cr.Case.Category
		if catMap[cat] == nil {
			catMap[cat] = &accumulator{}
		}
		catMap[cat].quality += cr.Quality
		catMap[cat].latency += cr.LatencyMs
		catMap[cat].count++
	}

	n := float64(validCount)
	if n == 0 {
		n = 1
	}
	avgQ := totalQ / n
	avgL := totalL / n

	byDir := make(map[string]DirectionStats)
	for k, s := range dirMap {
		c := float64(s.count)
		byDir[k] = DirectionStats{
			Count:      s.count,
			AvgQuality: s.quality / c,
			AvgLatency: s.latency / c,
		}
	}
	byCat := make(map[string]CategoryStats)
	for k, s := range catMap {
		c := float64(s.count)
		byCat[k] = CategoryStats{
			Count:      s.count,
			AvgQuality: s.quality / c,
			AvgLatency: s.latency / c,
		}
	}

	return &ModelResult{
		Model:        model,
		Server:       server,
		Timestamp:    time.Now().Format(time.RFC3339),
		Runs:         runs,
		Cases:        cases,
		AvgQuality:   avgQ,
		AvgLatencyMs: avgL,
		Combined:     combinedScore(avgQ, avgL),
		ByDirection:  byDir,
		ByCategory:   byCat,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 結果の表示・保存・比較
// ─────────────────────────────────────────────────────────────────────────────

func printResult(mr *ModelResult) {
	sep := strings.Repeat("─", 54)

	fmt.Printf("\n【翻訳方向別】\n")
	fmt.Printf("%-12s %6s %9s %9s\n", "Direction", "Cases", "Quality", "Latency")
	fmt.Println(sep)
	dirs := sortedKeys(mr.ByDirection)
	for _, d := range dirs {
		s := mr.ByDirection[d]
		fmt.Printf("%-12s %6d %9.3f %7dms\n", d, s.Count, s.AvgQuality, int(s.AvgLatency))
	}

	fmt.Printf("\n【カテゴリ別】\n")
	fmt.Printf("%-12s %6s %9s %9s\n", "Category", "Cases", "Quality", "Latency")
	fmt.Println(sep)
	cats := sortedKeys(mr.ByCategory)
	for _, c := range cats {
		s := mr.ByCategory[c]
		fmt.Printf("%-12s %6d %9.3f %7dms\n", c, s.Count, s.AvgQuality, int(s.AvgLatency))
	}

	fmt.Println(sep)
	fmt.Printf("%-12s %6d %9.3f %7dms\n", "Overall", len(mr.Cases), mr.AvgQuality, int(mr.AvgLatencyMs))
	fmt.Printf("\nCombined score (quality×0.6 + speed×0.4): %.3f\n", mr.Combined)
	fmt.Printf("  quality=%.3f  latency=%dms  speed_score=%.3f\n",
		mr.AvgQuality, int(mr.AvgLatencyMs), speedScore(mr.AvgLatencyMs, 300))
}

func saveResult(mr *ModelResult, path string) error {
	data, err := json.MarshalIndent(mr, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func compareResults(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("cannot read directory %s: %w", dir, err)
	}
	var results []ModelResult
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var mr ModelResult
		if err := json.Unmarshal(data, &mr); err != nil {
			fmt.Fprintf(os.Stderr, "warn: %s: %v\n", e.Name(), err)
			continue
		}
		results = append(results, mr)
	}
	if len(results) == 0 {
		return fmt.Errorf("no benchmark results found in %s", dir)
	}

	// 総合スコア降順でソート
	sort.Slice(results, func(i, j int) bool {
		return results[i].Combined > results[j].Combined
	})

	sep := strings.Repeat("─", 68)
	fmt.Printf("=== Benchmark Comparison (%d models) ===\n\n", len(results))
	fmt.Printf("%-4s %-28s %9s %9s %9s\n", "Rank", "Model", "Quality", "Latency", "Score")
	fmt.Println(sep)
	for i, r := range results {
		fmt.Printf("%4d %-28s %9.3f %7dms %9.3f\n",
			i+1, truncate(r.Model, 28), r.AvgQuality, int(r.AvgLatencyMs), r.Combined)
	}
	fmt.Printf("\nScore = quality×0.6 + speed×0.4  (speed = 1/(1 + latency/300ms))\n")

	// autoconfig 推奨
	fmt.Printf("\n=== Recommended autoconfig tier assignments ===\n")
	n := len(results)
	for i, r := range results {
		var tier string
		switch {
		case i == 0:
			tier = "top quality  → gpu ≥32GB / cpu ≥16GB"
		case float64(i) < float64(n)*0.25:
			tier = "high quality → gpu ≥16GB / cpu ≥8GB"
		case float64(i) < float64(n)*0.5:
			tier = "balanced     → gpu ≥4GB  / cpu ≥4GB"
		case float64(i) < float64(n)*0.75:
			tier = "speed focus  → gpu <4GB  / cpu ≥2GB"
		default:
			tier = "fallback     → cpu <2GB"
		}
		fmt.Printf("  %2d. %-28s → %s\n", i+1, r.Model, tier)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen-1]) + "…"
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

func main() {
	serverURL := flag.String("server", "http://localhost:7070", "running server URL")
	runs := flag.Int("runs", 3, "number of runs per test case")
	warmup := flag.Int("warmup", 2, "number of warm-up requests before measuring")
	output := flag.String("output", "", "save results to this JSON file (e.g. results/bonsai-8b.json)")
	compare := flag.String("compare", "", "directory with JSON result files to compare and rank")
	direction := flag.String("dir", "both", `translation direction filter: "en-ja" | "ja-en" | "both"`)
	verbose := flag.Bool("verbose", false, "print input/output/reference for each test case")
	flag.Parse()

	if *compare != "" {
		if err := compareResults(*compare); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		return
	}

	mr, err := runBenchmark(*serverURL, *runs, *warmup, *direction, *verbose)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}

	printResult(mr)

	if *output != "" {
		if err := saveResult(mr, *output); err != nil {
			fmt.Fprintln(os.Stderr, "warn: cannot save results:", err)
		} else {
			fmt.Printf("\nResults saved to: %s\n", *output)
		}
	} else {
		fmt.Printf("\nTip: rerun with --output results/<model-name>.json to save for comparison\n")
	}
}
