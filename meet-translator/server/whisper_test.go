package main

import "testing"

func TestWhisperBridgeHasCandidateText(t *testing.T) {
	tests := []struct {
		name       string
		text       string
		tokenCount int
		wantKeep   bool
	}{
		{name: "blank segment has no candidate text", text: "   ", tokenCount: 0, wantKeep: false},
		{name: "suspicious phrase remains available for review", text: " Thank you for watching", tokenCount: 5, wantKeep: true},
		{name: "short acknowledgment remains available for review", text: " はい", tokenCount: 1, wantKeep: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := whisperBridgeHasCandidateText(tt.text, tt.tokenCount); got != tt.wantKeep {
				t.Fatalf("whisperBridgeHasCandidateText(%q, %d) = %v, want %v",
					tt.text, tt.tokenCount, got, tt.wantKeep)
			}
		})
	}
}
