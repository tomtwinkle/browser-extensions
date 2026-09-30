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

// runPreflight はモデルスペックを実バックエンド設定に解決し cfg を更新する。
// 解決に失敗した場合はヘルプを表示してプロセスを終了する。
func runPreflight(cfg *config) (ResolvedWhisperModel, ResolvedLlamaModel) {
	whisperModel, err := resolveWhisperModel(cfg.whisperModel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n%s[ERROR] failed to resolve whisper model: %v%s\n", colorRed, err, colorReset)
		fmt.Fprintln(os.Stderr)
		printWhisperHelp(os.Stderr)
		fmt.Fprintln(os.Stderr)
		fmt.Fprintf(os.Stderr, "%sPlease fix the above issue and restart.%s\n", colorRed, colorReset)
		os.Exit(1)
	}
	cfg.whisperModel = whisperModel.ResolvedSpec

	llamaModel, err := resolveLlamaModel(cfg.llamaModel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n%s[ERROR] failed to resolve llama model: %v%s\n", colorRed, err, colorReset)
		fmt.Fprintln(os.Stderr)
		printLlamaHelp(os.Stderr)
		fmt.Fprintln(os.Stderr)
		fmt.Fprintf(os.Stderr, "%sPlease fix the above issue and restart.%s\n", colorRed, colorReset)
		os.Exit(1)
	}
	cfg.llamaModel = llamaModel.ResolvedSpec
	return whisperModel, llamaModel
}

// printFullHelp はパラメーター未指定時のフルヘルプを標準出力に表示する。
func printFullHelp() {
	flag.CommandLine.SetOutput(os.Stdout)
	flag.Usage()
}

func printWhisperHelp(w io.Writer) {
	fmt.Fprintf(w, "  Comparison baseline: %s%s%s (not a quality or M1 qualification).\n", colorCyan, firstRunWhisperModel, colorReset)
	fmt.Fprintf(w, "  Hardware capacity alone does not select a different model.\n")
	fmt.Fprintf(w, "  Registered manual choices (not ranked or M1-qualified):\n")
	fmt.Fprintf(w, "    %s--whisper-model large-v3-turbo%s\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model large-v3%s\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model kotoba-whisper%s (Kotoba-Whisper v2.0 GGML, JA-focused)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model sensevoice%s     (SenseVoiceSmall via local Python worker)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model whisperx%s       (WhisperX turbo, latest OpenAI Whisper model via local Python worker)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model whisperx-large-v3%s (WhisperX large-v3 via local Python worker)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model base%s           (smaller manual download, 142MB)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "  Available: %s\n", sortedWhisperKeys())
	fmt.Fprintf(w, "  Advanced: sensevoice:<model-ref> / whisperx:<model-name> (e.g. whisperx:turbo, whisperx:distil-large-v3)\n")
	fmt.Fprintf(w, "  Server-style whisperx:large-v3-turbo is accepted too and mapped to WhisperX's turbo model.\n")
	fmt.Fprintf(w, "  SenseVoice / WhisperX use the local Python worker.\n")
	fmt.Fprintf(w, "  If uv is installed, dependencies are provisioned automatically in an isolated env.\n")
	fmt.Fprintf(w, "  Otherwise install the backend-specific requirements manually with Python 3.11:\n")
	fmt.Fprintf(w, "    sensevoice -> ./python/requirements-asr-sensevoice.txt\n")
	fmt.Fprintf(w, "    whisperx* / whisperX* / kotoba-whisper-v2.2-faster -> ./python/requirements-asr-whisperx.txt\n")
	fmt.Fprintf(w, "    kotoba-whisper-v2.2 -> ./python/requirements-asr-transformers.txt\n")
	fmt.Fprintf(w, "    ffmpeg must be installed and available on PATH for SenseVoice / WhisperX\n")
	fmt.Fprintf(w, "  To use an existing file directly:\n")
	if runtime.GOOS == "windows" {
		fmt.Fprintf(w, "    --whisper-model C:\\path\\to\\ggml-base.bin\n")
	} else {
		fmt.Fprintf(w, "    --whisper-model ./ggml-base.bin\n")
	}
}

func printLlamaHelp(w io.Writer) {
	fmt.Fprintf(w, "  Comparison baseline: %s%s%s (not a quality or M1 qualification).\n", colorCyan, firstRunLlamaModel, colorReset)
	fmt.Fprintf(w, "  Hardware capacity alone does not select a different model.\n")
	fmt.Fprintf(w, "  Other registered model aliases can be set manually; they are not ranked or M1-qualified here.\n")
	fmt.Fprintf(w, "  Hy-MT2 aliases: tencent/Hy-MT2-1.8B, Hy-MT2-1.8B-GGUF, Hy-MT2-7B, Hy-MT2-7BGGUF.\n")
	fmt.Fprintf(w, "  Backend selection is model-specific; the selected backend is not an M1 qualification.\n")
	fmt.Fprintf(w, "    if uv is installed, MLX dependencies are provisioned automatically\n")
	fmt.Fprintf(w, "    otherwise install them manually with:\n")
	fmt.Fprintf(w, "      python3 -m pip install -r ./python/requirements-llm.txt\n")
	fmt.Fprintf(w, "  Other platforms: bonsai-8b falls back to the PrismML build; bonsai-4b / bonsai-1.7b are unavailable.\n")
	fmt.Fprintf(w, "  If server-prism is beside the standard binary, the bonsai-8b switch is automatic;\n")
	fmt.Fprintf(w, "  otherwise build it with: make prism\n")
	fmt.Fprintf(w, "  Known MLX refs are also accepted directly (for example %s or mlx-community/Qwen3-0.6B-4bit).\n", bonsai8BMLXModelRef)
	fmt.Fprintf(w, "  Models downloaded via Ollama are shared automatically.\n")
	fmt.Fprintf(w, "  To use an existing file directly:\n")
	if runtime.GOOS == "windows" {
		fmt.Fprintf(w, "    --llama-model C:\\path\\to\\model.gguf\n")
	} else {
		fmt.Fprintf(w, "    --llama-model ./model.gguf\n")
	}
}
