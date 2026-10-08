package main

import (
	"context"
	"errors"
	"sync/atomic"
	"time"
)

var errInferenceGateClosed = errors.New("inference gate is closed")
var errInferenceOperationPanicked = errors.New("inference operation panicked")

// inferenceTiming separates time waiting for the shared accelerator from time
// spent inside the synchronous backend call. The values support local verbose
// diagnostics; this structure does not persist evaluation telemetry.
type inferenceTiming struct {
	QueuedAt   time.Time
	StartedAt  time.Time
	FinishedAt time.Time
	QueueWait  time.Duration
	Execution  time.Duration
}

// inferenceGate owns the single shared high-load ASR/LLM inference lane.
// Backend callbacks must return only after native/GPU work has completed; a
// caller timeout cannot release a permit for work that is still running.
type inferenceGate struct {
	permit  chan struct{}
	waiting atomic.Int64
	closed  atomic.Bool
}

// cancellablePermit serializes operations that mutate or use the loaded LLM
// backend while allowing an HTTP waiter to leave before it becomes the owner.
type cancellablePermit struct {
	permit  chan struct{}
	waiting atomic.Int64
}

func newCancellablePermit() *cancellablePermit {
	return &cancellablePermit{permit: make(chan struct{}, 1)}
}

func (g *cancellablePermit) lock(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	g.waiting.Add(1)
	select {
	case g.permit <- struct{}{}:
		g.waiting.Add(-1)
		if err := ctx.Err(); err != nil {
			g.unlock()
			return err
		}
		return nil
	case <-ctx.Done():
		g.waiting.Add(-1)
		return ctx.Err()
	}
}

func (g *cancellablePermit) unlock() {
	<-g.permit
}

func newInferenceGate() *inferenceGate {
	return &inferenceGate{permit: make(chan struct{}, 1)}
}

func (g *inferenceGate) run(ctx context.Context, operation func() error) (inferenceTiming, error) {
	var timing inferenceTiming
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return timing, err
	}
	if g.closed.Load() {
		return timing, errInferenceGateClosed
	}

	timing.QueuedAt = time.Now()
	g.waiting.Add(1)
	select {
	case g.permit <- struct{}{}:
	case <-ctx.Done():
		g.waiting.Add(-1)
		return timing, ctx.Err()
	}
	g.waiting.Add(-1)
	defer func() { <-g.permit }()

	// select may choose the permit at the same time a caller is canceled or the
	// server is closing. Recheck both conditions before entering native code.
	if err := ctx.Err(); err != nil {
		return timing, err
	}
	if g.closed.Load() {
		return timing, errInferenceGateClosed
	}

	timing.StartedAt = time.Now()
	timing.QueueWait = timing.StartedAt.Sub(timing.QueuedAt)
	var operationErr error
	func() {
		defer func() {
			if recover() != nil {
				// Panic values can contain transcript or prompt text. Convert them
				// to a stable error without logging the value or stack.
				operationErr = errInferenceOperationPanicked
			}
		}()
		operationErr = operation()
	}()
	timing.FinishedAt = time.Now()
	timing.Execution = timing.FinishedAt.Sub(timing.StartedAt)
	return timing, operationErr
}

// closeAndWait rejects future work and waits until the active native operation
// has returned before model resources are released.
func (g *inferenceGate) closeAndWait() {
	g.closed.Store(true)
	g.permit <- struct{}{}
	<-g.permit
}
