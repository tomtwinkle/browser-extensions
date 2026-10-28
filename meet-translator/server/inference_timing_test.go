package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Decode the wire contract independently of the implementation's response
// structs. These assertions also guard the content-free metadata allowlist.
func requireInferenceResponseStage(t *testing.T, response *httptest.ResponseRecorder, stage string) map[string]json.RawMessage {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("response status = %d, want 200", response.Code)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(body["inference_timing"], &envelope); err != nil {
		t.Fatalf("missing or invalid inference_timing: %v", err)
	}
	var version int
	if err := json.Unmarshal(envelope["schema_version"], &version); err != nil || version != 1 {
		t.Fatalf("inference timing schema version = %d, error = %v", version, err)
	}
	for key := range envelope {
		if key != "schema_version" && key != "asr" && key != "translation" {
			t.Fatalf("unexpected inference timing envelope key %q", key)
		}
	}
	var timing map[string]json.RawMessage
	if err := json.Unmarshal(envelope[stage], &timing); err != nil {
		t.Fatalf("missing or invalid %s timing: %v", stage, err)
	}
	wantFields := map[string]bool{"operation_id": true, "queue_wait_ms": true, "execution_ms": true}
	if stage == "translation" {
		wantFields["model_ownership_wait_ms"] = true
	}
	if len(timing) != len(wantFields) {
		t.Fatalf("%s timing has %d fields, want %d: %v", stage, len(timing), len(wantFields), timing)
	}
	for key := range timing {
		if !wantFields[key] {
			t.Fatalf("unexpected %s timing field %q", stage, key)
		}
	}
	var operationID string
	if err := json.Unmarshal(timing["operation_id"], &operationID); err != nil ||
		!regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(operationID) {
		t.Fatalf("invalid content-free operation ID %q, error = %v", operationID, err)
	}
	for _, key := range []string{"queue_wait_ms", "execution_ms", "model_ownership_wait_ms"} {
		if key == "model_ownership_wait_ms" && stage != "translation" {
			continue
		}
		var duration int64
		if err := json.Unmarshal(timing[key], &duration); err != nil || duration < 0 {
			t.Fatalf("invalid nonnegative integer %s = %s, error = %v", key, timing[key], err)
		}
	}
	return timing
}

func inferenceResponseDuration(t *testing.T, timing map[string]json.RawMessage, key string) int64 {
	t.Helper()
	var duration int64
	if err := json.Unmarshal(timing[key], &duration); err != nil {
		t.Fatalf("decode %s: %v", key, err)
	}
	return duration
}

func awaitInferenceTimingSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func TestInferenceTimingSeparatesHandlerQueueFromExecution(t *testing.T) {
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseFirst) }) }
	t.Cleanup(release)
	var calls atomic.Int32
	backendDuration := make(chan time.Duration, 1)
	s := newTestServer(t, mockFuncs{transcribe: func([]byte, string) (string, string, error) {
		if calls.Add(1) == 1 {
			close(firstEntered)
			<-releaseFirst
		} else {
			started := time.Now()
			time.Sleep(5 * time.Millisecond)
			backendDuration <- time.Since(started)
		}
		return "A deterministic synthetic transcription.", "en", nil
	}})
	firstRequest := buildAudioFormForPath(t, "/transcribe", nil, fakeWAV)
	firstResponse := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() { defer close(firstDone); s.handleTranscribe(firstResponse, firstRequest) }()
	awaitInferenceTimingSignal(t, firstEntered, "first ASR entry")
	secondRequest := buildAudioFormForPath(t, "/transcribe", nil, fakeWAV)
	secondResponse := httptest.NewRecorder()
	secondDone := make(chan struct{})
	go func() { defer close(secondDone); s.handleTranscribe(secondResponse, secondRequest) }()
	waitForInferenceWaiters(t, s.inferenceGate, 1)
	// Deliberately separate queue time from the short synchronous backend call.
	time.Sleep(80 * time.Millisecond)
	release()
	awaitInferenceTimingSignal(t, firstDone, "first ASR response")
	awaitInferenceTimingSignal(t, secondDone, "queued ASR response")
	timing := requireInferenceResponseStage(t, secondResponse, "asr")
	if wait := inferenceResponseDuration(t, timing, "queue_wait_ms"); wait < 75 {
		t.Fatalf("server queue wait = %d ms, want the controlled wait", wait)
	}
	backendMS := (<-backendDuration).Milliseconds()
	executionMS := inferenceResponseDuration(t, timing, "execution_ms")
	if executionMS < backendMS {
		t.Fatalf("gated execution = %d ms, must include the %d ms backend call", executionMS, backendMS)
	}
	firstTiming := requireInferenceResponseStage(t, firstResponse, "asr")
	if string(firstTiming["operation_id"]) == string(timing["operation_id"]) {
		t.Fatal("different backend operations reused an operation ID")
	}
}

func TestInferenceTimingSeparatesTranslationOwnershipAndGateWait(t *testing.T) {
	s := newTestServer(t, mockFuncs{})
	if err := s.startLlamaOp(context.Background()); err != nil {
		t.Fatal(err)
	}
	var ownershipOnce sync.Once
	releaseOwnership := func() { ownershipOnce.Do(s.endLlamaOp) }
	t.Cleanup(releaseOwnership)
	blockerEntered := make(chan struct{})
	releaseBlocker := make(chan struct{})
	var blockerOnce sync.Once
	releaseGate := func() { blockerOnce.Do(func() { close(releaseBlocker) }) }
	t.Cleanup(releaseGate)
	blockerDone := make(chan struct{})
	go func() {
		defer close(blockerDone)
		_ = s.runInference(context.Background(), "test-blocker", func() error {
			close(blockerEntered)
			<-releaseBlocker
			return nil
		})
	}()
	awaitInferenceTimingSignal(t, blockerEntered, "inference blocker")
	response := httptest.NewRecorder()
	request := translationFormRequest(map[string]string{"text": "synthetic source"}, nil)
	done := make(chan struct{})
	go func() { defer close(done); s.handleTranslate(response, request) }()
	deadline := time.Now().Add(5 * time.Second)
	for s.llamaOperationGate.waiting.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("translation did not wait for model ownership")
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(30 * time.Millisecond)
	releaseOwnership()
	waitForInferenceWaiters(t, s.inferenceGate, 1)
	time.Sleep(30 * time.Millisecond)
	releaseGate()
	awaitInferenceTimingSignal(t, blockerDone, "inference blocker completion")
	awaitInferenceTimingSignal(t, done, "translation response")
	timing := requireInferenceResponseStage(t, response, "translation")
	if got := inferenceResponseDuration(t, timing, "model_ownership_wait_ms"); got < 25 {
		t.Fatalf("model ownership wait = %d ms, want controlled wait", got)
	}
	if got := inferenceResponseDuration(t, timing, "queue_wait_ms"); got < 25 {
		t.Fatalf("inference gate wait = %d ms, want controlled wait", got)
	}
}

func TestInferenceTimingCombinedResponseDistinguishesExecutedStages(t *testing.T) {
	for _, emptyASR := range []bool{false, true} {
		t.Run(map[bool]string{false: "asr-and-translation", true: "asr-only"}[emptyASR], func(t *testing.T) {
			var translationCalls int
			s := newTestServer(t, mockFuncs{
				transcribe: func([]byte, string) (string, string, error) {
					if emptyASR {
						return "", "en", nil
					}
					return "The team discussed several important changes during the meeting.", "en", nil
				},
				translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
					translationCalls++
					return "synthetic translation", nil
				},
			})
			request := buildAudioForm(t, map[string]string{"speech_ms": "5000", "source_lang": "en"}, fakeWAV)
			response := httptest.NewRecorder()
			s.handleTranscribeAndTranslate(response, request)
			asrTiming := requireInferenceResponseStage(t, response, "asr")
			if emptyASR {
				var body struct {
					InferenceTiming map[string]json.RawMessage `json:"inference_timing"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if _, present := body.InferenceTiming["translation"]; present || translationCalls != 0 {
					t.Fatal("skipped translation must not have timing or execute")
				}
				return
			}
			translationTiming := requireInferenceResponseStage(t, response, "translation")
			if translationCalls != 1 || string(asrTiming["operation_id"]) == string(translationTiming["operation_id"]) {
				t.Fatal("combined response must identify two different executed operations")
			}
		})
	}
}

func TestInferenceTimingCanceledBeforeGateDoesNotExecuteOrExport(t *testing.T) {
	var calls atomic.Int32
	s := newTestServer(t, mockFuncs{transcribe: func([]byte, string) (string, string, error) {
		calls.Add(1)
		return "must not execute", "en", nil
	}})
	entered := make(chan struct{})
	releaseBlocker := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(releaseBlocker) }) }
	t.Cleanup(release)
	blockerDone := make(chan struct{})
	go func() {
		defer close(blockerDone)
		_ = s.runInference(context.Background(), "test-blocker", func() error {
			close(entered)
			<-releaseBlocker
			return nil
		})
	}()
	awaitInferenceTimingSignal(t, entered, "inference blocker")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := buildAudioFormForPath(t, "/transcribe", nil, fakeWAV).WithContext(ctx)
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); s.handleTranscribe(response, request) }()
	waitForInferenceWaiters(t, s.inferenceGate, 1)
	cancel()
	awaitInferenceTimingSignal(t, done, "canceled request")
	if calls.Load() != 0 || response.Body.Len() != 0 {
		t.Fatalf("canceled request: backend calls = %d, body bytes = %d", calls.Load(), response.Body.Len())
	}
	release()
	awaitInferenceTimingSignal(t, blockerDone, "blocker completion")
}

func TestInferenceTimingSharedTranslationSurvivesOwnerCancellation(t *testing.T) {
	entered := make(chan struct{})
	releaseBackend := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(releaseBackend) }) }
	t.Cleanup(release)
	var calls atomic.Int32
	s := newTestServer(t, mockFuncs{translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
		if calls.Add(1) == 1 {
			close(entered)
		}
		<-releaseBackend
		return "shared synthetic result", nil
	}})
	fields := map[string]string{
		"text": "source", "source_text": "source", "source_lang": "en", "target_lang": "ja",
		"session_id": "session-a", "audio_source": "tab", "stream_generation": "4",
		"segment_id": "segment-a", "source_revision": "1",
	}
	ownerCtx, cancelOwner := context.WithCancel(context.Background())
	defer cancelOwner()
	ownerDone := make(chan struct{})
	go func() {
		defer close(ownerDone)
		s.handleTranslate(httptest.NewRecorder(), translationFormRequest(fields, ownerCtx))
	}()
	awaitInferenceTimingSignal(t, entered, "shared translation")
	responses := [2]*httptest.ResponseRecorder{httptest.NewRecorder(), httptest.NewRecorder()}
	done := [2]chan struct{}{make(chan struct{}), make(chan struct{})}
	for i := range responses {
		go func(i int) {
			defer close(done[i])
			s.handleTranslate(responses[i], translationFormRequest(fields, nil))
		}(i)
	}
	waitForActiveTranslationWaiters(t, s, 3)
	cancelOwner()
	awaitInferenceTimingSignal(t, ownerDone, "canceled owner")
	release()
	for i := range done {
		awaitInferenceTimingSignal(t, done[i], "surviving subscriber")
	}
	first := requireInferenceResponseStage(t, responses[0], "translation")
	second := requireInferenceResponseStage(t, responses[1], "translation")
	if !reflect.DeepEqual(first, second) || calls.Load() != 1 {
		t.Fatalf("coalesced subscribers differ or duplicated inference: calls=%d, first=%v, second=%v", calls.Load(), first, second)
	}
}

func TestInferenceTimingWireMetadataContainsNoRequestOrResponseContent(t *testing.T) {
	const source = "PRIVATE_SOURCE https://meet.google.com/private-room"
	const translated = "PRIVATE_TRANSLATION"
	s := newTestServer(t, mockFuncs{translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
		return translated, nil
	}})
	request := translationFormRequest(map[string]string{
		"text": source, "source_text": source, "session_id": "PRIVATE_SESSION",
		"inference_timing": `{"operation_id":"PRIVATE_INJECTED"}`,
	}, nil)
	response := httptest.NewRecorder()
	s.handleTranslate(response, request)
	requireInferenceResponseStage(t, response, "translation")
	var body map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	metadata := string(body["inference_timing"])
	for _, forbidden := range []string{"PRIVATE_", "meet.google.com", "text", "prompt", "token", "session_id", "path"} {
		if strings.Contains(metadata, forbidden) {
			t.Fatalf("inference metadata contains forbidden content %q", forbidden)
		}
	}
}

func TestInferenceTimingErrorsKeepExistingResponseShape(t *testing.T) {
	s := newTestServer(t, mockFuncs{
		transcribe: func([]byte, string) (string, string, error) { return "", "", errors.New("synthetic failure") },
		translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
			return "", errors.New("synthetic failure")
		},
	})
	for _, endpoint := range []string{"/transcribe", "/transcribe-and-translate", "/translate"} {
		t.Run(endpoint, func(t *testing.T) {
			response := httptest.NewRecorder()
			if endpoint == "/translate" {
				s.handleTranslate(response, translationFormRequest(map[string]string{"text": "synthetic source"}, nil))
			} else if endpoint == "/transcribe" {
				s.handleTranscribe(response, buildAudioFormForPath(t, endpoint, nil, fakeWAV))
			} else {
				s.handleTranscribeAndTranslate(response, buildAudioFormForPath(t, endpoint, nil, fakeWAV))
			}
			if response.Code != http.StatusInternalServerError || !strings.HasPrefix(response.Header().Get("Content-Type"), "text/plain") ||
				strings.Contains(response.Body.String(), "inference_timing") {
				t.Fatalf("error response changed: status=%d type=%q body=%q", response.Code, response.Header().Get("Content-Type"), response.Body.String())
			}
		})
	}
}

func TestInferenceTimingUnstartedOperationHasNoWireProjection(t *testing.T) {
	if got := newInferenceOperationTiming(inferenceTiming{}, nil); got != nil {
		t.Fatalf("unstarted operation received timing: %+v", got)
	}
	if got := newInferenceResponseTiming(nil, nil); got != nil {
		t.Fatalf("no executed operation received an envelope: %+v", got)
	}
	body, err := json.Marshal(translationResponse{Translation: "result"})
	if err != nil || string(body) != `{"translation":"result"}` {
		t.Fatalf("missing optional timing must be omitted: %s, error = %v", body, err)
	}
}

func TestInferenceTimingWireProjectionKeepsDistinctDurationsAndMeasuredZero(t *testing.T) {
	// Synthetic intervals test the wire mapping without imposing a scheduler/GC
	// latency limit on the actual handler's preprocessing and backend callback.
	started := time.Now()
	execution := 7*time.Millisecond + 999*time.Microsecond
	ownership := 13*time.Millisecond + 500*time.Microsecond
	timing := newInferenceOperationTiming(inferenceTiming{
		StartedAt: started, FinishedAt: started.Add(execution),
		QueueWait: 1111*time.Millisecond + 500*time.Microsecond, Execution: execution,
	}, &ownership)
	if timing == nil || timing.QueueWaitMS != 1111 || timing.ExecutionMS != 7 ||
		timing.ModelOwnershipWaitMS == nil || *timing.ModelOwnershipWaitMS != 13 {
		t.Fatalf("distinct measured intervals were lost or conflated: %+v", timing)
	}
	zero := time.Duration(0)
	measuredZero := newInferenceOperationTiming(inferenceTiming{
		StartedAt: started, FinishedAt: started,
	}, &zero)
	if measuredZero == nil || measuredZero.QueueWaitMS != 0 || measuredZero.ExecutionMS != 0 ||
		measuredZero.ModelOwnershipWaitMS == nil || *measuredZero.ModelOwnershipWaitMS != 0 {
		t.Fatalf("measured zero must remain distinct from missing timing: %+v", measuredZero)
	}
}
