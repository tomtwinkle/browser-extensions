// subprocess.go – whisper.cpp 子プロセス管理
//
// WHISPER_BIN と WHISPER_MODEL が設定されている場合、
// Go サーバー起動時に whisper.cpp サーバーを自動起動し、
// シャットダウン時に一緒に終了させる。

package main

import (
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"time"
)

// startWhisperProcess は whisper.cpp サーバーを子プロセスとして起動し、
// 起動完了を確認してから返す。呼び出し元が cmd.Process.Kill() で終了させること。
func startWhisperProcess(bin, model, port string) (*exec.Cmd, error) {
	cmd := exec.Command(bin,
		"--model", model,
		"--port", port,
		"--host", "127.0.0.1",
	)
	// 子プロセスのログを親プロセスの stderr に流す
	cmd.Stdout = log.Writer()
	cmd.Stderr = log.Writer()

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("whisper.cpp の起動に失敗: %w", err)
	}
	log.Printf("[whisper] 起動中 (pid=%d) %s --model %s --port %s", cmd.Process.Pid, bin, model, port)

	// 準備完了を最大 30 秒ポーリングして待つ
	healthURL := fmt.Sprintf("http://127.0.0.1:%s/health", port)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(healthURL) //nolint:gosec
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				log.Printf("[whisper] 準備完了 (%s)", healthURL)
				return cmd, nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}

	// タイムアウト – プロセスを後始末してエラーを返す
	_ = cmd.Process.Kill()
	return nil, fmt.Errorf("whisper.cpp が 30 秒以内に起動しませんでした")
}
