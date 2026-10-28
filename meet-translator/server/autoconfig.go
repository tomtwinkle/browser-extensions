// autoconfig.go – 初回起動時に比較基準のモデルを選ぶ。
//
// RAM容量やGPUの有無だけでは品質・会議中の遅延を判断できないため、
// 未評価の大きなモデルへ自動で切り替えない。資格済み構成が記録されるまでは
// firstRunWhisperModel / firstRunLlamaModel を比較基準として使う。
// 既存設定や明示されたモデル指定は applyAutoConfig が維持する。

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

// AutoSelectModels は現在の比較基準となる whisper / llama モデル名を返す。
func AutoSelectModels(_ SystemInfo) (whisper, llama string) {
	return firstRunWhisperModel, firstRunLlamaModel
}

// applyAutoConfig は config ファイルが存在せず、かつ whisper/llama モデルが未指定の場合に
// 比較基準モデルを cfg に設定し config ファイルに保存する。
// モデルが CLI/環境変数で既に指定されている場合は何もしない。
func applyAutoConfig(cfg *config) {
	if cfg.whisperModel != "" || cfg.llamaModel != "" {
		return
	}
	if configFileExists() {
		return
	}

	whisper, llama := AutoSelectModels(SystemInfo{})

	log.Printf("[autoconfig] selected baseline: whisper=%s  llama=%s", whisper, llama)
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
