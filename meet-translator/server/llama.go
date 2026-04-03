// llama.go – llama.cpp CGo ブリッジを使った翻訳
//
// Ollama の代わりに llama.cpp を Go バイナリに直接組み込む。
// モデルは起動時に一度だけロードし、server 構造体で保持する。

package main

/*
#include "llama_bridge.h"
#include <stdlib.h>
*/
import "C"

import (
"fmt"
"strings"
"unsafe"
)

var langNames = map[string]string{
"ja": "Japanese", "en": "English",    "zh": "Chinese",
"ko": "Korean",   "fr": "French",     "de": "German",
"es": "Spanish",  "pt": "Portuguese", "ru": "Russian",
"ar": "Arabic",   "it": "Italian",    "nl": "Dutch",
}

func langLabel(code string) string {
if n, ok := langNames[code]; ok {
return n
}
if code == "" {
return "the detected language"
}
return code
}

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
return nil, fmt.Errorf("llama モデルのロードに失敗: %s", modelPath)
}
return h, nil
}

// translate は llama.cpp でテキストを翻訳して返す。
func (s *server) translate(text, sourceLang, targetLang, _ string) (string, error) {
if s.llamaModel == nil {
return "", fmt.Errorf("llama モデルが初期化されていません")
}

prompt := buildTranslationPrompt(text, sourceLang, targetLang)

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
return "", fmt.Errorf("llama_bridge_generate 失敗 (code=%d): %s", int(ret), C.GoString(errBuf))
}

return strings.TrimSpace(C.GoString(outBuf)), nil
}

func buildTranslationPrompt(text, sourceLang, targetLang string) string {
src := langLabel(sourceLang)
tgt := langLabel(targetLang)
// Qwen2.5 / Llama-3 チャットテンプレートに合わせたプロンプト
return fmt.Sprintf(
"<|im_start|>system\nYou are a translator. Translate the given text accurately. Output only the translated text.<|im_end|>\n"+
"<|im_start|>user\nTranslate from %s to %s:\n%s<|im_end|>\n"+
"<|im_start|>assistant\n",
src, tgt, text,
)
}
