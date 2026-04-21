// main.go – meet-translator ローカルサーバー
//
// 外部依存なし。whisper.cpp + llama.cpp を CGo で直接組み込んだシングルバイナリ。
//
// 設定の優先度 (高→低):
//   CLI フラグ > config ファイル > 環境変数 > デフォルト値
//
// CLI フラグ:
//   --port              リスンポート                    (デフォルト: 7070)
//   --whisper-model     whisper モデル名またはパス       (既定 floor: large-v3-turbo)
//   --llama-model       llama モデル名またはパス         (既定 floor: qwen3.5:0.8b-q4_k_m)
//   --llama-gpu-layers  GPU にオフロードするレイヤ数     (デフォルト: -1 = 全レイヤ)
//   --whisper-gpu-layers 同上 whisper 用
//   --model-cache-dir   model cache directory
//   --config            config ファイルパスの上書き
//
// フラグを明示指定すると config ファイルに保存され、次回以降は省略可能。
// config ファイルの場所: server_config.go の configFilePath() を参照。

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type config struct {
	port             string
	whisperModel     string
	llamaModel       string
	llamaGPULayers   int
	whisperGPULayers int
	verbose          bool
	autoSelectModels bool
}

func loadConfig() config {
	env := func(key, def string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return def
	}
	envInt := func(key string, def int) int {
		if v := os.Getenv(key); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				return n
			}
		}
		return def
	}

	// ── Step 1: デフォルト値 (初回 floor) ──────────────────────────────────────
	cfg := config{
		port:             "7070",
		whisperModel:     firstRunWhisperModel,
		llamaModel:       firstRunLlamaModel,
		llamaGPULayers:   -1,
		whisperGPULayers: -1,
	}
	hadConfigFile := configFileExists()
	modelOverrides := false

	// ── Step 2: 環境変数で上書き (後方互換) ────────────────────────────────────
	cfg.port = env("PORT", cfg.port)
	if v := os.Getenv("WHISPER_MODEL"); v != "" {
		cfg.whisperModel = v
		modelOverrides = true
	}
	if v := os.Getenv("LLAMA_MODEL"); v != "" {
		cfg.llamaModel = v
		modelOverrides = true
	}
	cfg.llamaGPULayers = envInt("LLAMA_GPU_LAYERS", cfg.llamaGPULayers)
	cfg.whisperGPULayers = envInt("WHISPER_GPU_LAYERS", cfg.whisperGPULayers)
	// verbose は CLI フラグ (--verbose) でのみ有効化する

	// ── Step 3: config ファイルで上書き ────────────────────────────────────────
	fileCfg, err := loadConfigFile()
	if err != nil {
		log.Printf("[config] failed to load config file (ignoring): %v", err)
	} else {
		if fileCfg.Port != "" {
			cfg.port = fileCfg.Port
		}
		if fileCfg.WhisperModel != "" {
			cfg.whisperModel = fileCfg.WhisperModel
			modelOverrides = true
		}
		if fileCfg.LlamaModel != "" {
			cfg.llamaModel = fileCfg.LlamaModel
			modelOverrides = true
		}
		if fileCfg.LlamaGPULayers != nil {
			cfg.llamaGPULayers = *fileCfg.LlamaGPULayers
		}
		if fileCfg.WhisperGPULayers != nil {
			cfg.whisperGPULayers = *fileCfg.WhisperGPULayers
		}
		if fileCfg.ModelCacheDir != "" {
			os.Setenv("MODEL_CACHE_DIR", fileCfg.ModelCacheDir)
		}
	}

	// ── Step 4: CLI フラグで上書き (最高優先度) ───────────────────────────────
	fPort := flag.String("port", "", "listen port (default: 7070)")
	fWhisperModel := flag.String("whisper-model", firstRunWhisperModel, "whisper model name or path (first-run floor; may auto-upgrade when omitted)")
	fLlamaModel := flag.String("llama-model", firstRunLlamaModel, "llama model name or path (first-run floor; may auto-upgrade when omitted)")
	fLlamaGPU := flag.Int("llama-gpu-layers", -999, "llama GPU layers (-1=all, 0=CPU only)")
	fWhisperGPU := flag.Int("whisper-gpu-layers", -999, "whisper GPU layers")
	fModelCacheDir := flag.String("model-cache-dir", "", "model cache directory")
	fVerbose := flag.Bool("verbose", false, "enable verbose request/response logging")
	_ = flag.String("config", "", "config file path (overrides MEET_TRANSLATOR_CONFIG)")

	flag.Usage = func() {
		w := flag.CommandLine.Output()
		fmt.Fprintf(w, "Usage: meet-translator-server [options]\n\n")
		fmt.Fprintf(w, "Settings are saved to config file and can be omitted on next run.\n")
		fmt.Fprintf(w, "First-run floor: whisper=%s  llama=%s\n", firstRunWhisperModel, firstRunLlamaModel)
		fmt.Fprintf(w, "When RAM/GPU allow, first launch can step up to bonsai-8b and larger models.\n")
		fmt.Fprintf(w, "Config file: %s\n\n", configFilePath())
		fmt.Fprintf(w, "Options:\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	// 明示指定されたフラグを収集
	explicitFlags := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { explicitFlags[f.Name] = true })

	if explicitFlags["port"] {
		cfg.port = *fPort
	}
	if explicitFlags["whisper-model"] {
		cfg.whisperModel = *fWhisperModel
		modelOverrides = true
	}
	if explicitFlags["llama-model"] {
		cfg.llamaModel = *fLlamaModel
		modelOverrides = true
	}
	if explicitFlags["llama-gpu-layers"] {
		cfg.llamaGPULayers = *fLlamaGPU
	}
	if explicitFlags["whisper-gpu-layers"] {
		cfg.whisperGPULayers = *fWhisperGPU
	}
	if explicitFlags["verbose"] {
		cfg.verbose = *fVerbose
	}
	if explicitFlags["model-cache-dir"] {
		os.Setenv("MODEL_CACHE_DIR", *fModelCacheDir)
	}
	if explicitFlags["config"] {
		os.Setenv("MEET_TRANSLATOR_CONFIG", flag.Lookup("config").Value.String())
	}
	cfg.autoSelectModels = !hadConfigFile && !modelOverrides

	// ── Step 5: フラグが明示指定されていれば config ファイルに保存 ──────────────
	if len(explicitFlags) > 0 {
		save := persistedConfig{
			Port:          cfg.port,
			WhisperModel:  cfg.whisperModel,
			LlamaModel:    cfg.llamaModel,
			ModelCacheDir: os.Getenv("MODEL_CACHE_DIR"),
		}
		n := cfg.llamaGPULayers
		save.LlamaGPULayers = &n
		w := cfg.whisperGPULayers
		save.WhisperGPULayers = &w

		if err := saveConfigFile(save); err != nil {
			log.Printf("[config] failed to save config (ignoring): %v", err)
		} else {
			log.Printf("[config] settings saved: %s", configFilePath())
		}
	}

	return cfg
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type server struct {
	cfg         config
	mux         *http.ServeMux
	transcriber transcriber

	// 起動時に指定されたオリジナルのモデルスペック（パス解決前）
	whisperModelSpec string

	// 音声認識バックエンド保護 (whisper.cpp / Python worker ともに直列化)
	whisperMu sync.Mutex

	// llama モデル管理 (modelMu で保護)
	modelMu         sync.Mutex
	llmBackend      llmBackend
	loadedModelSpec string // 現在ロード中のモデル名またはパス
	llamaOps        sync.WaitGroup
	shuttingDown    atomic.Bool

	// 直近の発話履歴 (LLM few-shot context に使用)
	// ※ Whisper initial_prompt には使用しない（hallucination による翻訳連鎖防止）
	contextBuf *contextBuffer

	// 辞書 (goroutine セーフ)
	glossary *Glossary

	// バックグラウンド辞書改善ワーカー
	improver *GlossaryImprover

	// テスト時にモック実装を注入できる関数フィールド
	transcribeFn  func(audioData []byte, lang string) (string, string, error)
	translateFn   func(text, srcLang, tgtLang string, opts ModelOptions, history []contextEntry) (string, error)
	swapModelFn   func(spec string) error
	rawGenerateFn func(prompt string) (string, error)
}

func newServer(cfg config, transcriber transcriber, llm llmBackend, whisperSpec, llamaSpec string, glossary *Glossary) *server {
	s := &server{
		cfg:              cfg,
		mux:              http.NewServeMux(),
		transcriber:      transcriber,
		whisperModelSpec: whisperSpec,
		llmBackend:       llm,
		loadedModelSpec:  llamaSpec,
		contextBuf:       newContextBuffer(3),
		glossary:         glossary,
	}
	// デフォルトは CGo 実装を使用
	s.transcribeFn = s.transcribeInternal
	s.translateFn = s.translateInternal
	s.swapModelFn = s.swapModel
	s.rawGenerateFn = s.generateRaw
	// バックグラウンド辞書改善ワーカーを構築
	s.improver = newGlossaryImprover(
		glossary,
		s.rawGenerateFn,
		func() string {
			s.modelMu.Lock()
			spec := s.loadedModelSpec
			s.modelMu.Unlock()
			return templateFor(spec)
		},
	)
	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.HandleFunc("POST /transcribe-and-translate", s.handleTranscribeAndTranslate)
	s.mux.HandleFunc("POST /transcribe", s.handleTranscribe)
	s.mux.HandleFunc("POST /translate", s.handleTranslate)
	// 辞書 CRUD
	s.mux.HandleFunc("GET /glossary", s.handleGlossaryGet)
	s.mux.HandleFunc("POST /glossary/corrections", s.handleGlossaryUpsertCorrection)
	s.mux.HandleFunc("DELETE /glossary/corrections/{source}", s.handleGlossaryDeleteCorrection)
	s.mux.HandleFunc("POST /glossary/terms", s.handleGlossaryUpsertTerm)
	s.mux.HandleFunc("DELETE /glossary/terms/{source}", s.handleGlossaryDeleteTerm)
	s.mux.HandleFunc("POST /glossary/learn", s.handleGlossaryLearn)
	return s
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.mux.ServeHTTP(w, r)
}

// verboseEnabled はパッケージレベルの verbose フラグ。
// main() で cfg.verbose が確定した後にセットされ、model_manager.go 等からも参照される。
// atomic.Bool を使うことでスタートアップ後の並行読み取りを安全にする。
var verboseEnabled atomic.Bool

// logV はパッケージレベルの verbose ロガー。server 構造体が生成される前でも使える。
func logV(format string, args ...any) {
	if verboseEnabled.Load() {
		log.Printf("[verbose] "+format, args...)
	}
}

// logVerbose は --verbose のときのみ出力するデバッグロガー（server メソッド版）。
func (s *server) logVerbose(format string, args ...any) {
	if s.cfg.verbose {
		log.Printf("[verbose] "+format, args...)
	}
}

var errServerShuttingDown = errors.New("server shutting down")

// startLlamaOp は llama モデルを使う処理を直列化し、シャットダウン中の新規実行を拒否する。
// シャットダウン側は shuttingDown を立てたあとに modelMu でバリアを張ってから
// llamaOps.Wait() することで、モデル解放前に既存の CGo 呼び出し完了を待てる。
func (s *server) startLlamaOp() error {
	if s.shuttingDown.Load() {
		return errServerShuttingDown
	}
	s.modelMu.Lock()
	if s.shuttingDown.Load() {
		s.modelMu.Unlock()
		return errServerShuttingDown
	}
	s.llamaOps.Add(1)
	return nil
}

func (s *server) endLlamaOp() {
	s.llamaOps.Done()
	s.modelMu.Unlock()
}

func (s *server) beginShutdown() {
	s.shuttingDown.Store(true)
}

func (s *server) waitForLlamaIdle() {
	s.modelMu.Lock()
	s.modelMu.Unlock()
	s.llamaOps.Wait()
}

func (s *server) releaseLlamaModel() {
	s.beginShutdown()
	s.waitForLlamaIdle()

	s.modelMu.Lock()
	backend := s.llmBackend
	s.llmBackend = nil
	s.modelMu.Unlock()
	if backend != nil {
		if err := backend.Close(); err != nil {
			log.Printf("[llm] shutdown warning: %v", err)
		}
	}
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	s.modelMu.Lock()
	llamaModel := s.loadedModelSpec
	s.modelMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]string{
		"status":        "ok",
		"whisper_model": s.whisperModelSpec,
		"llama_model":   llamaModel,
	})
}

func (s *server) handleTranscribeAndTranslate(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, "failed to parse form: "+err.Error(), http.StatusBadRequest)
		return
	}
	f, _, err := r.FormFile("audio")
	if err != nil {
		http.Error(w, "missing audio field", http.StatusBadRequest)
		return
	}
	defer f.Close()

	audioData, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "failed to read audio", http.StatusInternalServerError)
		return
	}

	sourceLang := r.FormValue("source_lang")
	targetLang := r.FormValue("target_lang")
	if targetLang == "" {
		targetLang = "ja"
	}

	// リクエスト毎のモデル指定とオプションを取得
	requestedModel := strings.TrimSpace(r.FormValue("llama_model"))
	rawOpts := r.FormValue("llama_options")

	if s.cfg.verbose {
		hdrLen := 12
		if len(audioData) < hdrLen {
			hdrLen = len(audioData)
		}
		s.logVerbose("request: audio=%d bytes, header=[% x], target_lang=%q, source_lang=%q, llama_model=%q, llama_options=%q",
			len(audioData), audioData[:hdrLen], targetLang, sourceLang, requestedModel, rawOpts)
	}

	// ASR バックエンドは直列化して扱う。
	s.whisperMu.Lock()
	transcription, detectedLang, transcribeErr := s.transcribeFn(audioData, sourceLang)
	s.whisperMu.Unlock()

	if transcribeErr != nil {
		log.Printf("[transcribe] %v", transcribeErr)
		http.Error(w, "transcription failed: "+transcribeErr.Error(), http.StatusInternalServerError)
		return
	}
	transcription = strings.TrimSpace(transcription)
	if transcription == "" {
		writeJSON(w, http.StatusOK, map[string]string{"transcription": "", "translation": ""})
		return
	}
	if !isMeaningfulTranscription(transcription) {
		s.logVerbose("transcription filtered (noise): %q", transcription)
		writeJSON(w, http.StatusOK, map[string]string{"transcription": "", "translation": ""})
		return
	}
	// 直近発話の再生や文中ループを Whisper hallucination とみなして破棄する
	if isRepeatTranscription(transcription, s.contextBuf.Entries()) {
		s.logVerbose("transcription filtered (repeat/hallucination): %q", transcription)
		writeJSON(w, http.StatusOK, map[string]string{"transcription": "", "translation": ""})
		return
	}
	// 既知ハルシネーションフレーズ (YouTube 締め言葉等) を破棄する
	if isKnownHallucination(transcription) {
		s.logVerbose("transcription filtered (known hallucination): %q", transcription)
		writeJSON(w, http.StatusOK, map[string]string{"transcription": "", "translation": ""})
		return
	}
	s.logVerbose("transcription: %q", transcription)

	// LLM の few-shot context を modelMu 取得前に読む (ネストロック回避)
	history := s.contextBuf.Entries()

	// モデルのホットスワップと翻訳は排他制御 (llama のみ)。
	// シャットダウン開始後の新規 llama 処理は 503 で明示的に拒否する。
	if err := s.startLlamaOp(); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer s.endLlamaOp()
	if requestedModel != "" && requestedModel != s.loadedModelSpec {
		if err := s.swapModelFn(requestedModel); err != nil {
			log.Printf("[model] hot-swap failed: %v", err)
			http.Error(w, "model swap failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	opts := parseModelOptions(rawOpts, s.loadedModelSpec)
	translation, translateErr := s.translateFn(transcription, sourceLang, targetLang, opts, history)

	if translateErr != nil {
		log.Printf("[translate] %v", translateErr)
		http.Error(w, "translation failed: "+translateErr.Error(), http.StatusInternalServerError)
		return
	}
	translation = strings.TrimSpace(translation)
	s.logVerbose("translation: %q", translation)

	// バッファに追加 (全ロック解放後)
	s.contextBuf.Add(contextEntry{Transcription: transcription, Translation: translation})

	writeJSON(w, http.StatusOK, map[string]string{
		"transcription":     transcription,
		"translation":       translation,
		"detected_language": detectedLang,
	})
}

// handleTranscribe は音声データを受け取り、Whisper で文字起こしのみを行う。
// POST /transcribe  multipart/form-data: audio(WAV), source_lang(optional)
func (s *server) handleTranscribe(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, "failed to parse form: "+err.Error(), http.StatusBadRequest)
		return
	}
	f, _, err := r.FormFile("audio")
	if err != nil {
		http.Error(w, "missing audio field", http.StatusBadRequest)
		return
	}
	defer f.Close()

	audioData, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "failed to read audio", http.StatusInternalServerError)
		return
	}

	sourceLang := r.FormValue("source_lang")
	if s.cfg.verbose {
		hdrLen := 12
		if len(audioData) < hdrLen {
			hdrLen = len(audioData)
		}
		s.logVerbose("transcribe: audio=%d bytes, header=[% x], source_lang=%q",
			len(audioData), audioData[:hdrLen], sourceLang)
	}

	// contextBuf 読み取りはロック外で行う (contextBuf 自身に内部ロックあり)
	// Whisper は非スレッドセーフ – whisperMu で直列化
	s.whisperMu.Lock()
	transcription, detectedLang, err := s.transcribeFn(audioData, sourceLang)
	s.whisperMu.Unlock()
	if err != nil {
		log.Printf("[transcribe] %v", err)
		http.Error(w, "transcription failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	transcription = strings.TrimSpace(transcription)
	if !isMeaningfulTranscription(transcription) {
		s.logVerbose("transcription filtered (noise): %q", transcription)
		writeJSON(w, http.StatusOK, map[string]string{"transcription": ""})
		return
	}
	// 直近発話の再生や文中ループを Whisper hallucination とみなして破棄する
	if isRepeatTranscription(transcription, s.contextBuf.Entries()) {
		s.logVerbose("transcription filtered (repeat/hallucination): %q", transcription)
		writeJSON(w, http.StatusOK, map[string]string{"transcription": ""})
		return
	}
	// 既知ハルシネーションフレーズ (YouTube 締め言葉等) を破棄する
	if isKnownHallucination(transcription) {
		s.logVerbose("transcription filtered (known hallucination): %q", transcription)
		writeJSON(w, http.StatusOK, map[string]string{"transcription": ""})
		return
	}
	s.logVerbose("transcription: %q", transcription)

	writeJSON(w, http.StatusOK, map[string]string{
		"transcription":     transcription,
		"detected_language": detectedLang,
	})
}

// handleTranslate はテキストを受け取り、LLM で翻訳のみを行う。
// POST /translate  application/x-www-form-urlencoded:
//
//	text, target_lang, source_lang(optional), llama_model(optional), llama_options(optional)
func (s *server) handleTranslate(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "failed to parse form: "+err.Error(), http.StatusBadRequest)
		return
	}

	text := strings.TrimSpace(r.FormValue("text"))
	if text == "" {
		http.Error(w, "missing text field", http.StatusBadRequest)
		return
	}

	sourceLang := r.FormValue("source_lang")
	targetLang := r.FormValue("target_lang")
	if targetLang == "" {
		targetLang = "ja"
	}

	requestedModel := strings.TrimSpace(r.FormValue("llama_model"))
	rawOpts := r.FormValue("llama_options")

	s.logVerbose("translate: text=%q, target_lang=%q, llama_model=%q", text, targetLang, requestedModel)

	// LLM の few-shot context を modelMu 取得前に読む (ネストロック回避)
	history := s.contextBuf.Entries()

	// モデルのホットスワップと翻訳は排他制御。
	// シャットダウン開始後の新規 llama 処理は 503 で明示的に拒否する。
	if err := s.startLlamaOp(); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer s.endLlamaOp()
	if requestedModel != "" && requestedModel != s.loadedModelSpec {
		if err := s.swapModelFn(requestedModel); err != nil {
			log.Printf("[model] hot-swap failed: %v", err)
			http.Error(w, "model swap failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	opts := parseModelOptions(rawOpts, s.loadedModelSpec)
	translation, err := s.translateFn(text, sourceLang, targetLang, opts, history)

	if err != nil {
		log.Printf("[translate] %v", err)
		http.Error(w, "translation failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	translation = strings.TrimSpace(translation)
	s.logVerbose("translation: %q", translation)

	// バッファに追加 (全ロック解放後, text = 直前の /transcribe の出力)
	s.contextBuf.Add(contextEntry{Transcription: text, Translation: translation})

	writeJSON(w, http.StatusOK, map[string]string{"translation": translation})
}

// swapModel は現在ロード中のモデルを解放して新しいモデルをロードする。
// 呼び出し元は modelMu を保持している必要がある。
func (s *server) swapModel(spec string) error {
	log.Printf("[model] swapping llama model: %s -> %s", s.loadedModelSpec, spec)

	resolved, err := resolveLlamaModel(spec)
	if err != nil {
		return err
	}

	newBackend, err := newLLMBackend(resolved, s.cfg.llamaGPULayers)
	if err != nil {
		return err
	}

	if s.llmBackend != nil {
		if err := s.llmBackend.Close(); err != nil {
			log.Printf("[llm] swap warning: %v", err)
		}
	}
	s.llmBackend = newBackend
	s.loadedModelSpec = spec
	log.Printf("[model] llama model swapped: %s", spec)
	return nil
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

func main() {
	cfg := loadConfig()

	// 初回起動時 (config ファイルが存在しない) かつモデル未指定の場合、
	// マシンスペックからベストなモデルを自動選択して config を保存する。
	applyAutoConfig(&cfg)

	// モデルが現在のバイナリで対応可能か確認する。
	// 別バリアントが必要な場合は同ディレクトリの対応バイナリへ exec する。
	redirectIfNeeded(cfg.llamaModel)

	// パラメーター未指定時はヘルプを表示して終了
	if cfg.whisperModel == "" && cfg.llamaModel == "" {
		printFullHelp()
		os.Exit(0)
	}

	// モデル名解決 (自動ダウンロード・Ollama キャッシュ共有)
	originalWhisperSpec := cfg.whisperModel
	originalModelSpec := cfg.llamaModel
	resolvedWhisper, resolvedLlama := runPreflight(&cfg)

	// verbose フラグをパッケージレベル変数に反映（model_manager.go 等で使用）
	verboseEnabled.Store(cfg.verbose)

	// llama バックエンド初期化
	initLlamaBackend()
	defer freeLlamaBackend()

	// 音声認識バックエンドをロード
	logV("loading ASR backend: backend=%s spec=%s", resolvedWhisper.Backend, cfg.whisperModel)
	asrTranscriber, err := newTranscriber(resolvedWhisper)
	if err != nil {
		log.Fatalf("%v", err)
	}
	defer func() {
		if err := asrTranscriber.Close(); err != nil {
			log.Printf("[asr] shutdown warning: %v", err)
		}
	}()
	log.Printf("asr ready: %s (%s)", originalWhisperSpec, resolvedWhisper.Backend)

	// llama モデルをロード
	logV("loading llama model: backend=%s spec=%s resolved=%s GPU layers=%d", resolvedLlama.Backend, originalModelSpec, cfg.llamaModel, cfg.llamaGPULayers)
	llm, err := newLLMBackend(resolvedLlama, cfg.llamaGPULayers)
	if err != nil {
		log.Fatalf("%v", err)
	}
	log.Printf("llama ready: %s (%s)", originalModelSpec, resolvedLlama.Backend)

	// 辞書ロード
	glossary := loadGlossary()
	log.Printf("[glossary] loaded: %d corrections, %d terms  (path: %s)",
		len(glossary.GetData().Corrections), len(glossary.GetData().Terms), glossaryFilePath())

	srv := newServer(cfg, asrTranscriber, llm, originalWhisperSpec, originalModelSpec, glossary)

	// llamaModel の解放責任を server に委譲する。
	// シャットダウン開始後は新規 llama 処理を止め、進行中の CGo 呼び出しが終わってから
	// 現在のモデルポインタだけを解放する。
	defer srv.releaseLlamaModel()

	// サーバーのライフタイムと連動したコンテキスト
	srvCtx, srvCancel := context.WithCancel(context.Background())

	// 辞書ファイル変更を監視して自動リロード (30 秒ごと)
	glossary.StartWatcher(srvCtx, 30*time.Second)

	// バックグラウンド辞書改善ワーカーを起動
	srv.improver.Start(srvCtx)

	httpSrv := &http.Server{
		Addr:    ":" + cfg.port,
		Handler: srv,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	// done はシャットダウンシーケンス（HTTP drain → improver 完了）が
	// 終わったことを main goroutine に伝えるチャネル。
	// ListenAndServe() が戻った直後に <-done でブロックすることで、
	// バックグラウンドの CGo 呼び出しが完了する前に defer がモデルを解放する
	// race condition を防ぐ。
	done := make(chan struct{})
	go func() {
		<-quit
		log.Println("shutting down...")

		// 1. 進行中の HTTP リクエストをすべて完了させる
		shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutCancel()
		_ = httpSrv.Shutdown(shutCtx)

		// 2. バックグラウンドワーカー（辞書監視・improver）を停止
		srvCancel()

		// 3. バックグラウンド improver の終了を待つ。
		//    モデル解放前の llama CGo 呼び出し完了待ちは srv.releaseLlamaModel() が担う。
		srv.improver.Wait()

		close(done)
	}()

	log.Printf("meet-translator server listening on :%s", cfg.port)
	if cfg.verbose {
		log.Printf("[verbose] verbose logging enabled")
	}
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	// シャットダウンシーケンスが完全に終わるまで待ってから defer を実行する。
	// これにより improver の CGo 呼び出し完了前にモデルが解放される race を防ぐ。
	<-done
}
