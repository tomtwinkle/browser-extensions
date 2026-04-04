// main.go – meet-translator ローカルサーバー
//
// 外部依存なし。whisper.cpp + llama.cpp を CGo で直接組み込んだシングルバイナリ。
//
// 設定 (環境変数):
//   PORT              リスンポート                    (デフォルト: 7070)
//   WHISPER_MODEL     whisper モデル名またはパス       (例: base, /path/to/ggml-base.bin)
//   LLAMA_MODEL       llama モデル名またはパス         (例: qwen3:8b-q4_k_m, /path/to/model.gguf)
//   LLAMA_GPU_LAYERS  GPU にオフロードするレイヤ数     (デフォルト: -1 = 全レイヤ)
//   WHISPER_GPU_LAYERS 同上 whisper 用               (デフォルト: -1)
//   MODEL_CACHE_DIR   モデルキャッシュディレクトリ     (デフォルト: OS 標準)
//
// モデル名を指定した場合は自動ダウンロードし、Ollama のキャッシュも共有する。

package main

/*
#include "llama_bridge.h"
#include "whisper_bridge.h"
*/
import "C"

import (
"context"
"encoding/json"
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
return config{
port:             env("PORT", "7070"),
whisperModel:     os.Getenv("WHISPER_MODEL"),
llamaModel:       os.Getenv("LLAMA_MODEL"),
llamaGPULayers:   envInt("LLAMA_GPU_LAYERS", -1),
whisperGPULayers: envInt("WHISPER_GPU_LAYERS", -1),
}
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
