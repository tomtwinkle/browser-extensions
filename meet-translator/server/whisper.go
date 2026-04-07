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

// transcribeInternal は WAV バイト列を文字起こしして返す。
// Whisper への initial_prompt にはグロッサリーヒントのみを渡す。
// 過去の発話テキストを initial_prompt に含めると Whisper が無音時に
// 前回発話を幻覚再生（hallucination）し翻訳連鎖を引き起こすため除外する。
func (s *server) transcribeInternal(audioData []byte, lang string) (string, string, error) {
	if s.whisperCtx == nil {
		return "", "", fmt.Errorf("whisper context not initialized")
	}

	// WAV をパース → 16kHz float32 に変換
	wav, err := parseWAV(bytes.NewReader(audioData))
	if err != nil {
		return "", "", fmt.Errorf("failed to parse WAV: %w", err)
	}
	s.logVerbose("WAV: sampleRate=%d, channels=%d, samples=%d, duration=%.2fs",
		wav.sampleRate, wav.channels, len(wav.samples),
		float64(len(wav.samples))/float64(wav.sampleRate))
	samples := resampleTo16k(wav.samples, wav.sampleRate)
	if len(samples) == 0 {
		return "", "", nil
	}

	// C に渡す
	cSamples := (*C.float)(unsafe.Pointer(&samples[0]))
	cLang := C.CString(lang)
	defer C.free(unsafe.Pointer(cLang))

	// グロッサリーヒントのみを initial_prompt として使用する。
	// 過去の発話テキストは含めない（Whisper の無音時 hallucination を防ぐため）。
	combinedPrompt := strings.TrimSpace(s.glossary.WhisperHints())
	s.logVerbose("whisper initial_prompt: %q", combinedPrompt)
	cPrompt := C.CString(combinedPrompt)
	defer C.free(unsafe.Pointer(cPrompt))

	const outSize = 8192
	outBuf := (*C.char)(C.malloc(outSize))
	defer C.free(unsafe.Pointer(outBuf))

	const langBufSize = 16
	langBuf := (*C.char)(C.malloc(langBufSize))
	defer C.free(unsafe.Pointer(langBuf))

	const errSize = 512
	errBuf := (*C.char)(C.malloc(errSize))
	defer C.free(unsafe.Pointer(errBuf))

	ret := C.whisper_bridge_transcribe(
		s.whisperCtx,
		cSamples, C.int(len(samples)),
		cLang,
		cPrompt,
		outBuf, C.int(outSize),
		langBuf, C.int(langBufSize),
		errBuf, C.int(errSize),
	)
	if ret != 0 {
		return "", "", fmt.Errorf("whisper_bridge_transcribe failed: %s", C.GoString(errBuf))
	}

	result := strings.TrimSpace(C.GoString(outBuf))
	detectedLang := strings.TrimSpace(C.GoString(langBuf))
	s.logVerbose("whisper raw output: %q, detected_lang: %q", result, detectedLang)
	// 辞書の修正テーブルを適用 (ASR 誤認識を既知のパターンで修正)
	result = s.glossary.ApplyCorrections(result)
	return result, detectedLang, nil
}
