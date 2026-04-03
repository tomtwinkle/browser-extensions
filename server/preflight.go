// preflight.go – 起動前の依存チェック
//
// サーバー起動前に必要なツールの存在を確認し、
// 未インストールの場合はインストール手順を表示して終了する。

package main

import (
	"fmt"
	"net/http"
	"os"
	"runtime"
	"time"
)

const (
	colorRed    = "\033[31m"
	colorYellow = "\033[33m"
	colorCyan   = "\033[36m"
	colorReset  = "\033[0m"
)

// runPreflight は起動前チェックをすべて実行する。
// 問題があれば案内を表示して os.Exit(1) する。
func runPreflight(cfg config) {
	ok := true
	ok = checkOllama(cfg.ollamaURL) && ok
	if cfg.whisperBin != "" {
		ok = checkWhisperBin(cfg.whisperBin) && ok
		ok = checkWhisperModel(cfg.whisperModel) && ok
	}
	if !ok {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintf(os.Stderr, "%s上記の問題を解決してから再度起動してください。%s\n", colorRed, colorReset)
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// Ollama チェック
// ---------------------------------------------------------------------------

func checkOllama(ollamaURL string) bool {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(ollamaURL + "/api/tags")
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return true
		}
	}

	fmt.Fprintf(os.Stderr, "\n%s[ERROR] Ollama が起動していません (%s)%s\n", colorRed, ollamaURL, colorReset)
	fmt.Fprintf(os.Stderr, "%sインストール手順:%s\n", colorYellow, colorReset)
	switch runtime.GOOS {
	case "windows":
		fmt.Fprintln(os.Stderr, "  winget install Ollama.Ollama")
		fmt.Fprintln(os.Stderr, "  または https://ollama.com/download/windows からダウンロード")
	case "darwin":
		fmt.Fprintln(os.Stderr, "  brew install ollama")
		fmt.Fprintln(os.Stderr, "  または https://ollama.com/download/mac からダウンロード")
	default:
		fmt.Fprintln(os.Stderr, "  curl -fsSL https://ollama.com/install.sh | sh")
	}
	fmt.Fprintf(os.Stderr, "\nインストール後:\n")
	fmt.Fprintln(os.Stderr, "  ollama serve")
	fmt.Fprintf(os.Stderr, "  ollama pull qwen2.5:7b  %s# 翻訳モデルを取得%s\n", colorCyan, colorReset)
	return false
}

// ---------------------------------------------------------------------------
// whisper.cpp バイナリ チェック
// ---------------------------------------------------------------------------

func checkWhisperBin(bin string) bool {
	if _, err := os.Stat(bin); err == nil {
		return true
	}

	fmt.Fprintf(os.Stderr, "\n%s[ERROR] whisper-server バイナリが見つかりません: %s%s\n", colorRed, bin, colorReset)
	fmt.Fprintf(os.Stderr, "%sビルド手順:%s\n", colorYellow, colorReset)
	switch runtime.GOOS {
	case "windows":
		fmt.Fprintln(os.Stderr, "  git clone https://github.com/ggerganov/whisper.cpp")
		fmt.Fprintln(os.Stderr, "  cd whisper.cpp")
		fmt.Fprintln(os.Stderr, "  cmake -B build && cmake --build build --config Release")
		fmt.Fprintf(os.Stderr, "  %s# バイナリ: build\\bin\\Release\\whisper-server.exe%s\n", colorCyan, colorReset)
	case "darwin":
		fmt.Fprintln(os.Stderr, "  git clone https://github.com/ggerganov/whisper.cpp")
		fmt.Fprintln(os.Stderr, "  cd whisper.cpp")
		fmt.Fprintln(os.Stderr, "  cmake -B build && cmake --build build -j")
		fmt.Fprintf(os.Stderr, "  %s# バイナリ: build/bin/whisper-server%s\n", colorCyan, colorReset)
	default:
		fmt.Fprintln(os.Stderr, "  git clone https://github.com/ggerganov/whisper.cpp")
		fmt.Fprintln(os.Stderr, "  cd whisper.cpp")
		fmt.Fprintln(os.Stderr, "  cmake -B build && cmake --build build -j")
		fmt.Fprintf(os.Stderr, "  %s# バイナリ: build/bin/whisper-server%s\n", colorCyan, colorReset)
	}
	fmt.Fprintf(os.Stderr, "\nビルド後に環境変数を設定してください:\n")
	fmt.Fprintf(os.Stderr, "  WHISPER_BIN=./whisper.cpp/build/bin/whisper-server\n")
	return false
}

// ---------------------------------------------------------------------------
// whisper.cpp モデルファイル チェック
// ---------------------------------------------------------------------------

func checkWhisperModel(model string) bool {
	if model == "" {
		fmt.Fprintf(os.Stderr, "\n%s[ERROR] WHISPER_MODEL が設定されていません%s\n", colorRed, colorReset)
		fmt.Fprintln(os.Stderr, "  モデルをダウンロードして WHISPER_MODEL に指定してください:")
		fmt.Fprintln(os.Stderr, "  cd whisper.cpp && bash models/download-ggml-model.sh base")
		fmt.Fprintf(os.Stderr, "  WHISPER_MODEL=./whisper.cpp/models/ggml-base.bin\n")
		return false
	}
	if _, err := os.Stat(model); err == nil {
		return true
	}

	fmt.Fprintf(os.Stderr, "\n%s[ERROR] whisper.cpp モデルファイルが見つかりません: %s%s\n", colorRed, model, colorReset)
	fmt.Fprintf(os.Stderr, "%sモデルのダウンロード手順:%s\n", colorYellow, colorReset)
	fmt.Fprintln(os.Stderr, "  cd whisper.cpp")
	fmt.Fprintln(os.Stderr, "  bash models/download-ggml-model.sh base")
	fmt.Fprintf(os.Stderr, "\n利用可能なモデル: tiny / base / small / medium / large-v3\n")
	fmt.Fprintf(os.Stderr, "  %s大きいほど精度が高く、小さいほど速い%s\n", colorCyan, colorReset)
	return false
}
