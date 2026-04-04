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
return nil, fmt.Errorf("whisper モデルのロードに失敗: %s", modelPath)
}
return ctx, nil
}

// transcribeInternal は WAV バイト列を文字起こしして返す。
func (s *server) transcribeInternal(audioData []byte, lang string) (string, error) {
if s.whisperCtx == nil {
return "", fmt.Errorf("whisper コンテキストが初期化されていません")
}

// WAV をパース → 16kHz float32 に変換
wav, err := parseWAV(bytes.NewReader(audioData))
if err != nil {
return "", fmt.Errorf("WAV パース失敗: %w", err)
}
samples := resampleTo16k(wav.samples, wav.sampleRate)
if len(samples) == 0 {
return "", nil
}

// C に渡す
cSamples := (*C.float)(unsafe.Pointer(&samples[0]))
cLang := C.CString(lang)
defer C.free(unsafe.Pointer(cLang))

const outSize = 8192
outBuf := (*C.char)(C.malloc(outSize))
defer C.free(unsafe.Pointer(outBuf))

const errSize = 512
errBuf := (*C.char)(C.malloc(errSize))
defer C.free(unsafe.Pointer(errBuf))

ret := C.whisper_bridge_transcribe(
s.whisperCtx,
cSamples, C.int(len(samples)),
cLang,
outBuf, C.int(outSize),
errBuf, C.int(errSize),
)
if ret != 0 {
return "", fmt.Errorf("whisper_bridge_transcribe 失敗: %s", C.GoString(errBuf))
}

return strings.TrimSpace(C.GoString(outBuf)), nil
}
