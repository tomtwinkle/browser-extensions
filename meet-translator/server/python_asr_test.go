package main

import (
	"strings"
	"testing"
)

func TestASRRequirementsSpec(t *testing.T) {
	tests := []struct {
		name            string
		backend         ASRBackendKind
		wantFile        string
		wantContains    []string
		wantNotContains []string
	}{
		{
			name:         "sensevoice",
			backend:      asrBackendSenseVoice,
			wantFile:     "requirements-asr-sensevoice.txt",
			wantContains: []string{"funasr", "modelscope", "torchaudio"},
			wantNotContains: []string{
				"whisperx",
				"transformers>=4.39",
			},
		},
		{
			name:         "whisperx",
			backend:      asrBackendWhisperX,
			wantFile:     "requirements-asr-whisperx.txt",
			wantContains: []string{"matplotlib", "numpy<2", "transformers<5", "whisperx", "torch"},
			wantNotContains: []string{
				"funasr",
				"modelscope",
				"transformers>=4.39",
			},
		},
		{
			name:         "transformers whisper",
			backend:      asrBackendTransformersWhisper,
			wantFile:     "requirements-asr-transformers.txt",
			wantContains: []string{"transformers>=4.39", "torch"},
			wantNotContains: []string{
				"funasr",
				"modelscope",
				"whisperx",
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := asrRequirementsSpec(tc.backend)
			if err != nil {
				t.Fatalf("asrRequirementsSpec() error = %v", err)
			}
			if got.fileName != tc.wantFile {
				t.Fatalf("fileName = %q, want %q", got.fileName, tc.wantFile)
			}
			for _, want := range tc.wantContains {
				if !strings.Contains(got.content, want) {
					t.Fatalf("content missing %q:\n%s", want, got.content)
				}
			}
			for _, unwanted := range tc.wantNotContains {
				if strings.Contains(got.content, unwanted) {
					t.Fatalf("content unexpectedly contains %q:\n%s", unwanted, got.content)
				}
			}
		})
	}
}

func TestPythonInstallHintUsesBackendSpecificRequirements(t *testing.T) {
	tests := []struct {
		name         string
		requirements string
		wantPath     string
		wantFFmpeg   bool
	}{
		{
			name:         "sensevoice",
			requirements: "/tmp/requirements-asr-sensevoice.txt",
			wantPath:     "./python/requirements-asr-sensevoice.txt",
			wantFFmpeg:   true,
		},
		{
			name:         "whisperx",
			requirements: "/tmp/requirements-asr-whisperx.txt",
			wantPath:     "./python/requirements-asr-whisperx.txt",
			wantFFmpeg:   true,
		},
		{
			name:         "transformers whisper",
			requirements: "/tmp/requirements-asr-transformers.txt",
			wantPath:     "./python/requirements-asr-transformers.txt",
			wantFFmpeg:   false,
		},
		{
			name:         "fallback aggregate",
			requirements: "",
			wantPath:     "./python/requirements-asr.txt",
			wantFFmpeg:   true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := pythonInstallHint(tc.requirements)
			if !strings.Contains(got, tc.wantPath) {
				t.Fatalf("hint missing %q:\n%s", tc.wantPath, got)
			}
			if !strings.Contains(got, "python3.11 -m pip install -r") {
				t.Fatalf("hint missing python3.11 install command:\n%s", got)
			}
			hasFFmpeg := strings.Contains(got, "ffmpeg")
			if hasFFmpeg != tc.wantFFmpeg {
				t.Fatalf("ffmpeg hint present = %v, want %v:\n%s", hasFFmpeg, tc.wantFFmpeg, got)
			}
		})
	}
}
