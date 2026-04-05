// glossary.go – 汎用誤訳修正・専門用語マッピング辞書
//
// 2 種類のエントリを管理する:
//
//	corrections: whisper が誤認識しやすいテキストの修正マップ
//	             例: "a pie" → "API", "get hub" → "GitHub"
//	terms:       専門用語の翻訳マッピング。LLM プロンプトに注入される。
//	             例: "pull request" → "プルリクエスト"
//
// 辞書は JSON ファイルに永続化される:
//
//	macOS/Linux: ~/.config/meet-translator/glossary.json
//	Windows:     %APPDATA%\meet-translator\glossary.json
//
// API エンドポイント:
//
//	GET    /glossary                       全エントリ取得
//	POST   /glossary/corrections           correction 追加/更新
//	DELETE /glossary/corrections/{source}  correction 削除
//	POST   /glossary/terms                 term 追加/更新
//	DELETE /glossary/terms/{source}        term 削除
//	POST   /glossary/learn                 自動学習 (extension から送信)
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

// GlossaryEntry は辞書の 1 エントリ。
type GlossaryEntry struct {
	Source      string `json:"source"`
	Target      string `json:"target"`
	Description string `json:"description,omitempty"`
}

// GlossaryData は glossary.json の全データ。
type GlossaryData struct {
	// Corrections: whisper が誤認識しやすいテキストの修正マップ。
	// キーは source テキスト。
	Corrections map[string]GlossaryEntry `json:"corrections"`
	// Terms: 専門用語の翻訳マッピング。LLM プロンプトに注入される。
	Terms map[string]GlossaryEntry `json:"terms"`
}

// compiledCorrection はコンパイル済み正規表現と置換先のペア。
type compiledCorrection struct {
	re     *regexp.Regexp
	target string
}

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

// Glossary は辞書データのスレッドセーフなラッパー。
type Glossary struct {
	mu       sync.RWMutex
	data     GlossaryData
	compiled []compiledCorrection // 長さ降順ソート済み、mu で保護
	filePath string
}

// glossaryFilePath は glossary.json のフルパスを返す。
func glossaryFilePath() string {
	return filepath.Join(configDir(), "glossary.json")
}

// loadGlossary は glossary.json を読み込んで Glossary を返す。
// ファイルが存在しない場合は空の Glossary を返す。
func loadGlossary() *Glossary {
	g := &Glossary{
		filePath: glossaryFilePath(),
		data: GlossaryData{
			Corrections: make(map[string]GlossaryEntry),
			Terms:       make(map[string]GlossaryEntry),
		},
	}
	data, err := os.ReadFile(g.filePath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[glossary] failed to load %s: %v", g.filePath, err)
			return g
		}
		// ファイルが存在しない場合はデフォルト辞書で初期化して保存する
		g.data = defaultGlossaryData()
		g.recompileLocked()
		if saveErr := g.save(); saveErr != nil {
			log.Printf("[glossary] failed to save default glossary: %v", saveErr)
		} else {
			log.Printf("[glossary] created default glossary at %s (%d corrections, %d terms)",
				g.filePath, len(g.data.Corrections), len(g.data.Terms))
		}
		return g
	}
	if err := json.Unmarshal(data, &g.data); err != nil {
		log.Printf("[glossary] failed to parse %s: %v", g.filePath, err)
		return g
	}
	if g.data.Corrections == nil {
		g.data.Corrections = make(map[string]GlossaryEntry)
	}
	if g.data.Terms == nil {
		g.data.Terms = make(map[string]GlossaryEntry)
	}
	g.recompileLocked()
	logV("glossary loaded: %d corrections, %d terms", len(g.data.Corrections), len(g.data.Terms))
	return g
}

// defaultGlossaryData は SWE/AI エンジニア向けのデフォルト辞書データを返す。
// glossary.json が存在しない場合にのみ使用される。
func defaultGlossaryData() GlossaryData {
	corr := func(src, tgt, desc string) GlossaryEntry {
		return GlossaryEntry{Source: src, Target: tgt, Description: desc}
	}
	term := func(src, tgt string) GlossaryEntry {
		return GlossaryEntry{Source: src, Target: tgt}
	}

	return GlossaryData{
		// ── ASR 誤認識修正 ─────────────────────────────────────────────────────
		// Whisper が音として拾いやすい誤認識パターンを修正する
		Corrections: map[string]GlossaryEntry{
			// 英語の発音から誤認識されやすいケース
			"a pie":            corr("a pie", "API", "Whisper misrecognition of 'API'"),
			"get hub":          corr("get hub", "GitHub", "Whisper misrecognition of 'GitHub'"),
			"dock her":         corr("dock her", "Docker", "Whisper misrecognition of 'Docker'"),
			"pie thon":         corr("pie thon", "Python", "Whisper misrecognition of 'Python'"),
			"sequel":           corr("sequel", "SQL", "Common spoken form of SQL"),
			"my sequel":        corr("my sequel", "MySQL", "Whisper misrecognition of 'MySQL'"),
			"post gres":        corr("post gres", "PostgreSQL", "Whisper misrecognition of 'PostgreSQL'"),
			"no sequel":        corr("no sequel", "NoSQL", "Whisper misrecognition of 'NoSQL'"),
			"get lab":          corr("get lab", "GitLab", "Whisper misrecognition of 'GitLab'"),
			"kube cuddle":      corr("kube cuddle", "kubectl", "Whisper misrecognition of 'kubectl'"),
			"terra form":       corr("terra form", "Terraform", "Whisper misrecognition of 'Terraform'"),
			"pie torch":        corr("pie torch", "PyTorch", "Whisper misrecognition of 'PyTorch'"),
			"tensor flow":      corr("tensor flow", "TensorFlow", "Whisper misrecognition of 'TensorFlow'"),
			"hugging face":     corr("hugging face", "HuggingFace", "Whisper misrecognition of 'HuggingFace'"),
			"lang chain":       corr("lang chain", "LangChain", "Whisper misrecognition of 'LangChain'"),
			"open a eye":       corr("open a eye", "OpenAI", "Whisper misrecognition of 'OpenAI'"),
			"chat gee pee tea": corr("chat gee pee tea", "ChatGPT", "Whisper misrecognition of 'ChatGPT'"),
		},

		// ── 専門用語翻訳マッピング ────────────────────────────────────────────
		// LLM プロンプトに注入し、一貫した訳語を強制する
		Terms: map[string]GlossaryEntry{
			// VCS / Git
			"pull request": term("pull request", "プルリクエスト"),
			"merge":        term("merge", "マージ"),
			"branch":       term("branch", "ブランチ"),
			"commit":       term("commit", "コミット"),
			"repository":   term("repository", "リポジトリ"),
			"fork":         term("fork", "フォーク"),
			"clone":        term("clone", "クローン"),
			"rebase":       term("rebase", "リベース"),
			"cherry-pick":  term("cherry-pick", "チェリーピック"),
			"stash":        term("stash", "スタッシュ"),
			"tag":          term("tag", "タグ"),

			// 開発プロセス
			"deploy":           term("deploy", "デプロイ"),
			"release":          term("release", "リリース"),
			"rollback":         term("rollback", "ロールバック"),
			"hotfix":           term("hotfix", "ホットフィックス"),
			"refactoring":      term("refactoring", "リファクタリング"),
			"debugging":        term("debugging", "デバッグ"),
			"code review":      term("code review", "コードレビュー"),
			"pair programming": term("pair programming", "ペアプログラミング"),
			"CI/CD":            term("CI/CD", "CI/CD"),
			"pipeline":         term("pipeline", "パイプライン"),
			"workflow":         term("workflow", "ワークフロー"),
			"build":            term("build", "ビルド"),
			"test":             term("test", "テスト"),
			"coverage":         term("coverage", "カバレッジ"),
			"linter":           term("linter", "リンター"),
			"formatter":        term("formatter", "フォーマッター"),

			// アーキテクチャ
			"microservice":   term("microservice", "マイクロサービス"),
			"monolith":       term("monolith", "モノリス"),
			"container":      term("container", "コンテナ"),
			"orchestration":  term("orchestration", "オーケストレーション"),
			"load balancer":  term("load balancer", "ロードバランサー"),
			"API gateway":    term("API gateway", "APIゲートウェイ"),
			"middleware":     term("middleware", "ミドルウェア"),
			"cache":          term("cache", "キャッシュ"),
			"queue":          term("queue", "キュー"),
			"pub/sub":        term("pub/sub", "Pub/Sub"),
			"event-driven":   term("event-driven", "イベント駆動"),
			"serverless":     term("serverless", "サーバーレス"),
			"infrastructure": term("infrastructure", "インフラ"),
			"scalability":    term("scalability", "スケーラビリティ"),
			"latency":        term("latency", "レイテンシ"),
			"throughput":     term("throughput", "スループット"),

			// クラウド / DevOps
			"instance":   term("instance", "インスタンス"),
			"cluster":    term("cluster", "クラスター"),
			"namespace":  term("namespace", "ネームスペース"),
			"ingress":    term("ingress", "イングレス"),
			"secret":     term("secret", "シークレット"),
			"config map": term("config map", "コンフィグマップ"),
			"helm chart": term("helm chart", "Helmチャート"),

			// データ
			"schema":      term("schema", "スキーマ"),
			"migration":   term("migration", "マイグレーション"),
			"index":       term("index", "インデックス"),
			"transaction": term("transaction", "トランザクション"),
			"query":       term("query", "クエリ"),
			"endpoint":    term("endpoint", "エンドポイント"),
			"payload":     term("payload", "ペイロード"),
			"webhook":     term("webhook", "Webhook"),

			// AI / ML
			"machine learning":     term("machine learning", "機械学習"),
			"deep learning":        term("deep learning", "ディープラーニング"),
			"neural network":       term("neural network", "ニューラルネットワーク"),
			"large language model": term("large language model", "大規模言語モデル"),
			"fine-tuning":          term("fine-tuning", "ファインチューニング"),
			"inference":            term("inference", "推論"),
			"embedding":            term("embedding", "埋め込み"),
			"prompt":               term("prompt", "プロンプト"),
			"token":                term("token", "トークン"),
			"context window":       term("context window", "コンテキストウィンドウ"),
			"hallucination":        term("hallucination", "ハルシネーション"),
			"RAG":                  term("RAG", "RAG（検索拡張生成）"),
			"vector database":      term("vector database", "ベクトルデータベース"),
			"quantization":         term("quantization", "量子化"),
			"benchmark":            term("benchmark", "ベンチマーク"),
			"dataset":              term("dataset", "データセット"),
			"training":             term("training", "学習"),
			"evaluation":           term("evaluation", "評価"),

			// アジャイル / スクラム
			"sprint":        term("sprint", "スプリント"),
			"backlog":       term("backlog", "バックログ"),
			"retrospective": term("retrospective", "振り返り"),
			"scrum":         term("scrum", "スクラム"),
			"standup":       term("standup", "朝会"),
			"ticket":        term("ticket", "チケット"),
			"story point":   term("story point", "ストーリーポイント"),
			"velocity":      term("velocity", "ベロシティ"),
			"epic":          term("epic", "エピック"),

			// セキュリティ
			"authentication":      term("authentication", "認証"),
			"authorization":       term("authorization", "認可"),
			"encryption":          term("encryption", "暗号化"),
			"vulnerability":       term("vulnerability", "脆弱性"),
			"penetration testing": term("penetration testing", "ペネトレーションテスト"),
		},
	}
}

// recompileLocked は corrections から正規表現リストを再構築する。
// 呼び出し元が g.mu を書き込みロック中、またはロック不要な初期化時のみ呼ぶこと。
func (g *Glossary) recompileLocked() {
	// 長いパターンを先にマッチさせるためソート (部分一致の衝突を防ぐ)
	srcs := make([]string, 0, len(g.data.Corrections))
	for src := range g.data.Corrections {
		srcs = append(srcs, src)
	}
	sort.Slice(srcs, func(i, j int) bool { return len(srcs[i]) > len(srcs[j]) })

	g.compiled = g.compiled[:0]
	for _, src := range srcs {
		entry := g.data.Corrections[src]
		// 単語境界 + 大文字小文字無視でマッチ
		pattern := `(?i)\b` + regexp.QuoteMeta(src) + `\b`
		re, err := regexp.Compile(pattern)
		if err != nil {
			log.Printf("[glossary] invalid correction pattern %q: %v", src, err)
			continue
		}
		g.compiled = append(g.compiled, compiledCorrection{re: re, target: entry.Target})
	}
}

// save は現在の辞書データをファイルに書き出す。
func (g *Glossary) save() error {
	g.mu.RLock()
	data, err := json.MarshalIndent(g.data, "", "  ")
	g.mu.RUnlock()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(g.filePath), 0755); err != nil {
		return err
	}
	return os.WriteFile(g.filePath, data, 0644)
}

// ---------------------------------------------------------------------------
// Apply functions  (読み取り専用 – 同時呼び出し可)
// ---------------------------------------------------------------------------

// ApplyCorrections は transcription テキストに corrections を適用して返す。
// 単語境界マッチ・大文字小文字を無視。長いパターンが先に適用される。
func (g *Glossary) ApplyCorrections(text string) string {
	g.mu.RLock()
	compiled := make([]compiledCorrection, len(g.compiled))
	copy(compiled, g.compiled)
	g.mu.RUnlock()

	for _, c := range compiled {
		text = c.re.ReplaceAllString(text, c.target)
	}
	return text
}

// WhisperHints は whisper の initial_prompt に注入するヒント文字列を返す。
// corrections の source と terms の source をカンマ区切りで列挙する。
// whisper はこの文字列中の語彙を優先的に認識しやすくなる。
func (g *Glossary) WhisperHints() string {
	g.mu.RLock()
	defer g.mu.RUnlock()
	seen := make(map[string]struct{})
	var terms []string
	for src := range g.data.Corrections {
		if _, ok := seen[src]; !ok {
			terms = append(terms, src)
			seen[src] = struct{}{}
		}
	}
	for src := range g.data.Terms {
		if _, ok := seen[src]; !ok {
			terms = append(terms, src)
			seen[src] = struct{}{}
		}
	}
	if len(terms) == 0 {
		return ""
	}
	sort.Strings(terms)
	return strings.Join(terms, ", ")
}

// TermsForPrompt は LLM プロンプトに注入する用語マッピング文字列を返す。
// 例: "code review -> コードレビュー; pull request -> プルリクエスト"
func (g *Glossary) TermsForPrompt() string {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if len(g.data.Terms) == 0 {
		return ""
	}
	parts := make([]string, 0, len(g.data.Terms))
	for src, entry := range g.data.Terms {
		parts = append(parts, src+" -> "+entry.Target)
	}
	sort.Strings(parts) // 決定論的な順序
	return strings.Join(parts, "; ")
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

// GetData はスレッドセーフに全データのコピーを返す。
func (g *Glossary) GetData() GlossaryData {
	g.mu.RLock()
	defer g.mu.RUnlock()
	corr := make(map[string]GlossaryEntry, len(g.data.Corrections))
	maps.Copy(corr, g.data.Corrections)
	terms := make(map[string]GlossaryEntry, len(g.data.Terms))
	maps.Copy(terms, g.data.Terms)
	return GlossaryData{Corrections: corr, Terms: terms}
}

// UpsertCorrection は correction エントリを追加/更新して永続化する。
func (g *Glossary) UpsertCorrection(source, target, description string) error {
	g.mu.Lock()
	g.data.Corrections[source] = GlossaryEntry{Source: source, Target: target, Description: description}
	g.recompileLocked()
	g.mu.Unlock()
	logV("glossary: upsert correction %q -> %q", source, target)
	return g.save()
}

// UpsertTerm は term エントリを追加/更新して永続化する。
func (g *Glossary) UpsertTerm(source, target, description string) error {
	g.mu.Lock()
	g.data.Terms[source] = GlossaryEntry{Source: source, Target: target, Description: description}
	g.mu.Unlock()
	logV("glossary: upsert term %q -> %q", source, target)
	return g.save()
}

// DeleteCorrection は correction エントリを削除して永続化する。
func (g *Glossary) DeleteCorrection(source string) error {
	g.mu.Lock()
	delete(g.data.Corrections, source)
	g.recompileLocked()
	g.mu.Unlock()
	return g.save()
}

// DeleteTerm は term エントリを削除して永続化する。
func (g *Glossary) DeleteTerm(source string) error {
	g.mu.Lock()
	delete(g.data.Terms, source)
	g.mu.Unlock()
	return g.save()
}

// Learn は transcription / translation の誤りから自動学習する。
// kind: "correction" (ASR 修正) または "term" (翻訳用語)
func (g *Glossary) Learn(kind, source, target string) error {
	switch kind {
	case "correction":
		return g.UpsertCorrection(source, target, "auto-learned")
	case "term":
		return g.UpsertTerm(source, target, "auto-learned")
	default:
		return fmt.Errorf("unknown kind: %q (use 'correction' or 'term')", kind)
	}
}

// ---------------------------------------------------------------------------
// Hot-reload
// ---------------------------------------------------------------------------

// Reload は glossary.json をファイルから再読み込みする。
func (g *Glossary) Reload() {
	data, err := os.ReadFile(g.filePath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[glossary] reload failed: %v", err)
		}
		return
	}
	var newData GlossaryData
	if err := json.Unmarshal(data, &newData); err != nil {
		log.Printf("[glossary] reload parse error: %v", err)
		return
	}
	if newData.Corrections == nil {
		newData.Corrections = make(map[string]GlossaryEntry)
	}
	if newData.Terms == nil {
		newData.Terms = make(map[string]GlossaryEntry)
	}
	g.mu.Lock()
	g.data = newData
	g.recompileLocked()
	g.mu.Unlock()
	log.Printf("[glossary] reloaded: %d corrections, %d terms", len(newData.Corrections), len(newData.Terms))
}

// StartWatcher は glossary.json のファイル変更を監視し、変更があれば自動リロードする。
// ctx がキャンセルされると停止する。
func (g *Glossary) StartWatcher(ctx context.Context, interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		var lastMod time.Time
		// 初回 mtime を記録
		if info, err := os.Stat(g.filePath); err == nil {
			lastMod = info.ModTime()
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				info, err := os.Stat(g.filePath)
				if err != nil || !info.ModTime().After(lastMod) {
					continue
				}
				lastMod = info.ModTime()
				g.Reload()
			}
		}
	}()
}

type glossaryUpsertReq struct {
	Source      string `json:"source"`
	Target      string `json:"target"`
	Description string `json:"description"`
}

type glossaryLearnReq struct {
	Kind   string `json:"kind"`   // "correction" or "term"
	Source string `json:"source"` // 誤認識/誤訳テキスト
	Target string `json:"target"` // 正しいテキスト
}

// handleGlossaryGet は GET /glossary ハンドラ。全エントリを返す。
func (s *server) handleGlossaryGet(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.glossary.GetData())
}

// handleGlossaryUpsertCorrection は POST /glossary/corrections ハンドラ。
func (s *server) handleGlossaryUpsertCorrection(w http.ResponseWriter, r *http.Request) {
	var req glossaryUpsertReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Source == "" || req.Target == "" {
		http.Error(w, "source and target are required", http.StatusBadRequest)
		return
	}
	if err := s.glossary.UpsertCorrection(req.Source, req.Target, req.Description); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleGlossaryDeleteCorrection は DELETE /glossary/corrections/{source} ハンドラ。
func (s *server) handleGlossaryDeleteCorrection(w http.ResponseWriter, r *http.Request) {
	source := r.PathValue("source")
	if source == "" {
		http.Error(w, "source is required", http.StatusBadRequest)
		return
	}
	if err := s.glossary.DeleteCorrection(source); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleGlossaryUpsertTerm は POST /glossary/terms ハンドラ。
func (s *server) handleGlossaryUpsertTerm(w http.ResponseWriter, r *http.Request) {
	var req glossaryUpsertReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Source == "" || req.Target == "" {
		http.Error(w, "source and target are required", http.StatusBadRequest)
		return
	}
	if err := s.glossary.UpsertTerm(req.Source, req.Target, req.Description); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleGlossaryDeleteTerm は DELETE /glossary/terms/{source} ハンドラ。
func (s *server) handleGlossaryDeleteTerm(w http.ResponseWriter, r *http.Request) {
	source := r.PathValue("source")
	if source == "" {
		http.Error(w, "source is required", http.StatusBadRequest)
		return
	}
	if err := s.glossary.DeleteTerm(source); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleGlossaryLearn は POST /glossary/learn ハンドラ。
// extension から誤訳訂正フィードバックを受け取って辞書に学習する。
func (s *server) handleGlossaryLearn(w http.ResponseWriter, r *http.Request) {
	var req glossaryLearnReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Source == "" || req.Target == "" {
		http.Error(w, "kind, source and target are required", http.StatusBadRequest)
		return
	}
	if err := s.glossary.Learn(req.Kind, req.Source, req.Target); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	log.Printf("[glossary] learned: kind=%s %q -> %q", req.Kind, req.Source, req.Target)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
