//go:build !darwin && !linux && !windows

package main

// totalSystemRAMBytes は未知のプラットフォームでは 0 を返す。
// AutoSelectModels は 0 GB として最小モデル (tiny + qwen3:0.6b) を選択する。
func totalSystemRAMBytes() uint64 { return 0 }
