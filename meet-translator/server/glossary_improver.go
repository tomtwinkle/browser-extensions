// glossary_improver.go – バックグラウンド辞書自己改善ワーカー
//
// 翻訳が完了するたびに TranslationRecord をバッファに追加する。
// バッファが triggerSize に達すると、バックグラウンドで LLM 解析を実行し
// 辞書エントリを自動追加する。
//
// LLM には以下を依頼する:
//   - ASR 誤認識の修正候補 (corrections)
//   - 専門用語の翻訳マッピング (terms)
//
// 解析結果は glossary.json に永続化される。
package main

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
)

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

// TranslationRecord は 1 回の翻訳結果を保持する。
type TranslationRecord struct {
	Transcription string // whisper の文字起こし (corrections 適用後)
	Translation   string // llama の翻訳結果
	SourceLang    string
	TargetLang    string
}

// ---------------------------------------------------------------------------
// Improver
// ---------------------------------------------------------------------------

// GlossaryImprover はバックグラウンドで辞書を自己改善するコンポーネント。
type GlossaryImprover struct {
	glossary    *Glossary
	mu          sync.Mutex
	buffer      []TranslationRecord
	triggerSize int // バッファがこのサイズに達したら解析を実行

	// workCh にバッチを送ると worker goroutine が解析を実行する。
	// バッファサイズ 1 により、解析中に新バッチが届いても積み上がらない。
	workCh chan []TranslationRecord

	// generateFn は生プロンプトを LLM に送り結果テキストを返す。
	// テストではモックを注入できる。
	generateFn func(prompt string) (string, error)

	// templateFn は現在ロード中のモデルのチャットテンプレート名を返す。
	templateFn func() string
}

// newGlossaryImprover は GlossaryImprover を生成する。
// generateFn が nil の場合、解析は実行されない（テスト用途等）。
func newGlossaryImprover(
	g *Glossary,
	generateFn func(string) (string, error),
	templateFn func() string,
) *GlossaryImprover {
	return &GlossaryImprover{
		glossary:    g,
		triggerSize: 5,
		workCh:      make(chan []TranslationRecord, 1),
		generateFn:  generateFn,
		templateFn:  templateFn,
	}
}

// Start はバックグラウンドワーカーを起動する。ctx でシャットダウン可能。
func (imp *GlossaryImprover) Start(ctx context.Context) {
	go imp.worker(ctx)
}

// AddRecord は翻訳結果を記録し、必要に応じて解析をトリガーする。
// 非ブロッキング: 解析が既にキューに入っていれば skip する。
func (imp *GlossaryImprover) AddRecord(rec TranslationRecord) {
	if rec.Transcription == "" || rec.Translation == "" {
		return
	}
	imp.mu.Lock()
	imp.buffer = append(imp.buffer, rec)
	var batch []TranslationRecord
	if len(imp.buffer) >= imp.triggerSize {
		batch = imp.buffer
		imp.buffer = nil
	}
	imp.mu.Unlock()

	if batch != nil {
		select {
		case imp.workCh <- batch:
			logV("glossary-improver: queued analysis of %d records", len(batch))
		default:
			// 既に解析キュー済み。バッファは次の triggerSize まで待つ。
			imp.mu.Lock()
			imp.buffer = append(batch, imp.buffer...) // バッチをバッファに戻す
			imp.mu.Unlock()
		}
	}
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

func (imp *GlossaryImprover) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case batch := <-imp.workCh:
			imp.analyze(batch)
		}
	}
}

// analysisSuggestion は LLM が提案する 1 つの辞書エントリ。
type analysisSuggestion struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

// analysisResult は LLM の JSON 出力全体。
type analysisResult struct {
	Corrections []analysisSuggestion `json:"corrections"`
	Terms       []analysisSuggestion `json:"terms"`
}

// analyze は LLM を使ってバッチを解析し、辞書を更新する。
func (imp *GlossaryImprover) analyze(batch []TranslationRecord) {
	if imp.generateFn == nil {
		return
	}
	tmpl := "qwen" // デフォルト
	if imp.templateFn != nil {
		tmpl = imp.templateFn()
	}

	prompt := buildAnalysisPrompt(batch, tmpl)
	log.Printf("[glossary-improver] analyzing %d records (template=%s)...", len(batch), tmpl)

	out, err := imp.generateFn(prompt)
	if err != nil {
		log.Printf("[glossary-improver] LLM call failed: %v", err)
		return
	}
	logV("glossary-improver: raw LLM output: %s", out)

	result, err := parseAnalysisResult(out)
	if err != nil {
		log.Printf("[glossary-improver] parse failed: %v", err)
		return
	}

	added := 0
	for _, c := range result.Corrections {
		src := strings.TrimSpace(c.Source)
		tgt := strings.TrimSpace(c.Target)
		if src == "" || tgt == "" || src == tgt {
			continue
		}
		if err := imp.glossary.UpsertCorrection(src, tgt, "auto-improved"); err != nil {
			log.Printf("[glossary-improver] upsert correction failed: %v", err)
		} else {
			log.Printf("[glossary-improver] correction added: %q -> %q", src, tgt)
			added++
		}
	}
	for _, t := range result.Terms {
		src := strings.TrimSpace(t.Source)
		tgt := strings.TrimSpace(t.Target)
		if src == "" || tgt == "" {
			continue
		}
		if err := imp.glossary.UpsertTerm(src, tgt, "auto-improved"); err != nil {
			log.Printf("[glossary-improver] upsert term failed: %v", err)
		} else {
			log.Printf("[glossary-improver] term added: %q -> %q", src, tgt)
			added++
		}
	}
	if added > 0 {
		log.Printf("[glossary-improver] added %d entries to glossary", added)
	} else {
		log.Printf("[glossary-improver] no new entries suggested")
	}
}

// parseAnalysisResult は LLM の出力から JSON 部分を抽出してパースする。
func parseAnalysisResult(text string) (*analysisResult, error) {
	// LLM が JSON の前後にテキストを出力することがあるので中から抽出
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start == -1 || end == -1 || end <= start {
		return nil, nil // JSON なし = 提案なし
	}
	var res analysisResult
	if err := json.Unmarshal([]byte(text[start:end+1]), &res); err != nil {
		return nil, err
	}
	return &res, nil
}
