// preflight.go – 起動前の依存チェック
//
// サーバー起動前に必要なものの存在を確認し、
// 未インストール・ファイル不在の場合は実際の環境を検出して
// 適切なインストール手順を表示して終了する。

package main

import (
"fmt"
"net/http"
"os"
"os/exec"
"runtime"
"time"
)

const (
colorRed    = "\033[31m"
colorYellow = "\033[33m"
colorCyan   = "\033[36m"
colorReset  = "\033[0m"
)

// hasCmd は PATH 上にコマンドが存在するかを返す。
func hasCmd(name string) bool {
_, err := exec.LookPath(name)
return err == nil
}

// runPreflight は起動前チェックをすべて実行する。
// 問題があれば案内を表示して os.Exit(1) する。
func runPreflight(cfg config) {
ok := true
ok = checkOllama(cfg.ollamaURL) && ok
ok = checkWhisperModel(cfg.whisperModel) && ok
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

ollamaInstalled := hasCmd("ollama")

if ollamaInstalled {
fmt.Fprintf(os.Stderr, "\n%s[ERROR] Ollama はインストールされていますが起動していません (%s)%s\n",
colorRed, ollamaURL, colorReset)
fmt.Fprintf(os.Stderr, "%s起動コマンド:%s\n", colorYellow, colorReset)
if runtime.GOOS == "windows" {
fmt.Fprintln(os.Stderr, "  スタートメニューから Ollama を起動してください")
fmt.Fprintln(os.Stderr, "  または: ollama serve")
} else {
fmt.Fprintln(os.Stderr, "  ollama serve")
}
} else {
fmt.Fprintf(os.Stderr, "\n%s[ERROR] Ollama がインストールされていません%s\n", colorRed, colorReset)
fmt.Fprintf(os.Stderr, "%sインストール手順:%s\n", colorYellow, colorReset)
switch runtime.GOOS {
case "windows":
if hasCmd("winget") {
fmt.Fprintln(os.Stderr, "  winget install Ollama.Ollama")
} else if hasCmd("choco") {
fmt.Fprintln(os.Stderr, "  choco install ollama")
} else {
fmt.Fprintln(os.Stderr, "  https://ollama.com/download/windows からダウンロード")
}
case "darwin":
if hasCmd("brew") {
fmt.Fprintln(os.Stderr, "  brew install ollama")
} else {
fmt.Fprintln(os.Stderr, "  https://ollama.com/download/mac からダウンロード")
fmt.Fprintln(os.Stderr, "  または: curl -fsSL https://ollama.com/install.sh | sh")
}
default:
fmt.Fprintln(os.Stderr, "  curl -fsSL https://ollama.com/install.sh | sh")
}
fmt.Fprintf(os.Stderr, "\nインストール後:\n")
fmt.Fprintln(os.Stderr, "  ollama serve")
}

fmt.Fprintf(os.Stderr, "  ollama pull qwen2.5:7b  %s# 翻訳モデルを取得%s\n", colorCyan, colorReset)
return false
}

// ---------------------------------------------------------------------------
// whisper モデルファイル チェック
// ---------------------------------------------------------------------------

func checkWhisperModel(model string) bool {
if model == "" {
fmt.Fprintf(os.Stderr, "\n%s[ERROR] WHISPER_MODEL が設定されていません%s\n", colorRed, colorReset)
fmt.Fprintln(os.Stderr, "  whisper.cpp の .bin モデルファイルのパスを指定してください:")
printModelDownloadHint()
return false
}
if _, err := os.Stat(model); err == nil {
return true
}

fmt.Fprintf(os.Stderr, "\n%s[ERROR] whisper モデルファイルが見つかりません: %s%s\n", colorRed, model, colorReset)
fmt.Fprintf(os.Stderr, "%sモデルのダウンロード手順:%s\n", colorYellow, colorReset)
printModelDownloadHint()
return false
}

func printModelDownloadHint() {
if runtime.GOOS == "windows" || !hasCmd("bash") {
fmt.Fprintln(os.Stderr, "  https://huggingface.co/ggerganov/whisper.cpp/tree/main からダウンロード")
fmt.Fprintln(os.Stderr, "  例: ggml-base.bin を任意のディレクトリに配置")
fmt.Fprintln(os.Stderr, "\n  set WHISPER_MODEL=C:\\path\\to\\ggml-base.bin")
} else {
fmt.Fprintln(os.Stderr, "  curl -L -o ggml-base.bin \\")
fmt.Fprintln(os.Stderr, "    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin")
fmt.Fprintln(os.Stderr, "\n  export WHISPER_MODEL=./ggml-base.bin")
}
fmt.Fprintf(os.Stderr, "\n利用可能なモデル: tiny / base / small / medium / large-v3\n")
fmt.Fprintf(os.Stderr, "  %s大きいほど精度が高く、小さいほど速い%s\n", colorCyan, colorReset)
}
