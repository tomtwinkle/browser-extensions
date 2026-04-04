// main.go – meet-translator ローカルサーバー
//
// 外部依存なし。whisper.cpp + llama.cpp を CGo で直接組み込んだシングルバイナリ。
//
// 設定の優先度 (高→低):
//   CLI フラグ > config ファイル > 環境変数 > デフォルト値
//
// CLI フラグ:
//   --port              リスンポート                    (デフォルト: 7070)
//   --whisper-model     whisper モデル名またはパス       (例: base)
//   --llama-model       llama モデル名またはパス         (例: qwen3:8b-q4_k_m)
//   --llama-gpu-layers  GPU にオフロードするレイヤ数     (デフォルト: -1 = 全レイヤ)
//   --whisper-gpu-layers 同上 whisper 用
//   --model-cache-dir   モデルキャッシュディレクトリ
//   --config            config ファイルパスの上書き
//
// フラグを明示指定すると config ファイルに保存され、次回以降は省略可能。
// config ファイルの場所: server_config.go の configFilePath() を参照。

package main

/*
#cgo CFLAGS:   -I./vendor/llama.cpp/include -I./vendor/whisper.cpp/include -I./vendor/llama.cpp/ggml/include
#cgo CXXFLAGS: -I./vendor/llama.cpp/include -I./vendor/whisper.cpp/include -I./vendor/llama.cpp/ggml/include
#include "llama_bridge.h"
#include "whisper_bridge.h"
*/
import "C"

import (
"context"
"encoding/json"
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
"syscall"
"time"
)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type config struct {
port              string
whisperModel      string
llamaModel        string
llamaGPULayers    int
whisperGPULayers  int
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

// ── Step 1: デフォルト値 ────────────────────────────────────────────────────
cfg := config{
port:             "7070",
llamaGPULayers:   -1,
whisperGPULayers: -1,
}

// ── Step 2: 環境変数で上書き (後方互換) ────────────────────────────────────
cfg.port             = env("PORT", cfg.port)
cfg.whisperModel     = os.Getenv("WHISPER_MODEL")
cfg.llamaModel       = os.Getenv("LLAMA_MODEL")
cfg.llamaGPULayers   = envInt("LLAMA_GPU_LAYERS", cfg.llamaGPULayers)
cfg.whisperGPULayers = envInt("WHISPER_GPU_LAYERS", cfg.whisperGPULayers)

// ── Step 3: config ファイルで上書き ────────────────────────────────────────
fileCfg, err := loadConfigFile()
if err != nil {
log.Printf("[config] ファイル読み込みエラー (無視): %v", err)
} else {
if fileCfg.Port != ""         { cfg.port = fileCfg.Port }
if fileCfg.WhisperModel != "" { cfg.whisperModel = fileCfg.WhisperModel }
if fileCfg.LlamaModel != ""   { cfg.llamaModel = fileCfg.LlamaModel }
if fileCfg.LlamaGPULayers != nil   { cfg.llamaGPULayers = *fileCfg.LlamaGPULayers }
if fileCfg.WhisperGPULayers != nil { cfg.whisperGPULayers = *fileCfg.WhisperGPULayers }
if fileCfg.ModelCacheDir != "" {
os.Setenv("MODEL_CACHE_DIR", fileCfg.ModelCacheDir)
}
}

// ── Step 4: CLI フラグで上書き (最高優先度) ───────────────────────────────
fPort            := flag.String("port",               "", "リスンポート (デフォルト: 7070)")
fWhisperModel    := flag.String("whisper-model",      "", "whisper モデル名またはパス (例: base, small)")
fLlamaModel      := flag.String("llama-model",        "", "llama モデル名またはパス (例: qwen3:8b-q4_k_m)")
fLlamaGPU        := flag.Int("llama-gpu-layers",    -999, "llama GPU レイヤ数 (-1=全レイヤ, 0=CPU)")
fWhisperGPU      := flag.Int("whisper-gpu-layers",  -999, "whisper GPU レイヤ数")
fModelCacheDir   := flag.String("model-cache-dir",    "", "モデルキャッシュディレクトリ")
_                 = flag.String("config",             "", "config ファイルパス (MEET_TRANSLATOR_CONFIG と同等)")

flag.Usage = func() {
fmt.Fprintf(os.Stderr, "使い方: meet-translator-server [オプション]\n\n")
fmt.Fprintf(os.Stderr, "設定は config ファイルに保存され、次回以降は省略可能です。\n")
fmt.Fprintf(os.Stderr, "config ファイル: %s\n\n", configFilePath())
fmt.Fprintf(os.Stderr, "オプション:\n")
flag.PrintDefaults()
}
flag.Parse()

// 明示指定されたフラグを収集
explicitFlags := map[string]bool{}
flag.Visit(func(f *flag.Flag) { explicitFlags[f.Name] = true })

if explicitFlags["port"]             { cfg.port = *fPort }
if explicitFlags["whisper-model"]    { cfg.whisperModel = *fWhisperModel }
if explicitFlags["llama-model"]      { cfg.llamaModel = *fLlamaModel }
if explicitFlags["llama-gpu-layers"] { cfg.llamaGPULayers = *fLlamaGPU }
if explicitFlags["whisper-gpu-layers"] { cfg.whisperGPULayers = *fWhisperGPU }
if explicitFlags["model-cache-dir"]  {
os.Setenv("MODEL_CACHE_DIR", *fModelCacheDir)
}
if explicitFlags["config"] {
os.Setenv("MEET_TRANSLATOR_CONFIG", flag.Lookup("config").Value.String())
}

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
log.Printf("[config] 保存エラー (無視): %v", err)
} else {
log.Printf("[config] 設定を保存しました: %s", configFilePath())
}
}

return cfg
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type server struct {
cfg        config
mux        *http.ServeMux
whisperCtx *C.whisper_context

// llama モデル管理 (modelMu で保護)
modelMu         sync.Mutex
llamaModel      C.llama_bridge_model
loadedModelSpec string // 現在ロード中のモデル名またはパス

// テスト時にモック実装を注入できる関数フィールド
transcribeFn func(audioData []byte, lang string) (string, error)
translateFn  func(text, srcLang, tgtLang string, opts ModelOptions) (string, error)
swapModelFn  func(spec string) error
}

func newServer(cfg config, whisperCtx *C.whisper_context, llamaModel C.llama_bridge_model, modelSpec string) *server {
s := &server{
cfg:             cfg,
mux:             http.NewServeMux(),
whisperCtx:      whisperCtx,
llamaModel:      llamaModel,
loadedModelSpec: modelSpec,
}
// デフォルトは CGo 実装を使用
s.transcribeFn = s.transcribeInternal
s.translateFn = s.translateInternal
s.swapModelFn = s.swapModel
s.mux.HandleFunc("GET /health", s.handleHealth)
s.mux.HandleFunc("POST /transcribe-and-translate", s.handleTranscribeAndTranslate)
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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
w.Header().Set("Content-Type", "application/json")
w.WriteHeader(status)
_ = json.NewEncoder(w).Encode(v)
}

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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

// モデルのホットスワップと翻訳は排他制御
s.modelMu.Lock()
defer s.modelMu.Unlock()

if requestedModel != "" && requestedModel != s.loadedModelSpec {
if err := s.swapModelFn(requestedModel); err != nil {
log.Printf("[model] ホットスワップ失敗: %v", err)
http.Error(w, "model swap failed: "+err.Error(), http.StatusInternalServerError)
return
}
}

opts := parseModelOptions(rawOpts, s.loadedModelSpec)

transcription, err := s.transcribeFn(audioData, sourceLang)
if err != nil {
log.Printf("[transcribe] %v", err)
http.Error(w, "transcription failed: "+err.Error(), http.StatusInternalServerError)
return
}
transcription = strings.TrimSpace(transcription)
if transcription == "" {
writeJSON(w, http.StatusOK, map[string]string{"transcription": "", "translation": ""})
return
}

translation, err := s.translateFn(transcription, sourceLang, targetLang, opts)
if err != nil {
log.Printf("[translate] %v", err)
http.Error(w, "translation failed: "+err.Error(), http.StatusInternalServerError)
return
}

writeJSON(w, http.StatusOK, map[string]string{
"transcription": transcription,
"translation":   strings.TrimSpace(translation),
})
}

// swapModel は現在ロード中のモデルを解放して新しいモデルをロードする。
// 呼び出し元は modelMu を保持している必要がある。
func (s *server) swapModel(spec string) error {
log.Printf("llama モデルをスワップ中: %s → %s", s.loadedModelSpec, spec)

path, err := resolveLlamaModel(spec)
if err != nil {
return err
}

newModel, err := loadLlamaModel(path, s.cfg.llamaGPULayers)
if err != nil {
return err
}

if s.llamaModel != nil {
C.llama_bridge_free_model(s.llamaModel)
}
s.llamaModel = newModel
s.loadedModelSpec = spec
log.Printf("llama モデルのスワップ完了: %s", spec)
return nil
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

func main() {
cfg := loadConfig()

// パラメーター未指定時はヘルプを表示して終了
if cfg.whisperModel == "" && cfg.llamaModel == "" {
printFullHelp()
fmt.Fprintln(os.Stderr)
fmt.Fprintf(os.Stderr, "%s起動例:%s\n", colorYellow, colorReset)
fmt.Fprintf(os.Stderr, "  meet-translator-server --whisper-model base --llama-model qwen3.5:4b-q4_k_m\n")
os.Exit(0)
}

// モデル名解決 (自動ダウンロード・Ollama キャッシュ共有)
originalModelSpec := cfg.llamaModel
runPreflight(&cfg)

// llama バックエンド初期化
initLlamaBackend()
defer freeLlamaBackend()

// whisper モデルをロード
log.Printf("whisper モデルをロード中: %s", cfg.whisperModel)
whisperCtx, err := loadWhisperModel(cfg.whisperModel)
if err != nil {
log.Fatalf("%v", err)
}
defer C.whisper_bridge_free(whisperCtx)
log.Printf("whisper モデルのロード完了")

// llama モデルをロード
log.Printf("llama モデルをロード中: %s (GPU layers=%d)", cfg.llamaModel, cfg.llamaGPULayers)
llamaModel, err := loadLlamaModel(cfg.llamaModel, cfg.llamaGPULayers)
if err != nil {
log.Fatalf("%v", err)
}
defer C.llama_bridge_free_model(llamaModel)
log.Printf("llama モデルのロード完了")

httpSrv := &http.Server{
Addr:    ":" + cfg.port,
Handler: newServer(cfg, whisperCtx, llamaModel, originalModelSpec),
}

quit := make(chan os.Signal, 1)
signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
go func() {
<-quit
log.Println("シャットダウン中...")
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
_ = httpSrv.Shutdown(ctx)
}()

log.Printf("meet-translator server listening on :%s", cfg.port)
if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
log.Fatal(err)
}
}
