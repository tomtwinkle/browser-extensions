//go:build linux

package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// totalSystemRAMBytes は /proc/meminfo の MemTotal から Linux の総物理 RAM バイト数を返す。
// 取得できない場合は 0 を返す。
func totalSystemRAMBytes() uint64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, err := strconv.ParseUint(fields[1], 10, 64)
				if err == nil {
					return kb * 1024
				}
			}
			break
		}
	}
	return 0
}
