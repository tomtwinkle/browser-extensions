package main

import "testing"

func TestAutoSelectModels(t *testing.T) {
	const GB = uint64(1 << 30)

	tests := []struct {
		name        string
		ram         uint64
		hasGPU      bool
		wantWhisper string
		wantLlama   string
	}{
		// ── GPU あり (Metal / CUDA) ─────────────────────────────────────────────
		{"GPU 64GB", 64 * GB, true, "large-v3-turbo", "calm3:22b-q4_k_m"},
		{"GPU 32GB", 32 * GB, true, "medium", "calm3:22b-q4_k_m"},
		{"GPU 16GB", 16 * GB, true, "small", "gemma4:e4b-q4_k_m"},
		{"GPU 8GB", 8 * GB, true, "small", "gemma4:e4b-q4_k_m"},
		{"GPU 4GB", 4 * GB, true, "base", "gemma4:e4b-q4_k_m"},
		{"GPU <4GB (2GB)", 2 * GB, true, "tiny", "gemma4:e2b-q4_k_m"},
		{"GPU 0B", 0, true, "tiny", "gemma4:e2b-q4_k_m"},

		// 境界値: ちょうどしきい値
		{"GPU exactly 64GB", 64 * GB, true, "large-v3-turbo", "calm3:22b-q4_k_m"},
		{"GPU just below 64GB", 64*GB - 1, true, "medium", "calm3:22b-q4_k_m"},
		{"GPU exactly 8GB", 8 * GB, true, "small", "gemma4:e4b-q4_k_m"},
		{"GPU just below 8GB", 8*GB - 1, true, "base", "gemma4:e4b-q4_k_m"},

		// ── GPU なし (CPU のみ) ──────────────────────────────────────────────────
		{"CPU 16GB", 16 * GB, false, "small", "gemma4:e4b-q4_k_m"},
		{"CPU 8GB", 8 * GB, false, "base", "gemma4:e4b-q4_k_m"},
		{"CPU 4GB", 4 * GB, false, "base", "gemma4:e2b-q4_k_m"},
		{"CPU <4GB (2GB)", 2 * GB, false, "tiny", "gemma4:e2b-q4_k_m"},
		{"CPU 0B", 0, false, "tiny", "gemma4:e2b-q4_k_m"},

		// 境界値: CPU しきい値
		{"CPU exactly 16GB", 16 * GB, false, "small", "gemma4:e4b-q4_k_m"},
		{"CPU just below 16GB", 16*GB - 1, false, "base", "gemma4:e4b-q4_k_m"},
		{"CPU exactly 4GB", 4 * GB, false, "base", "gemma4:e2b-q4_k_m"},
		{"CPU just below 4GB", 4*GB - 1, false, "tiny", "gemma4:e2b-q4_k_m"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := SystemInfo{TotalRAMBytes: tt.ram, HasGPU: tt.hasGPU}
			gotW, gotL := AutoSelectModels(info)
			if gotW != tt.wantWhisper {
				t.Errorf("whisper: got %q, want %q", gotW, tt.wantWhisper)
			}
			if gotL != tt.wantLlama {
				t.Errorf("llama:   got %q, want %q", gotL, tt.wantLlama)
			}
		})
	}
}

func TestAutoSelectModels_AllInRegistry(t *testing.T) {
	// 全ティアで選択されるモデルが実際のレジストリに登録されていることを確認する
	allTiers := append(gpuTiers, cpuTiers...)
	for _, tier := range allTiers {
		if _, ok := whisperRegistry[tier.whisper]; !ok {
			t.Errorf("whisper model %q is not in whisperRegistry", tier.whisper)
		}
		if _, ok := llamaRegistry[tier.llama]; !ok {
			t.Errorf("llama model %q is not in llamaRegistry", tier.llama)
		}
	}
}
