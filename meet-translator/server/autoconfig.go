// autoconfig.go – 初回起動時の自動モデル選択
//
// config ファイルが存在せず、かつ CLI/環境変数でモデルが指定されていない場合、
// 実行マシンのスペック (総 RAM・GPU 有無) を検出し、最もバランスの取れた
// whisper モデルと llama モデルを自動的に選択する。
//
// # モデル優先度の決定方法
//
// tier 割り当ては cmd/benchmark のベンチマークツールで計測した結果に基づく。
// ベンチマークは EN→JA / JA→EN の双方向 40 件で実施し、以下の指標を使用する:
//
//   - 品質スコア: ChrF (文字 n-gram F スコア, n=1,2,3 平均)
//   - 速度スコア: 1 / (1 + latency_ms/300)  ← 300ms を基準値とする
//   - 総合スコア: quality×0.6 + speed×0.4
//
// # macOS Apple M1 Max 計測結果 (GPU Metal, Q4_K_M, 2026-04)
//
//	Rank  Model                    Quality  Latency  Combined
//	   1  qwen3.5:0.8b-q4_k_m      0.636    230ms    0.608
//	   2  qwen3:4b-q4_k_m          0.814    730ms    0.605
//	   3  qwen3:8b-q4_k_m          0.833   1360ms    0.572
//	   4  gemma4:e4b-q4_k_m        0.256  11707ms    0.163  ← 翻訳タスク不適
//
// ベンチマークの実行方法:
//
//	./server --llama-model <model> &
//	make bench OUTPUT=results/<model>.json
//	make bench OUTPUT=results/<model2>.json  # モデルを変えて繰り返す
//	go run ./cmd/benchmark/ --compare results/
//
// GPU あり (Metal / CUDA) の場合:
//
//	GPU はモデルの重みを VRAM/GPU メモリに転送して高速推論できる。
//	大きいモデルでもリアルタイム翻訳の遅延が許容範囲内に収まるため、
//	品質を優先したモデルを選択する。
//
// GPU なし (CPU のみ) の場合:
//
//	大きいモデルは推論が遅くリアルタイム翻訳に不向きなため、
//	速度優先で小さいモデルを選択する。

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
// ベンチマーク結果: qwen3:4b(combined=0.605) > qwen3:8b(0.572) > qwen3.5:0.8b(speed=0.608)
// gemma4:e4b は翻訳品質が低い(0.256)ため除外。
var gpuTiers = []modelTier{
	{64, "large-v3-turbo", "calm3:22b-q4_k_m"},      // 22B 高品質 (日本語特化)
	{32, "medium", "calm3:22b-q4_k_m"},               // 同上
	{8, "small", "qwen3:8b-q4_k_m"},                  // 品質最高 (0.833, ~5GB VRAM)
	{4, "small", "qwen3:4b-q4_k_m"},                  // 総合最良 (0.605, ~2.5GB VRAM)
	{0, "base", "qwen3.5:0.8b-q4_k_m"},               // 速度優先 (0.608, ~0.5GB VRAM)
}

// cpuTiers は CPU のみのモデル選択テーブル。
// 推論速度を優先し、リアルタイム翻訳が成立する範囲で最大品質を選ぶ。
// CPU では qwen3.5:0.8b が唯一許容できる速度で動作する。
var cpuTiers = []modelTier{
	{8, "base", "qwen3.5:0.8b-q4_k_m"},  // 速度優先 (0.608), CPU でも実用的
	{4, "base", "qwen3.5:0.8b-q4_k_m"},  // 同上 (~0.5GB RAM)
	{0, "tiny", "bonsai-8b"},             // <4GB RAM: 超圧縮フォールバック (~1.15GB)
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
	return "tiny", "bonsai-8b"
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
