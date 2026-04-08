package main

import (
	"errors"
	"testing"
	"time"
)

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
