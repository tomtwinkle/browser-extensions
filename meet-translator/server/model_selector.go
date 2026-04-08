// model_selector.go – モデルに応じたバイナリ自動選択
//
// 一部のモデルは特定のビルドバリアントが必要:
//   - bonsai-8b:   Q1_0_g128 量子化 → PrismML ビルド (server-prism)
//   - gemma4:*:    gemma4 アーキテクチャ → 標準ビルド (server)
//
// redirectIfNeeded は起動時に呼ばれ、モデルが現在のバイナリで動作するか確認する。
// 別バリアントが必要な場合は同ディレクトリの対応バイナリへ syscall.Exec する。
// 対応バイナリが存在しない場合はヒントを表示して続行する (ロード時にエラーになる)。

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"syscall"
)

// redirectIfNeeded はモデルスペックに応じて適切なバイナリへ exec する。
// llamaSpec が空またはファイルパスの場合は何もしない。
// 注意: この関数は flag.Parse() 後・モデルロード前に呼ぶこと。
func redirectIfNeeded(llamaSpec string) {
	if llamaSpec == "" {
		return
	}

	entry, ok := llamaRegistry[llamaSpec]
	if !ok {
		// 未知のモデル名 (ファイルパス等) はスキップ
		return
	}

	needsPrism := entry.NeedsPrism
	if needsPrism == backendIsPrism {
		return // 現在のバイナリで対応可能
	}

	// 切り替え先バイナリ名を決定
	var targetBin string
	if needsPrism {
		// 標準ビルドで PrismML 専用モデルが要求された → server-prism へ
		targetBin = "server-prism"
	} else {
		// PrismML ビルドで標準モデル (gemma4 等) が要求された → server へ
		targetBin = "server"
	}

	// 実行ファイルと同じディレクトリを検索
	exe, err := os.Executable()
	if err != nil {
		log.Printf("[selector] cannot determine executable path: %v", err)
		printSelectorHint(llamaSpec, targetBin, needsPrism)
		return
	}
	targetPath := filepath.Join(filepath.Dir(exe), targetBin)

	if _, err := os.Stat(targetPath); err != nil {
		// 対応バイナリが存在しない場合はヒントを表示して続行
		printSelectorHint(llamaSpec, targetBin, needsPrism)
		return
	}

	log.Printf("[selector] model %q requires %s – redirecting to %s", llamaSpec, binaryDesc(!backendIsPrism), targetPath)
	if err := syscall.Exec(targetPath, os.Args, os.Environ()); err != nil {
		log.Fatalf("[selector] exec %s: %v", targetPath, err)
	}
}

// printSelectorHint は対応バイナリが見つからなかった場合のビルドヒントを表示する。
func printSelectorHint(llamaSpec, targetBin string, needsPrism bool) {
	var makeCmd string
	if needsPrism {
		makeCmd = "make prism"
	} else {
		makeCmd = "make"
	}
	fmt.Fprintf(os.Stderr,
		"[selector] WARNING: model %q requires the %s build.\n"+
			"  Build %s with: %s\n"+
			"  Continuing anyway (model load will likely fail).\n",
		llamaSpec, binaryDesc(needsPrism), targetBin, makeCmd)
}

// binaryDesc はバイナリ種別の説明文字列を返す。
func binaryDesc(prism bool) string {
	if prism {
		return "PrismML (Q1_0_g128)"
	}
	return "standard (official llama.cpp)"
}
