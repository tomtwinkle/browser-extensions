package main

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// inferenceOperationTiming is an explicit content-free wire projection. These
// durations come from server monotonic elapsed time, not browser/server clock
// subtraction. Execution covers the entire synchronous gated callback,
// including preprocessing or model swaps; it is not GPU-only execution time.
type inferenceOperationTiming struct {
	OperationID          string `json:"operation_id"`
	QueueWaitMS          int64  `json:"queue_wait_ms"`
	ExecutionMS          int64  `json:"execution_ms"`
	ModelOwnershipWaitMS *int64 `json:"model_ownership_wait_ms,omitempty"`
}

type inferenceResponseTiming struct {
	SchemaVersion int                       `json:"schema_version"`
	ASR           *inferenceOperationTiming `json:"asr,omitempty"`
	Translation   *inferenceOperationTiming `json:"translation,omitempty"`
}

type translationResponse struct {
	Translation     string                   `json:"translation"`
	InferenceTiming *inferenceResponseTiming `json:"inference_timing,omitempty"`
}

func newInferenceOperationTiming(timing inferenceTiming, ownershipWait *time.Duration) *inferenceOperationTiming {
	if timing.StartedAt.IsZero() || timing.FinishedAt.IsZero() || timing.QueueWait < 0 || timing.Execution < 0 ||
		(ownershipWait != nil && *ownershipWait < 0) {
		return nil
	}
	// Generate an ID once per successful executed operation, never from request
	// identity, text, configuration, a model path, or an authentication token.
	var operationID [16]byte
	if _, err := rand.Read(operationID[:]); err != nil {
		// Optional diagnostics must not fail an otherwise successful operation.
		return nil
	}
	result := &inferenceOperationTiming{
		OperationID: hex.EncodeToString(operationID[:]),
		QueueWaitMS: timing.QueueWait.Milliseconds(),
		ExecutionMS: timing.Execution.Milliseconds(),
	}
	if ownershipWait != nil {
		milliseconds := ownershipWait.Milliseconds()
		result.ModelOwnershipWaitMS = &milliseconds
	}
	return result
}

func newInferenceResponseTiming(asr, translation *inferenceOperationTiming) *inferenceResponseTiming {
	if asr == nil && translation == nil {
		return nil
	}
	return &inferenceResponseTiming{SchemaVersion: 1, ASR: asr, Translation: translation}
}
