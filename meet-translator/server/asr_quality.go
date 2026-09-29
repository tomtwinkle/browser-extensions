package main

import (
	"math"
	"net/http"
	"strconv"
	"strings"
)

const (
	whisperInitialMinAvgLogprob          = -0.8
	whisperInitialMaxNoSpeechProbability = 0.6
)

type ASRRequestEvidence struct {
	Present        bool
	VADKind        string
	SpeechDetected *bool
	ClippingRatio  *float64
	Invalid        bool
}

func parseASRRequestEvidence(r *http.Request) ASRRequestEvidence {
	evidence := ASRRequestEvidence{}
	if r.FormValue("vad_kind") == "" && r.FormValue("speech_detected") == "" &&
		r.FormValue("clipping_ratio") == "" && r.FormValue("voiced_duration_ms") == "" &&
		r.FormValue("utterance_duration_ms") == "" {
		return evidence
	}
	evidence.Present = true
	evidence.VADKind = strings.TrimSpace(r.FormValue("vad_kind"))
	if raw := strings.TrimSpace(r.FormValue("speech_detected")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			evidence.Invalid = true
		} else {
			evidence.SpeechDetected = &parsed
		}
	}
	if raw := strings.TrimSpace(r.FormValue("clipping_ratio")); raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 || parsed > 1 {
			evidence.Invalid = true
		} else {
			evidence.ClippingRatio = &parsed
		}
	}
	return evidence
}

// asrQualityFlags reports review hints without changing or removing candidate
// text. Whisper thresholds are applied only to the native Whisper backend.
func asrQualityFlags(result ASRBackendResult, text string, speechMs int, history []contextEntry, requestEvidence ...ASRRequestEvidence) []string {
	flags := make([]string, 0, 6)
	add := func(flag string) {
		for _, current := range flags {
			if current == flag {
				return
			}
		}
		flags = append(flags, flag)
	}
	addRequestEvidence := func(evidence ASRRequestEvidence) {
		if !evidence.Present {
			return
		}
		if evidence.Invalid {
			add("INVALID_VAD_EVIDENCE")
		}
		if evidence.SpeechDetected == nil || !*evidence.SpeechDetected || evidence.VADKind != "neural" {
			add("INSUFFICIENT_EVIDENCE")
		}
		if evidence.SpeechDetected != nil && !*evidence.SpeechDetected {
			add("NO_SPEECH")
		}
		if evidence.ClippingRatio != nil && *evidence.ClippingRatio > 0.01 {
			add("CLIPPING")
		}
	}

	text = strings.TrimSpace(text)
	if text == "" {
		if speechMs > 0 || len(requestEvidence) > 0 && requestEvidence[0].SpeechDetected != nil && *requestEvidence[0].SpeechDetected {
			add("EMPTY_WITH_SPEECH")
		}
		if len(requestEvidence) > 0 {
			addRequestEvidence(requestEvidence[0])
		}
		return flags
	}

	if !isMeaningfulTranscription(text) {
		add("NON_SPEECH_OR_SHORT_TEXT")
	} else if len([]rune(normalizedMeaningfulText(text))) < minMeaningfulRunes {
		add("SHORT_TRANSCRIPTION")
	}
	if isRepeatTranscription(text, history) {
		add("REPEATED_TRANSCRIPTION")
	}
	if isKnownHallucination(text) {
		add("KNOWN_HALLUCINATION_PHRASE")
	}
	if isLongDurationUnclearTranscription(text, speechMs) {
		add("LONG_DURATION_SHORT_TRANSCRIPTION")
	}

	if result.Backend == string(asrBackendWhisperCPP) {
		for _, segment := range result.Segments {
			if segment.AvgLogprob != nil && *segment.AvgLogprob < whisperInitialMinAvgLogprob {
				add("LOW_LOGPROB")
			}
			if segment.NoSpeechProbability != nil && *segment.NoSpeechProbability > whisperInitialMaxNoSpeechProbability {
				add("HIGH_NO_SPEECH")
			}
		}
	}
	if len(requestEvidence) > 0 && requestEvidence[0].Present {
		addRequestEvidence(requestEvidence[0])
	}
	return flags
}
