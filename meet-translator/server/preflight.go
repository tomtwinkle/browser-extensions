// preflight.go – 起動前モデル解決
//
// モデル名 (例: "base", "qwen3:8b-q4_k_m") を実際のファイルパスに解決する。
// ファイルが存在しない場合は自動ダウンロードを試みる。
// Ollama のダウンロード済みキャッシュが存在する場合はそちらを優先利用する。

package main

import (
"fmt"
"os"
"runtime"
)

const (
colorRed    = "\033[31m"
colorYellow = "\033[33m"
colorCyan   = "\033[36m"
colorReset  = "\033[0m"
)

// runPreflight はモデルスペックを実パスに解決し cfg を更新する。
// 解決に失敗した場合はヘルプを表示してプロセスを終了する。
func runPreflight(cfg *config) {
whisperPath, err := resolveWhisperModel(cfg.whisperModel)
if err != nil {
fmt.Fprintf(os.Stderr, "\n%s[ERROR] WHISPER_MODEL の解決に失敗: %v%s\n", colorRed, err, colorReset)
printWhisperHelp()
fmt.Fprintln(os.Stderr)
fmt.Fprintf(os.Stderr, "%s上記の問題を解決してから再度起動してください。%s\n", colorRed, colorReset)
os.Exit(1)
}
cfg.whisperModel = whisperPath

llamaPath, err := resolveLlamaModel(cfg.llamaModel)
if err != nil {
fmt.Fprintf(os.Stderr, "\n%s[ERROR] LLAMA_MODEL の解決に失敗: %v%s\n", colorRed, err, colorReset)
printLlamaHelp()
fmt.Fprintln(os.Stderr)
fmt.Fprintf(os.Stderr, "%s上記の問題を解決してから再度起動してください。%s\n", colorRed, colorReset)
os.Exit(1)
}
cfg.llamaModel = llamaPath
}

func printWhisperHelp() {
fmt.Fprintf(os.Stderr, "%s使い方:%s\n", colorYellow, colorReset)
fmt.Fprintf(os.Stderr, "  モデル名を指定すると自動ダウンロードします:\n")
fmt.Fprintf(os.Stderr, "    %sWHISPER_MODEL=base%s  (推奨)\n", colorCyan, colorReset)
fmt.Fprintf(os.Stderr, "  利用可能なモデル名: tiny / base / small / medium / large-v3 など\n")
fmt.Fprintf(os.Stderr, "  既存ファイルを指定する場合:\n")
if runtime.GOOS == "windows" {
fmt.Fprintf(os.Stderr, "    set WHISPER_MODEL=C:\\path\\to\\ggml-base.bin\n")
} else {
fmt.Fprintf(os.Stderr, "    export WHISPER_MODEL=./ggml-base.bin\n")
}
}

func printLlamaHelp() {
fmt.Fprintf(os.Stderr, "%s使い方:%s\n", colorYellow, colorReset)
fmt.Fprintf(os.Stderr, "  モデル名を指定すると自動ダウンロードします:\n")
fmt.Fprintf(os.Stderr, "    %sLLAMA_MODEL=qwen2.5:7b-instruct-q4_k_m%s  (Qwen2.5 推奨)\n", colorCyan, colorReset)
fmt.Fprintf(os.Stderr, "    %sLLAMA_MODEL=qwen3:8b-q4_k_m%s             (Qwen3、thinking対応)\n", colorCyan, colorReset)
fmt.Fprintf(os.Stderr, "    %sLLAMA_MODEL=gemma4:e4b-q4_k_m%s           (Gemma4)\n", colorCyan, colorReset)
fmt.Fprintf(os.Stderr, "  Ollama でダウンロード済みのモデルは自動的に共有されます。\n")
fmt.Fprintf(os.Stderr, "  既存ファイルを指定する場合:\n")
if runtime.GOOS == "windows" {
fmt.Fprintf(os.Stderr, "    set LLAMA_MODEL=C:\\path\\to\\model.gguf\n")
} else {
fmt.Fprintf(os.Stderr, "    export LLAMA_MODEL=./model.gguf\n")
}
}
