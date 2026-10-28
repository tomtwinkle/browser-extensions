package main

import "fmt"

type ASRBackendKind string

const (
	asrBackendWhisperCPP          ASRBackendKind = "whisper.cpp"
	asrBackendSenseVoice          ASRBackendKind = "sensevoice"
	asrBackendWhisperX            ASRBackendKind = "whisperx"
	asrBackendTransformersWhisper ASRBackendKind = "transformers-whisper"
)

type ResolvedWhisperModel struct {
	Backend      ASRBackendKind
	Spec         string
	ResolvedSpec string
}

type WhisperEntry struct {
	Backend       ASRBackendKind
	URL           string
	CacheFilename string
	ModelRef      string
}

// ASRSegment preserves timing and confidence-like values only when the selected
// backend reports them. Nil scores mean "not provided", not zero confidence.
type ASRSegment struct {
	StartMs             *float64 `json:"start_ms"`
	EndMs               *float64 `json:"end_ms"`
	Text                string   `json:"text"`
	AvgLogprob          *float64 `json:"avg_logprob"`
	NoSpeechProbability *float64 `json:"no_speech_probability"`
}

type ASRBackendResult struct {
	Backend          string       `json:"backend"`
	RawText          string       `json:"raw_text"`
	DetectedLanguage string       `json:"detected_language"`
	Segments         []ASRSegment `json:"segments"`
}

type detailedTranscriber interface {
	TranscribeDetailed(audioData []byte, lang, prompt string, logf func(string, ...any)) (ASRBackendResult, error)
}

type transcriber interface {
	Transcribe(audioData []byte, lang, prompt string, logf func(string, ...any)) (string, string, error)
	Close() error
}

func newTranscriber(model ResolvedWhisperModel) (transcriber, error) {
	switch model.Backend {
	case asrBackendWhisperCPP:
		return newNativeWhisperTranscriber(model.ResolvedSpec)
	case asrBackendSenseVoice, asrBackendWhisperX, asrBackendTransformersWhisper:
		return newPythonWorkerTranscriber(model.Backend, model.ResolvedSpec)
	default:
		return nil, fmt.Errorf("unsupported ASR backend: %s", model.Backend)
	}
}
