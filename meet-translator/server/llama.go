// llama.go – llama.cpp CGo ブリッジを使った LLM バックエンド
//
// Ollama の代わりに llama.cpp を Go バイナリに直接組み込む。
// MLX など他バックエンドと同じ llmBackend インターフェースで扱う。

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

type llamaCPPBackend struct {
	model C.llama_bridge_model
}

// newLlamaCPPBackend は GGUF モデルをロードして llama.cpp バックエンドを返す。
// nGPULayers: 0 = CPU only, -1 = 全レイヤを GPU にオフロード
func newLlamaCPPBackend(modelPath string, nGPULayers int) (llmBackend, error) {
	cpath := C.CString(modelPath)
	defer C.free(unsafe.Pointer(cpath))

	h := C.llama_bridge_load_model(cpath, C.int(nGPULayers))
	if h == nil {
		return nil, fmt.Errorf("failed to load llama model: %s", modelPath)
	}
	return &llamaCPPBackend{model: h}, nil
}

func (b *llamaCPPBackend) Generate(prompt string, maxTokens int, temperature float32) (string, error) {
	if b == nil || b.model == nil {
		return "", fmt.Errorf("llama model not initialized")
	}

	cPrompt := C.CString(prompt)
	defer C.free(unsafe.Pointer(cPrompt))

	const outSize = 4096
	outBuf := (*C.char)(C.malloc(outSize))
	defer C.free(unsafe.Pointer(outBuf))

	const errSize = 512
	errBuf := (*C.char)(C.malloc(errSize))
	defer C.free(unsafe.Pointer(errBuf))

	ret := C.llama_bridge_generate(
		b.model,
		cPrompt,
		C.int(maxTokens),
		C.float(temperature),
		outBuf, C.int(outSize),
		errBuf, C.int(errSize),
	)
	if ret != 0 {
		return "", fmt.Errorf("llama_bridge_generate failed (code=%d): %s", int(ret), C.GoString(errBuf))
	}
	return strings.TrimSpace(C.GoString(outBuf)), nil
}

func (b *llamaCPPBackend) Close() error {
	if b == nil || b.model == nil {
		return nil
	}
	C.llama_bridge_free_model(b.model)
	b.model = nil
	return nil
}

// translateInternal はアクティブな LLM バックエンドでテキストを翻訳して返す。
// opts にモデル固有のオプション (thinking 等) を指定する。
// history に直前の発話ペアを渡すと few-shot context として翻訳精度が向上する。
func (s *server) translateInternal(text, sourceLang, targetLang string, opts ModelOptions, history []contextEntry) (string, error) {
	if s.llmBackend == nil {
		return "", fmt.Errorf("llama model not initialized")
	}

	template := templateFor(s.loadedModelSpec)
	// 用語マッピングをプロンプトに注入する
	termsHint := s.glossary.TermsForPrompt()
	prompt := buildTranslationPrompt(text, sourceLang, targetLang, template, opts, history, termsHint)
	s.logVerbose("translate input: %q (model=%s, template=%s, thinking=%v, history=%d, terms=%q)",
		text, s.loadedModelSpec, template, opts.Thinking, len(history), termsHint)

	result, err := s.llmBackend.Generate(prompt, 512, 0.1)
	if err != nil {
		return "", err
	}
	s.logVerbose("llama raw output: %q", result)
	// <think>...</think> ブロックは opts.Thinking に関わらず常に除去する。
	// /no-think を指定しても一部モデルが thinking を出力する場合があるため。
	result = stripThinkingTokens(result)
	result = stripLLMArtifacts(result)
	s.logVerbose("translate output: %q", result)
	return result, nil
}

// generateRaw はテンプレートラッパーなしで生プロンプトを LLM に送る。
// バックグラウンドの GlossaryImprover が解析プロンプトを送るために使用する。
// startLlamaOp/endLlamaOp により通常の翻訳と直列化され、シャットダウン中は拒否される。
func (s *server) generateRaw(prompt string) (string, error) {
	if err := s.startLlamaOp(); err != nil {
		return "", err
	}
	defer s.endLlamaOp()

	if s.llmBackend == nil {
		return "", fmt.Errorf("llama model not initialized")
	}
	s.logVerbose("generateRaw: prompt len=%d", len(prompt))
	return s.llmBackend.Generate(prompt, 1024, 0.1)
}
