package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestModelHelpDoesNotDescribeUnmeasuredModelsAsQualified(t *testing.T) {
	tests := []struct {
		name  string
		print func(*bytes.Buffer)
	}{
		{"whisper", func(out *bytes.Buffer) { printWhisperHelp(out) }},
		{"llama", func(out *bytes.Buffer) { printLlamaHelp(out) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out bytes.Buffer
			tt.print(&out)
			text := out.String()
			for _, stale := range []string{"autoconfig can step up", "highest accuracy", "top tier", "First-run ladder"} {
				if strings.Contains(text, stale) {
					t.Errorf("help still contains unsupported ranking %q", stale)
				}
			}
			if !strings.Contains(text, "not a quality or M1 qualification") {
				t.Error("help must say that the baseline is not a quality or M1 qualification")
			}
		})
	}
}
