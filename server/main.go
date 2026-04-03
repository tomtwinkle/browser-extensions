// main.go – meet-translator ローカルサーバー
//
// 役割:
//   受信した WAV 音声を whisper.cpp HTTP サーバーで文字起こしし、
//   Ollama で翻訳して JSON を返す。
//
// 依存: 標準ライブラリのみ（外部パッケージなし）
//
// 設定は環境変数で行う:
//   PORT           リスンポート              (デフォルト: 7070)
//   OLLAMA_URL     Ollama サーバー           (デフォルト: http://localhost:11434)
//
//   --- whisper.cpp の起動方式を2つから選択 ---
//   [A] 自動起動（推奨）: WHISPER_BIN と WHISPER_MODEL を指定すると
//       Go サーバーが whisper.cpp を子プロセスとして管理する。
//       WHISPER_BIN    whisper-server バイナリのパス
//       WHISPER_MODEL  .bin モデルファイルのパス
//       WHISPER_PORT   whisper.cpp のポート (デフォルト: 8080)
//
//   [B] 手動起動: WHISPER_URL を指定すると既存の whisper.cpp に接続する。
//       WHISPER_URL    whisper.cpp サーバー URL (デフォルト: http://localhost:8080)

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type config struct {
	port        string
	whisperURL  string
	ollamaURL   string
	// 自動起動オプション
	whisperBin   string
	whisperModel string
	whisperPort  string
}

func loadConfig() config {
	env := func(key, def string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return def
	}
	whisperPort := env("WHISPER_PORT", "8080")
	return config{
		port:         env("PORT", "7070"),
		whisperURL:   env("WHISPER_URL", fmt.Sprintf("http://localhost:%s", whisperPort)),
		ollamaURL:    env("OLLAMA_URL", "http://localhost:11434"),
		whisperBin:   os.Getenv("WHISPER_BIN"),
		whisperModel: os.Getenv("WHISPER_MODEL"),
		whisperPort:  whisperPort,
	}
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type server struct {
	cfg config
	mux *http.ServeMux
}

func newServer(cfg config) *server {
	s := &server{cfg: cfg, mux: http.NewServeMux()}
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
		"status":      "ok",
		"whisper_url": s.cfg.whisperURL,
		"ollama_url":  s.cfg.ollamaURL,
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
		http.Error(w, "transcription failed: "+err.Error(), http.StatusBadGateway)
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

	// --- [A] whisper.cpp を子プロセスとして自動起動 ---
	if cfg.whisperBin != "" && cfg.whisperModel != "" {
		cmd, err := startWhisperProcess(cfg.whisperBin, cfg.whisperModel, cfg.whisperPort)
		if err != nil {
			log.Fatalf("[whisper] %v", err)
		}
		defer func() {
			log.Println("[whisper] 停止中...")
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}()
	} else {
		log.Printf("[whisper] 外部サーバーに接続: %s", cfg.whisperURL)
		log.Println("  (自動起動: WHISPER_BIN と WHISPER_MODEL を設定すると whisper.cpp を自動管理します)")
	}

	srv := &http.Server{
		Addr:    ":" + cfg.port,
		Handler: newServer(cfg),
	}

	// Graceful shutdown: SIGINT / SIGTERM を受けたら後片付けして終了
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-quit
		log.Println("シャットダウン中...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	log.Printf("meet-translator server listening on :%s", cfg.port)
	log.Printf("  Whisper : %s", cfg.whisperURL)
	log.Printf("  Ollama  : %s", cfg.ollamaURL)

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
