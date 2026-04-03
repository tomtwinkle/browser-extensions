// preflight.go – 起動前の依存チェック
//
// サーバー起動前に必要なツールの存在を確認し、
// 未インストールの場合は実際の環境（インストール済みパッケージマネージャー等）を
// 検出してから最適なインストール手順を表示して終了する。

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

	// ollama バイナリ自体が存在するか確認
	ollamaInstalled := hasCmd("ollama")

	if ollamaInstalled {
		// インストール済みだが起動していない
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
		// 未インストール – 環境に応じたインストール方法を提示
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
// whisper.cpp バイナリ チェック
// ---------------------------------------------------------------------------

func checkWhisperBin(bin string) bool {
	if _, err := os.Stat(bin); err == nil {
		return true
	}

	fmt.Fprintf(os.Stderr, "\n%s[ERROR] whisper-server バイナリが見つかりません: %s%s\n", colorRed, bin, colorReset)
	fmt.Fprintf(os.Stderr, "%sビルド手順:%s\n", colorYellow, colorReset)

	hasGit   := hasCmd("git")
	hasCmake := hasCmd("cmake")
	hasMake  := hasCmd("make")

	if !hasGit {
		fmt.Fprintf(os.Stderr, "  %s[前提] git が必要です:%s\n", colorYellow, colorReset)
		switch runtime.GOOS {
		case "windows":
			if hasCmd("winget") {
				fmt.Fprintln(os.Stderr, "    winget install Git.Git")
			} else {
				fmt.Fprintln(os.Stderr, "    https://git-scm.com/download/win からダウンロード")
			}
		case "darwin":
			if hasCmd("brew") {
				fmt.Fprintln(os.Stderr, "    brew install git")
			} else {
				fmt.Fprintln(os.Stderr, "    xcode-select --install")
			}
		default:
			fmt.Fprintln(os.Stderr, "    sudo apt install git  # または sudo dnf install git")
		}
	}

	if !hasCmake {
		fmt.Fprintf(os.Stderr, "  %s[前提] cmake が必要です:%s\n", colorYellow, colorReset)
		switch runtime.GOOS {
		case "windows":
			if hasCmd("winget") {
				fmt.Fprintln(os.Stderr, "    winget install Kitware.CMake")
			} else if hasCmd("choco") {
				fmt.Fprintln(os.Stderr, "    choco install cmake")
			} else {
				fmt.Fprintln(os.Stderr, "    https://cmake.org/download/ からダウンロード")
			}
		case "darwin":
			if hasCmd("brew") {
				fmt.Fprintln(os.Stderr, "    brew install cmake")
			} else {
				fmt.Fprintln(os.Stderr, "    https://cmake.org/download/ からダウンロード")
			}
		default:
			fmt.Fprintln(os.Stderr, "    sudo apt install cmake  # または sudo dnf install cmake")
		}
	}

	// whisper.cpp のビルドコマンド
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "  git clone https://github.com/ggerganov/whisper.cpp")
	fmt.Fprintln(os.Stderr, "  cd whisper.cpp")
	switch runtime.GOOS {
	case "windows":
		fmt.Fprintln(os.Stderr, "  cmake -B build")
		fmt.Fprintln(os.Stderr, "  cmake --build build --config Release")
		fmt.Fprintf(os.Stderr, "  %s# バイナリ: build\\bin\\Release\\whisper-server.exe%s\n", colorCyan, colorReset)
	default:
		if hasCmake {
			parallel := ""
			if hasMake {
				parallel = " -j"
			}
			fmt.Fprintf(os.Stderr, "  cmake -B build && cmake --build build%s\n", parallel)
		} else {
			fmt.Fprintln(os.Stderr, "  cmake -B build && cmake --build build -j")
		}
		fmt.Fprintf(os.Stderr, "  %s# バイナリ: build/bin/whisper-server%s\n", colorCyan, colorReset)
	}
	fmt.Fprintf(os.Stderr, "\nビルド後に環境変数を設定してください:\n")
	if runtime.GOOS == "windows" {
		fmt.Fprintln(os.Stderr, "  set WHISPER_BIN=.\\whisper.cpp\\build\\bin\\Release\\whisper-server.exe")
	} else {
		fmt.Fprintln(os.Stderr, "  export WHISPER_BIN=./whisper.cpp/build/bin/whisper-server")
	}
	return false
}

// ---------------------------------------------------------------------------
// whisper.cpp モデルファイル チェック
// ---------------------------------------------------------------------------

func checkWhisperModel(model string) bool {
	if model == "" {
		fmt.Fprintf(os.Stderr, "\n%s[ERROR] WHISPER_MODEL が設定されていません%s\n", colorRed, colorReset)
		fmt.Fprintln(os.Stderr, "  モデルをダウンロードして WHISPER_MODEL に指定してください:")
		printModelDownloadHint()
		return false
	}
	if _, err := os.Stat(model); err == nil {
		return true
	}

	fmt.Fprintf(os.Stderr, "\n%s[ERROR] whisper.cpp モデルファイルが見つかりません: %s%s\n", colorRed, model, colorReset)
	fmt.Fprintf(os.Stderr, "%sモデルのダウンロード手順:%s\n", colorYellow, colorReset)
	printModelDownloadHint()
	return false
}

func printModelDownloadHint() {
	if runtime.GOOS == "windows" || !hasCmd("bash") {
		fmt.Fprintln(os.Stderr, "  https://huggingface.co/ggerganov/whisper.cpp/tree/main からダウンロード")
		fmt.Fprintln(os.Stderr, "  例: ggml-base.bin を whisper.cpp/models/ に配置")
	} else {
		fmt.Fprintln(os.Stderr, "  cd whisper.cpp")
		fmt.Fprintln(os.Stderr, "  bash models/download-ggml-model.sh base")
	}
	fmt.Fprintf(os.Stderr, "\n利用可能なモデル: tiny / base / small / medium / large-v3\n")
	fmt.Fprintf(os.Stderr, "  %s大きいほど精度が高く、小さいほど速い%s\n", colorCyan, colorReset)
	if runtime.GOOS == "windows" {
		fmt.Fprintln(os.Stderr, "\n  set WHISPER_MODEL=.\\whisper.cpp\\models\\ggml-base.bin")
	} else {
		fmt.Fprintln(os.Stderr, "\n  export WHISPER_MODEL=./whisper.cpp/models/ggml-base.bin")
	}
}
