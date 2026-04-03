// preflight.go – 起動前チェック (モデルファイルの存在確認)
//
// Ollama は不要になったため、チェック対象はモデルファイルのみ。

package main

import (
"fmt"
"os"
"os/exec"
"runtime"
)

const (
colorRed    = "\033[31m"
colorYellow = "\033[33m"
colorCyan   = "\033[36m"
colorReset  = "\033[0m"
)

func hasCmd(name string) bool {
_, err := exec.LookPath(name)
return err == nil
}

func runPreflight(cfg config) {
ok := true
ok = checkModelFile("WHISPER_MODEL", cfg.whisperModel, whisperModelHint) && ok
ok = checkModelFile("LLAMA_MODEL", cfg.llamaModel, llamaModelHint) && ok
if !ok {
fmt.Fprintln(os.Stderr)
fmt.Fprintf(os.Stderr, "%s上記の問題を解決してから再度起動してください。%s\n", colorRed, colorReset)
os.Exit(1)
}
}

func checkModelFile(envKey, path string, hint func()) bool {
if path == "" {
fmt.Fprintf(os.Stderr, "\n%s[ERROR] %s が設定されていません%s\n", colorRed, envKey, colorReset)
hint()
return false
}
if _, err := os.Stat(path); err == nil {
return true
}
fmt.Fprintf(os.Stderr, "\n%s[ERROR] モデルファイルが見つかりません: %s=%s%s\n",
colorRed, envKey, path, colorReset)
hint()
return false
}

func whisperModelHint() {
fmt.Fprintf(os.Stderr, "%sダウンロード手順:%s\n", colorYellow, colorReset)
if runtime.GOOS == "windows" || !hasCmd("bash") {
fmt.Fprintln(os.Stderr, "  https://huggingface.co/ggerganov/whisper.cpp/tree/main から ggml-base.bin を取得")
fmt.Fprintln(os.Stderr, "\n  set WHISPER_MODEL=C:\\path\\to\\ggml-base.bin")
} else {
fmt.Fprintln(os.Stderr, "  curl -L -o ggml-base.bin \\")
fmt.Fprintln(os.Stderr, "    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin")
fmt.Fprintln(os.Stderr, "\n  export WHISPER_MODEL=./ggml-base.bin")
}
fmt.Fprintf(os.Stderr, "  %sモデル: tiny / base / small / medium / large-v3 (大=高精度・低速)%s\n", colorCyan, colorReset)
}

func llamaModelHint() {
fmt.Fprintf(os.Stderr, "%sダウンロード手順:%s\n", colorYellow, colorReset)
fmt.Fprintln(os.Stderr, "  例: Qwen2.5-7B-Instruct-Q4_K_M.gguf (推奨)")
fmt.Fprintln(os.Stderr, "  https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF から取得")
if runtime.GOOS == "windows" {
fmt.Fprintln(os.Stderr, "\n  set LLAMA_MODEL=C:\\path\\to\\model.gguf")
} else {
fmt.Fprintln(os.Stderr, "\n  export LLAMA_MODEL=./Qwen2.5-7B-Instruct-Q4_K_M.gguf")
}
fmt.Fprintf(os.Stderr, "  %sGPU がある場合は LLAMA_GPU_LAYERS=-1 で全レイヤをオフロード%s\n", colorCyan, colorReset)
}
