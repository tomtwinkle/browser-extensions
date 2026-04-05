//go:build darwin

package main

import (
	"os/exec"
	"strconv"
	"strings"
)

// totalSystemRAMBytes は sysctl -n hw.memsize を使って macOS の総物理 RAM バイト数を返す。
// Apple Silicon / Intel どちらも対応。取得できない場合は 0 を返す。
func totalSystemRAMBytes() uint64 {
	out, err := exec.Command("sysctl", "-n", "hw.memsize").Output()
	if err != nil {
		return 0
	}
	n, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0
	}
	return n
}
