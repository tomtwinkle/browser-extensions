package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
)

var errTranslationModelChanged = errors.New("translation model changed before inference started")

// translationRequestIdentity captures the logical source revision and every
// model or context input that defines one in-flight translation. Its JSON
// encoding is hashed before use as a map key, so transcript text is never
// retained in the key or written to logs.
type translationRequestIdentity struct {
	Text                   string
	SourceText             string
	SourceLanguage         string
	TargetLanguage         string
	SessionID              string
	AudioSource            string
	StreamGeneration       string
	SegmentID              string
	SourceRevision         string
	RequestNonce           string
	ContextHistoryRevision string
	GlossaryRevision       string
	RequestedModel         string
	Model                  string
	Runtime                string
	Quantization           string
	Template               string
	DecodeSettings         ModelOptions
	MaxTokens              int
	Temperature            float32
}

func hasStableTranslationIdentity(identity translationRequestIdentity) bool {
	return identity.SessionID != "" && (identity.AudioSource == "mic" || identity.AudioSource == "tab") &&
		identity.StreamGeneration != "" && identity.SegmentID != "" && identity.SourceRevision != "" && identity.SourceText != ""
}

func fingerprintGlossaryTerms(terms string) string {
	digest := sha256.Sum256([]byte(terms))
	return hex.EncodeToString(digest[:])
}

func fingerprintContextHistory(history []contextEntry) string {
	encoded, _ := json.Marshal(history)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func quantizationForModelSpec(spec string) string {
	lower := strings.ToLower(spec)
	for _, quantization := range []string{
		"q1_0_g128", "q2_k", "q3_k_m", "q3_k_s", "q4_k_m", "q4_k_s", "q4_0", "q4_1",
		"q5_k_m", "q5_k_s", "q5_0", "q5_1", "q6_k", "q8_0", "fp8", "bf16", "f16", "4bit", "8bit", "2bit",
	} {
		if strings.Contains(lower, quantization) {
			return quantization
		}
	}
	return "unspecified"
}

func runtimeIdentityForModelSpec(spec string) string {
	// resolveLlamaModel gives an existing file precedence over a registry alias.
	// Check the same condition here so requested-model flight keys describe the
	// backend that swapModel will actually load, without resolving or downloading.
	if _, err := os.Stat(spec); err == nil {
		return runtimeIdentityForResolvedModel(ResolvedLlamaModel{Backend: llmBackendLlamaCPP})
	}
	if entry, ok := llamaRegistry[canonicalLlamaSpec(spec)]; ok && prefersMLX(entry) {
		return runtimeIdentityForResolvedModel(ResolvedLlamaModel{Backend: llmBackendMLX})
	}
	return runtimeIdentityForResolvedModel(ResolvedLlamaModel{Backend: llmBackendLlamaCPP})
}

func runtimeIdentityForResolvedModel(model ResolvedLlamaModel) string {
	return fmt.Sprintf("%s/%s-%s/prism=%t", model.Backend, currentGOOS, currentGOARCH, backendIsPrism)
}

func fingerprintTranslationRequest(identity translationRequestIdentity) string {
	encoded, _ := json.Marshal(identity)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

type translationFlight struct {
	done    chan struct{}
	result  string
	err     error
	waiters int
}

// translationFlightGroup joins only concurrent requests with identical input
// identities. Completed values are removed immediately; this is not a cache.
type translationFlightGroup struct {
	mu      sync.Mutex
	flights map[string]*translationFlight
}

func newTranslationFlightGroup() *translationFlightGroup {
	return &translationFlightGroup{flights: make(map[string]*translationFlight)}
}

func (g *translationFlightGroup) do(ctx context.Context, key string, translate func() (string, error)) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	default:
	}

	g.mu.Lock()
	if g.flights == nil {
		g.flights = make(map[string]*translationFlight)
	}
	if active := g.flights[key]; active != nil {
		active.waiters++
		g.mu.Unlock()
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-active.done:
			return active.result, active.err
		}
	}

	active := &translationFlight{done: make(chan struct{}), waiters: 1}
	g.flights[key] = active
	g.mu.Unlock()

	active.result, active.err = translate()
	g.mu.Lock()
	if g.flights[key] == active {
		delete(g.flights, key)
	}
	close(active.done)
	g.mu.Unlock()
	return active.result, active.err
}

// activeWaiters is kept small and private to support deterministic concurrency
// tests without relying on sleeps to guess when duplicate requests have joined.
func (g *translationFlightGroup) activeWaiters() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	total := 0
	for _, active := range g.flights {
		total += active.waiters
	}
	return total
}

func (g *translationFlightGroup) activeFlightCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.flights)
}
