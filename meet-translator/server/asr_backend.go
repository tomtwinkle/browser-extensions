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
