// main.go – meet-translator ローカルサーバー
//
// 役割:
//   受信した WAV 音声を whisper.cpp (CGo) で文字起こしし、
//   Ollama で翻訳して JSON を返す。
//
// 外部依存: Ollama のみ（whisper.cpp は Go バイナリに組み込み済み）
//
// 設定は環境変数で行う:
//   PORT          リスンポート               (デフォルト: 7070)
//   WHISPER_MODEL whisper モデルファイルのパス  (必須)
//   OLLAMA_URL    Ollama サーバー URL         (デフォルト: http://localhost:11434)

package main

import (
"context"
"encoding/json"
"io"
"log"
"net/http"
"os"
"os/signal"
"strings"
"syscall"
"time"

"github.com/ggerganov/whisper.cpp/bindings/go/pkg/whisper"
)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type config struct {
port         string
whisperModel string
ollamaURL    string
}

func loadConfig() config {
env := func(key, def string) string {
if v := os.Getenv(key); v != "" {
return v
}
return def
}
return config{
port:         env("PORT", "7070"),
whisperModel: os.Getenv("WHISPER_MODEL"),
ollamaURL:    env("OLLAMA_URL", "http://localhost:11434"),
}
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type server struct {
cfg          config
mux          *http.ServeMux
whisperModel whisper.Model
}

func newServer(cfg config, model whisper.Model) *server {
s := &server{cfg: cfg, mux: http.NewServeMux(), whisperModel: model}
s.mux.HandleFunc("GET /health", s.handleHealth)
s.mux.HandleFunc("POST /transcribe-and-translate", s.handleTranscribeAndTranslate)
return s
}

// ServeHTTP は CORS ヘッダーを付与してから内部ルーターに委譲する。
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
writeJSON(w, http.StatusOK, map[string]string{
"status":     "ok",
"ollama_url": s.cfg.ollamaURL,
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

sourceLang  := r.FormValue("source_lang")
targetLang  := r.FormValue("target_lang")
ollamaModel := r.FormValue("ollama_model")
if targetLang == "" {
targetLang = "ja"
}
if ollamaModel == "" {
ollamaModel = "qwen2.5:7b"
}

transcription, err := s.transcribe(audioData, sourceLang)
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

translation, err := s.translate(transcription, sourceLang, targetLang, ollamaModel)
if err != nil {
log.Printf("[translate] %v", err)
http.Error(w, "translation failed: "+err.Error(), http.StatusBadGateway)
return
}

writeJSON(w, http.StatusOK, map[string]string{
"transcription": transcription,
"translation":   strings.TrimSpace(translation),
})
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

func main() {
cfg := loadConfig()

// 依存チェック
runPreflight(cfg)

// whisper モデルをロード（CGo 経由、起動時に一度だけ）
log.Printf("whisper モデルをロード中: %s", cfg.whisperModel)
model, err := whisper.New(cfg.whisperModel)
if err != nil {
log.Fatalf("whisper モデルのロードに失敗: %v", err)
}
defer model.Close()
log.Printf("whisper モデルのロード完了")

httpSrv := &http.Server{
Addr:    ":" + cfg.port,
Handler: newServer(cfg, model),
}

// Graceful shutdown
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
log.Printf("  Ollama : %s", cfg.ollamaURL)

if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
log.Fatal(err)
}
}
