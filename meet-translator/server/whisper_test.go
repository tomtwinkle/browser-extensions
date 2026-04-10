package main

import "testing"

func TestWhisperBridgeShouldKeepSegment(t *testing.T) {
	tests := []struct {
		name         string
		text         string
		tokenCount   int
		avgLogprob   float32
		noSpeechProb float32
		wantKeep     bool
	}{
		{
			name:         "blank segment is dropped",
			text:         "   ",
			tokenCount:   0,
			avgLogprob:   0,
			noSpeechProb: 0,
			wantKeep:     false,
		},
		{
			name:         "high no-speech with weak logprob is dropped",
			text:         " Thank you for watching",
			tokenCount:   5,
			avgLogprob:   -0.95,
			noSpeechProb: 0.83,
			wantKeep:     false,
		},
		{
			name:         "confident speech is kept",
			text:         " hello everyone",
			tokenCount:   4,
			avgLogprob:   -0.22,
			noSpeechProb: 0.08,
			wantKeep:     true,
		},
		{
			name:         "high no-speech alone does not drop confident speech",
			text:         " はい",
			tokenCount:   1,
			avgLogprob:   -0.18,
			noSpeechProb: 0.81,
			wantKeep:     true,
		},
		{
			name:         "weak logprob alone does not drop likely speech",
			text:         " project status update",
			tokenCount:   3,
			avgLogprob:   -0.92,
			noSpeechProb: 0.18,
			wantKeep:     true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := whisperBridgeShouldKeepSegment(tt.text, tt.tokenCount, tt.avgLogprob, tt.noSpeechProb)
			if got != tt.wantKeep {
				t.Fatalf("whisperBridgeShouldKeepSegment(%q, %d, %f, %f) = %v, want %v",
					tt.text, tt.tokenCount, tt.avgLogprob, tt.noSpeechProb, got, tt.wantKeep)
			}
		})
	}
}
