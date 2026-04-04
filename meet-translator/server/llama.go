// llama.go – llama.cpp CGo ブリッジを使った翻訳
//
// Ollama の代わりに llama.cpp を Go バイナリに直接組み込む。
// モデルは起動時に一度だけロードし、server 構造体で保持する。
// リクエスト毎に llama_model フィールドでモデルをホットスワップ可能。

package main

/*
#cgo CFLAGS:   -I./vendor/llama.cpp/include -I./vendor/whisper.cpp/include -I./vendor/llama.cpp/ggml/include
#cgo CXXFLAGS: -I./vendor/llama.cpp/include -I./vendor/whisper.cpp/include -I./vendor/llama.cpp/ggml/include
#include "llama_bridge.h"
#include <stdlib.h>
*/
import "C"

import (
"fmt"
"strings"
"unsafe"
)

// initLlamaBackend はプロセス起動時に一度だけ呼ぶ。
func initLlamaBackend() {
C.llama_bridge_backend_init()
}

// freeLlamaBackend はプロセス終了時に一度だけ呼ぶ。
func freeLlamaBackend() {
C.llama_bridge_backend_free()
}

// loadLlamaModel は GGUF モデルをロードしてハンドルを返す。
// nGPULayers: 0 = CPU only, -1 = 全レイヤを GPU にオフロード
func loadLlamaModel(modelPath string, nGPULayers int) (C.llama_bridge_model, error) {
cpath := C.CString(modelPath)
defer C.free(unsafe.Pointer(cpath))

h := C.llama_bridge_load_model(cpath, C.int(nGPULayers))
if h == nil {
return nil, fmt.Errorf("failed to load llama model: %s", modelPath)
}
return h, nil
}

// translateInternal は llama.cpp でテキストを翻訳して返す。
// opts にモデル固有のオプション (thinking 等) を指定する。
func (s *server) translateInternal(text, sourceLang, targetLang string, opts ModelOptions) (string, error) {
if s.llamaModel == nil {
return "", fmt.Errorf("llama model not initialized")
}

template := templateFor(s.loadedModelSpec)
prompt := buildTranslationPrompt(text, sourceLang, targetLang, template, opts)

cPrompt := C.CString(prompt)
defer C.free(unsafe.Pointer(cPrompt))

const outSize = 4096
outBuf := (*C.char)(C.malloc(outSize))
defer C.free(unsafe.Pointer(outBuf))

const errSize = 512
errBuf := (*C.char)(C.malloc(errSize))
defer C.free(unsafe.Pointer(errBuf))

ret := C.llama_bridge_generate(
s.llamaModel,
cPrompt,
C.int(512),   // max_tokens
C.float(0.1), // temperature
outBuf, C.int(outSize),
errBuf, C.int(errSize),
)
if ret != 0 {
return "", fmt.Errorf("llama_bridge_generate failed (code=%d): %s", int(ret), C.GoString(errBuf))
}

result := strings.TrimSpace(C.GoString(outBuf))
if opts.Thinking {
result = stripThinkingTokens(result)
}
return result, nil
}
