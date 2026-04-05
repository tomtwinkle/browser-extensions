// autoconfig.go – 初回起動時の自動モデル選択
//
// config ファイルが存在せず、かつ CLI/環境変数でモデルが指定されていない場合、
// 実行マシンのスペック (総 RAM・GPU 有無) を検出し、最もバランスの取れた
// whisper モデルと llama モデルを自動的に選択する。
//
// GPU あり (Metal / CUDA) の場合:
//   GPU はモデルの重みを VRAM/GPU メモリに転送して高速推論できる。
//   大きいモデルでもリアルタイム翻訳の遅延が許容範囲内に収まるため、
//   品質を優先したモデルを選択する。
//
// GPU なし (CPU のみ) の場合:
//   大きいモデルは推論が遅くリアルタイム翻訳に不向きなため、
//   速度優先で小さいモデルを選択する。

package main

import (
	"log"
)

// SystemInfo はハードウェア検出結果を保持する。
type SystemInfo struct {
	TotalRAMBytes uint64
	HasGPU        bool
}

// DetectSystemInfo はシステムの RAM 容量と GPU 利用可否を検出する。
func DetectSystemInfo() SystemInfo {
	return SystemInfo{
		TotalRAMBytes: totalSystemRAMBytes(),
		HasGPU:        gpuAvailable(),
	}
}

// modelTier は RAM しきい値と選択モデルのペアを表す。
// tiers はしきい値の降順で並べる。
type modelTier struct {
	minRAMGB float64
	whisper  string
	llama    string
}

// gpuTiers は GPU あり (Metal / CUDA) 時のモデル選択テーブル。
// 品質を優先し、GPU による高速推論を前提とした大きめのモデルを選ぶ。
var gpuTiers = []modelTier{
	{64, "large-v3-turbo", "calm3:22b-q4_k_m"},
	{32, "medium", "calm3:22b-q4_k_m"},
	{16, "small", "gemma4:e4b-q4_k_m"},
	{8, "small", "gemma4:e4b-q4_k_m"},
	{4, "base", "gemma4:e4b-q4_k_m"},
	{0, "tiny", "gemma4:e2b-q4_k_m"},
}

// cpuTiers は CPU のみのモデル選択テーブル。
// 推論速度を優先し、リアルタイム翻訳が成立する範囲で最大品質を選ぶ。
var cpuTiers = []modelTier{
	{16, "small", "gemma4:e4b-q4_k_m"},
	{8, "base", "gemma4:e4b-q4_k_m"},
	{4, "base", "gemma4:e2b-q4_k_m"},
	{0, "tiny", "gemma4:e2b-q4_k_m"},
}

// AutoSelectModels は SystemInfo に基づいて最適な whisper / llama モデル名を返す。
func AutoSelectModels(info SystemInfo) (whisper, llama string) {
	ramGB := float64(info.TotalRAMBytes) / (1 << 30)
	tiers := cpuTiers
	if info.HasGPU {
		tiers = gpuTiers
	}
	for _, t := range tiers {
		if ramGB >= t.minRAMGB {
			return t.whisper, t.llama
		}
	}
	// 最小フォールバック (通常は到達しない)
	return "tiny", "gemma4:e2b-q4_k_m"
}

// applyAutoConfig は config ファイルが存在せず、かつ whisper/llama モデルが未指定の場合に
// マシンスペックから最適なモデルを選択して cfg に設定し config ファイルに保存する。
// モデルが CLI/環境変数で既に指定されている場合は何もしない。
func applyAutoConfig(cfg *config) {
	if cfg.whisperModel != "" || cfg.llamaModel != "" {
		return
	}
	if configFileExists() {
		return
	}

	info := DetectSystemInfo()
	ramGB := float64(info.TotalRAMBytes) / (1 << 30)
	whisper, llama := AutoSelectModels(info)

	log.Printf("[autoconfig] total RAM: %.1f GB, GPU: %v", ramGB, info.HasGPU)
	log.Printf("[autoconfig] auto-selected: whisper=%s  llama=%s", whisper, llama)
	log.Printf("[autoconfig] to change, run with --whisper-model and --llama-model flags")

	cfg.whisperModel = whisper
	cfg.llamaModel = llama

	n := cfg.llamaGPULayers
	w := cfg.whisperGPULayers
	save := persistedConfig{
		Port:             cfg.port,
		WhisperModel:     whisper,
		LlamaModel:       llama,
		LlamaGPULayers:   &n,
		WhisperGPULayers: &w,
	}
	if err := saveConfigFile(save); err != nil {
		log.Printf("[autoconfig] warning: failed to save config: %v", err)
	} else {
		log.Printf("[autoconfig] config saved to %s", configFilePath())
	}
}
