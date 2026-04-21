package main

import "fmt"

type LLMBackendKind string

const (
	llmBackendLlamaCPP LLMBackendKind = "llama.cpp"
	llmBackendMLX      LLMBackendKind = "mlx"
)

type ResolvedLlamaModel struct {
	Backend      LLMBackendKind
	Spec         string
	ResolvedSpec string
}

type llmBackend interface {
	Generate(prompt string, maxTokens int, temperature float32) (string, error)
	Close() error
}

func newLLMBackend(model ResolvedLlamaModel, nGPULayers int) (llmBackend, error) {
	switch model.Backend {
	case llmBackendLlamaCPP:
		return newLlamaCPPBackend(model.ResolvedSpec, nGPULayers)
	case llmBackendMLX:
		return newPythonMLXBackend(model.ResolvedSpec)
	default:
		return nil, fmt.Errorf("unsupported LLM backend: %s", model.Backend)
	}
}
