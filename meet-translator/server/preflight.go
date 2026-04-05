// preflight.go – 起動前モデル解決
//
// モデル名 (例: "base", "qwen3:8b-q4_k_m") を実際のファイルパスに解決する。
// ファイルが存在しない場合は自動ダウンロードを試みる。
// Ollama のダウンロード済みキャッシュが存在する場合はそちらを優先利用する。

package main

import (
	"flag"
	"fmt"
	"io"
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
		fmt.Fprintf(os.Stderr, "\n%s[ERROR] failed to resolve whisper model: %v%s\n", colorRed, err, colorReset)
		fmt.Fprintln(os.Stderr)
		printWhisperHelp(os.Stderr)
		fmt.Fprintln(os.Stderr)
		fmt.Fprintf(os.Stderr, "%sPlease fix the above issue and restart.%s\n", colorRed, colorReset)
		os.Exit(1)
	}
	cfg.whisperModel = whisperPath

	llamaPath, err := resolveLlamaModel(cfg.llamaModel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n%s[ERROR] failed to resolve llama model: %v%s\n", colorRed, err, colorReset)
		fmt.Fprintln(os.Stderr)
		printLlamaHelp(os.Stderr)
		fmt.Fprintln(os.Stderr)
		fmt.Fprintf(os.Stderr, "%sPlease fix the above issue and restart.%s\n", colorRed, colorReset)
		os.Exit(1)
	}
	cfg.llamaModel = llamaPath
}

// printFullHelp はパラメーター未指定時のフルヘルプを標準出力に表示する。
func printFullHelp() {
	flag.CommandLine.SetOutput(os.Stdout)
	flag.Usage()
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "%s━━ whisper model (speech recognition) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n", colorYellow, colorReset)
	printWhisperHelp(os.Stdout)
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "%s━━ llama model (translation LLM) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n", colorYellow, colorReset)
	printLlamaHelp(os.Stdout)
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "%sExample:%s\n", colorYellow, colorReset)
	fmt.Fprintf(os.Stdout, "  meet-translator-server --whisper-model base --llama-model qwen3.5:4b-q4_k_m\n")
}

func printWhisperHelp(w io.Writer) {
	fmt.Fprintf(w, "  Specify a model name to auto-download:\n")
	fmt.Fprintf(w, "    %s--whisper-model base%s           (recommended, 142MB)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model large-v3-turbo%s (high accuracy, 809MB)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model large-v3%s       (highest accuracy, 3.1GB)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "  Available: tiny / base / small / medium / large-v3 / large-v3-turbo\n")
	fmt.Fprintf(w, "  To use an existing file directly:\n")
	if runtime.GOOS == "windows" {
		fmt.Fprintf(w, "    --whisper-model C:\\path\\to\\ggml-base.bin\n")
	} else {
		fmt.Fprintf(w, "    --whisper-model ./ggml-base.bin\n")
	}
}

func printLlamaHelp(w io.Writer) {
	fmt.Fprintf(w, "  Specify a model name to auto-download:\n")
	fmt.Fprintf(w, "    %s--llama-model qwen3.5:4b-q4_k_m%s   (recommended, 3.2GB, Thinking)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--llama-model qwen3.5:9b-q4_k_m%s   (high accuracy, 5.3GB, Thinking)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--llama-model qwen3:4b-q4_k_m%s     (Qwen3, 2.6GB, Thinking)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--llama-model calm3:22b-q4_k_m%s    (JA/EN specialist, 13GB, requires 16GB VRAM)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--llama-model gemma4:e4b-q4_k_m%s   (Gemma4, 2.6GB)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "  Models downloaded via Ollama are shared automatically.\n")
	fmt.Fprintf(w, "  To use an existing file directly:\n")
	if runtime.GOOS == "windows" {
		fmt.Fprintf(w, "    --llama-model C:\\path\\to\\model.gguf\n")
	} else {
		fmt.Fprintf(w, "    --llama-model ./model.gguf\n")
	}
}
