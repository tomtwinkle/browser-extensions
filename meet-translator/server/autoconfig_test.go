package main

import "testing"

func TestAutoSelectModelsDoesNotEscalateFromHardwareCapacity(t *testing.T) {
	const gib = uint64(1 << 30)
	profiles := []struct {
		name string
		info SystemInfo
	}{
		{"m1-max-32gb-24gpu", SystemInfo{TotalRAMBytes: 32 * gib, HasGPU: true}},
		{"large-gpu-system", SystemInfo{TotalRAMBytes: 128 * gib, HasGPU: true}},
		{"small-cpu-system", SystemInfo{TotalRAMBytes: 2 * gib, HasGPU: false}},
		{"32gb-cpu-system", SystemInfo{TotalRAMBytes: 32 * gib, HasGPU: false}},
	}

	for _, profile := range profiles {
		t.Run(profile.name, func(t *testing.T) {
			gotWhisper, gotLlama := AutoSelectModels(profile.info)
			if gotWhisper != firstRunWhisperModel {
				t.Errorf("whisper = %q, want baseline %q", gotWhisper, firstRunWhisperModel)
			}
			if gotLlama != firstRunLlamaModel {
				t.Errorf("llama = %q, want baseline %q", gotLlama, firstRunLlamaModel)
			}
		})
	}
}

func TestAutoSelectModelsBaselineIsRegistered(t *testing.T) {
	if _, ok := whisperRegistry[firstRunWhisperModel]; !ok {
		t.Fatalf("baseline whisper model %q is not in whisperRegistry", firstRunWhisperModel)
	}
	if _, ok := llamaRegistry[firstRunLlamaModel]; !ok {
		t.Fatalf("baseline translation model %q is not in llamaRegistry", firstRunLlamaModel)
	}
}
