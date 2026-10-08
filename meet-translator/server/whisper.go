// whisper.go – whisper.cpp CGo ブリッジを使った文字起こし
//
// github.com/ggerganov/whisper.cpp/bindings/go への依存を除去し
// 直接 CGo で whisper.cpp を呼ぶ。

package main

/*
#cgo CFLAGS:   -I./vendor/llama.cpp/include -I./vendor/whisper.cpp/include -I./vendor/llama.cpp/ggml/include
#cgo CXXFLAGS: -I./vendor/llama.cpp/include -I./vendor/whisper.cpp/include -I./vendor/llama.cpp/ggml/include
#include "whisper_bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"unsafe"
)

// loadWhisperModel は whisper.cpp コンテキストをロードして返す。
func loadWhisperModel(modelPath string) (*C.whisper_context, error) {
	cpath := C.CString(modelPath)
	defer C.free(unsafe.Pointer(cpath))

	ctx := C.whisper_bridge_init(cpath)
	if ctx == nil {
		return nil, fmt.Errorf("failed to load whisper model: %s", modelPath)
	}
	return ctx, nil
}

type nativeWhisperTranscriber struct {
	ctx *C.whisper_context
}

func newNativeWhisperTranscriber(modelPath string) (transcriber, error) {
	ctx, err := loadWhisperModel(modelPath)
	if err != nil {
		return nil, err
	}
	return &nativeWhisperTranscriber{ctx: ctx}, nil
}

func (t *nativeWhisperTranscriber) Close() error {
	if t.ctx != nil {
		C.whisper_bridge_free(t.ctx)
		t.ctx = nil
	}
	return nil
}

func (t *nativeWhisperTranscriber) Transcribe(audioData []byte, lang, prompt string, logf func(string, ...any)) (string, string, error) {
	result, err := t.TranscribeDetailed(audioData, lang, prompt, logf)
	return result.RawText, result.DetectedLanguage, err
}

func (t *nativeWhisperTranscriber) TranscribeDetailed(audioData []byte, lang, prompt string, logf func(string, ...any)) (ASRBackendResult, error) {
	if t.ctx == nil {
		return ASRBackendResult{}, fmt.Errorf("whisper context not initialized")
	}

	// WAV をパース → 16kHz float32 に変換
	wav, err := parseWAV(bytes.NewReader(audioData))
	if err != nil {
		return ASRBackendResult{}, fmt.Errorf("failed to parse WAV: %w", err)
	}
	if logf != nil {
		logf("WAV: sampleRate=%d, channels=%d, samples=%d, duration=%.2fs",
			wav.sampleRate, wav.channels, len(wav.samples),
			float64(len(wav.samples))/float64(wav.sampleRate))
	}
	samples := resampleTo16k(wav.samples, wav.sampleRate)
	if len(samples) == 0 {
		return ASRBackendResult{Backend: string(asrBackendWhisperCPP), Segments: []ASRSegment{}}, nil
	}

	// C に渡す
	cSamples := (*C.float)(unsafe.Pointer(&samples[0]))
	cLang := C.CString(lang)
	defer C.free(unsafe.Pointer(cLang))

	// グロッサリーヒントのみを initial_prompt として使用する。
	// 過去の発話テキストは含めない（Whisper の無音時 hallucination を防ぐため）。
	prompt = strings.TrimSpace(prompt)
	if logf != nil {
		logf("whisper initial_prompt: %q", prompt)
	}
	cPrompt := C.CString(prompt)
	defer C.free(unsafe.Pointer(cPrompt))

	const outSize = 1 << 16
	outBuf := (*C.char)(C.malloc(outSize))
	defer C.free(unsafe.Pointer(outBuf))

	const langBufSize = 16
	langBuf := (*C.char)(C.malloc(langBufSize))
	defer C.free(unsafe.Pointer(langBuf))

	const segmentsBufSize = 1 << 20
	segmentsBuf := (*C.char)(C.malloc(segmentsBufSize))
	defer C.free(unsafe.Pointer(segmentsBuf))

	const errSize = 512
	errBuf := (*C.char)(C.malloc(errSize))
	defer C.free(unsafe.Pointer(errBuf))

	ret := C.whisper_bridge_transcribe(
		t.ctx,
		cSamples, C.int(len(samples)),
		cLang,
		cPrompt,
		outBuf, C.int(outSize),
		langBuf, C.int(langBufSize),
		segmentsBuf, C.int(segmentsBufSize),
		errBuf, C.int(errSize),
	)
	if ret != 0 {
		return ASRBackendResult{}, fmt.Errorf("whisper_bridge_transcribe failed: %s", C.GoString(errBuf))
	}

	result := strings.TrimSpace(C.GoString(outBuf))
	detectedLang := strings.TrimSpace(C.GoString(langBuf))
	var segments []ASRSegment
	if err := json.Unmarshal([]byte(C.GoString(segmentsBuf)), &segments); err != nil {
		return ASRBackendResult{}, fmt.Errorf("failed to decode Whisper segment metadata: %w", err)
	}
	if segments == nil {
		segments = []ASRSegment{}
	}
	if logf != nil {
		logf("whisper output: %d characters across %d segments, detected_lang: %q", len([]rune(result)), len(segments), detectedLang)
	}
	return ASRBackendResult{
		Backend:          string(asrBackendWhisperCPP),
		RawText:          result,
		DetectedLanguage: detectedLang,
		Segments:         segments,
	}, nil
}

// transcribeInternal は選択された ASR バックエンドで文字起こしして返す。
// Whisper 系の initial_prompt にはグロッサリーヒントのみを渡す。
func (s *server) transcribeInternal(audioData []byte, lang string) (string, string, error) {
	result, transcription, err := s.transcribeWithDetails(audioData, lang)
	if err != nil {
		return "", "", err
	}
	return transcription, result.DetectedLanguage, nil
}

func (s *server) transcribeWithDetails(audioData []byte, lang string) (ASRBackendResult, string, error) {
	prompt := ""
	if s.glossary != nil {
		prompt = strings.TrimSpace(s.glossary.WhisperHints())
	}
	var result ASRBackendResult
	var err error
	if s.transcriber != nil {
		if detailed, ok := s.transcriber.(detailedTranscriber); ok {
			result, err = detailed.TranscribeDetailed(audioData, lang, prompt, s.logVerbose)
		} else {
			result.RawText, result.DetectedLanguage, err = s.transcriber.Transcribe(audioData, lang, prompt, s.logVerbose)
		}
	} else if s.transcribeFn != nil {
		result.RawText, result.DetectedLanguage, err = s.transcribeFn(audioData, lang)
	} else {
		err = fmt.Errorf("transcriber not initialized")
	}
	if err != nil {
		return ASRBackendResult{}, "", err
	}
	result.RawText = strings.TrimSpace(result.RawText)
	transcription := result.RawText
	if s.glossary != nil {
		transcription = s.glossary.ApplyCorrections(transcription)
	}
	transcription = strings.TrimSpace(transcription)
	return result, transcription, nil
}

func whisperBridgeHasCandidateText(text string, tokenCount int) bool {
	cText := C.CString(text)
	defer C.free(unsafe.Pointer(cText))

	return C.whisper_bridge_has_candidate_text(
		cText,
		C.int(tokenCount),
	) != 0
}
