package main

import (
	"errors"
	"testing"
	"time"
)

type stubTranscriber struct {
	closed bool
}

func (s *stubTranscriber) Transcribe([]byte, string, string, func(string, ...any)) (string, string, error) {
	return "", "", nil
}

func (s *stubTranscriber) Close() error {
	s.closed = true
	return nil
}

type stubLLMBackend struct{}

func (s *stubLLMBackend) Generate(string, int, float32) (string, error) { return "", nil }
func (s *stubLLMBackend) Close() error                                  { return nil }

func TestStartLlamaOp_ShuttingDownReturnsError(t *testing.T) {
	s := newTestServer(t, mockFuncs{})
	s.beginShutdown()

	err := s.startLlamaOp()
	if !errors.Is(err, errServerShuttingDown) {
		t.Fatalf("startLlamaOp() error = %v, want %v", err, errServerShuttingDown)
	}
}

func TestReleaseLlamaModel_WaitsForInFlightLlamaOp(t *testing.T) {
	s := newTestServer(t, mockFuncs{})

	if err := s.startLlamaOp(); err != nil {
		t.Fatalf("startLlamaOp() error = %v", err)
	}

	released := make(chan struct{})
	go func() {
		s.releaseLlamaModel()
		close(released)
	}()

	select {
	case <-released:
		t.Fatal("releaseLlamaModel returned before the in-flight llama op completed")
	case <-time.After(50 * time.Millisecond):
	}

	s.endLlamaOp()

	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("releaseLlamaModel did not finish after the in-flight llama op completed")
	}
}

func TestInitializeRuntimeBackends_FreesBackendAfterASRInitFailure(t *testing.T) {
	wantErr := errors.New("asr init failed")
	var initCalled, freeCalled, llmCalled bool

	gotTranscriber, gotLLM, err := initializeRuntimeBackends(
		ResolvedWhisperModel{},
		ResolvedLlamaModel{},
		-1,
		func() { initCalled = true },
		func() { freeCalled = true },
		func(ResolvedWhisperModel) (transcriber, error) {
			return nil, wantErr
		},
		func(ResolvedLlamaModel, int) (llmBackend, error) {
			llmCalled = true
			return &stubLLMBackend{}, nil
		},
	)

	if !errors.Is(err, wantErr) {
		t.Fatalf("initializeRuntimeBackends() error = %v, want %v", err, wantErr)
	}
	if gotTranscriber != nil {
		t.Fatalf("transcriber = %#v, want nil", gotTranscriber)
	}
	if gotLLM != nil {
		t.Fatalf("llm = %#v, want nil", gotLLM)
	}
	if !initCalled {
		t.Fatal("initializeRuntimeBackends() did not initialize the llama backend")
	}
	if !freeCalled {
		t.Fatal("initializeRuntimeBackends() did not free the llama backend after ASR init failure")
	}
	if llmCalled {
		t.Fatal("initializeRuntimeBackends() should not try to load the LLM after ASR init failure")
	}
}

func TestInitializeRuntimeBackends_CleansUpAfterLLMInitFailure(t *testing.T) {
	wantErr := errors.New("mlx_lm missing")
	asr := &stubTranscriber{}
	var initCalled, freeCalled bool

	gotTranscriber, gotLLM, err := initializeRuntimeBackends(
		ResolvedWhisperModel{},
		ResolvedLlamaModel{},
		-1,
		func() { initCalled = true },
		func() { freeCalled = true },
		func(ResolvedWhisperModel) (transcriber, error) {
			return asr, nil
		},
		func(ResolvedLlamaModel, int) (llmBackend, error) {
			return nil, wantErr
		},
	)

	if !errors.Is(err, wantErr) {
		t.Fatalf("initializeRuntimeBackends() error = %v, want %v", err, wantErr)
	}
	if gotTranscriber != nil {
		t.Fatalf("transcriber = %#v, want nil", gotTranscriber)
	}
	if gotLLM != nil {
		t.Fatalf("llm = %#v, want nil", gotLLM)
	}
	if !initCalled {
		t.Fatal("initializeRuntimeBackends() did not initialize the llama backend")
	}
	if !freeCalled {
		t.Fatal("initializeRuntimeBackends() did not free the llama backend after LLM init failure")
	}
	if !asr.closed {
		t.Fatal("initializeRuntimeBackends() did not close the ASR backend after LLM init failure")
	}
}
