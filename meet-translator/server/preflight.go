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
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "%s━━ whisper model (speech recognition) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n", colorYellow, colorReset)
	printWhisperHelp(os.Stdout)
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "%s━━ llama model (translation LLM) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n", colorYellow, colorReset)
	printLlamaHelp(os.Stdout)
	fmt.Fprintln(os.Stdout)
	fmt.Fprintf(os.Stdout, "%sExample:%s\n", colorYellow, colorReset)
	fmt.Fprintf(os.Stdout, "  meet-translator-server --whisper-model %s --llama-model %s\n", firstRunWhisperModel, firstRunLlamaModel)
}

func printWhisperHelp(w io.Writer) {
	fmt.Fprintf(w, "  First-run floor keeps Whisper at %s%s%s.\n", colorCyan, firstRunWhisperModel, colorReset)
	fmt.Fprintf(w, "  If the machine has plenty of headroom, autoconfig can step up to large-v3.\n")
	fmt.Fprintf(w, "  Common manual choices:\n")
	fmt.Fprintf(w, "    %s--whisper-model large-v3-turbo%s (default floor, 809MB)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model large-v3%s       (highest accuracy, 3.1GB)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model kotoba-whisper%s (Kotoba-Whisper v2.0 GGML, JA-focused)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model sensevoice%s     (SenseVoiceSmall via local Python worker)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model whisperx%s       (WhisperX large-v3 via local Python worker)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--whisper-model base%s           (smaller manual download, 142MB)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "  Available: %s\n", sortedWhisperKeys())
	fmt.Fprintf(w, "  Advanced: sensevoice:<model-ref> / whisperx:<model-name>\n")
	fmt.Fprintf(w, "  SenseVoice / WhisperX use the local Python worker.\n")
	fmt.Fprintf(w, "  If uv is installed, dependencies are provisioned automatically in an isolated env.\n")
	fmt.Fprintf(w, "  Otherwise install them manually with:\n")
	fmt.Fprintf(w, "    python3 -m pip install -r ./python/requirements-asr.txt\n")
	fmt.Fprintf(w, "    ffmpeg must be installed and available on PATH\n")
	fmt.Fprintf(w, "  To use an existing file directly:\n")
	if runtime.GOOS == "windows" {
		fmt.Fprintf(w, "    --whisper-model C:\\path\\to\\ggml-base.bin\n")
	} else {
		fmt.Fprintf(w, "    --whisper-model ./ggml-base.bin\n")
	}
}

func printLlamaHelp(w io.Writer) {
	fmt.Fprintf(w, "  First-run ladder:\n")
	fmt.Fprintf(w, "    %s--llama-model %s%s   (default floor, 0.6GB, Thinking)\n", colorCyan, firstRunLlamaModel, colorReset)
	fmt.Fprintf(w, "    %s--llama-model bonsai-8b%s            (next step, 1-bit 8B, 1.15GB, Thinking)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--llama-model qwen3:8b-q4_k_m%s     (higher tier, 5.2GB, Thinking)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "    %s--llama-model calm3:22b-q4_k_m%s    (top tier, JA/EN specialist, 13GB, needs ~16GB VRAM)\n", colorCyan, colorReset)
	fmt.Fprintf(w, "  Also available manually: bonsai-4b, bonsai-1.7b, qwen3.5:2b/4b/9b, qwen3:0.6b/1.7b/4b, qwen2.5:7b/14b, gemma4:e2b/e4b/26b.\n")
	fmt.Fprintf(w, "  Apple Silicon (darwin/arm64): models with a known MLX variant use MLX automatically.\n")
	fmt.Fprintf(w, "    current coverage: bonsai, qwen2.5, qwen3/3.5, gemma4, calm3\n")
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
