package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type inferenceGateWork struct {
	kind    string
	release chan struct{}
}

type inferenceGateTestBackend struct {
	generate func(string) (string, error)
}

func (b inferenceGateTestBackend) Generate(prompt string, _ int, _ float32) (string, error) {
	return b.generate(prompt)
}

func (inferenceGateTestBackend) Close() error { return nil }

func waitForInferenceWaiters(t *testing.T, gate *inferenceGate, minimum int64) {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for gate.waiting.Load() < minimum {
		select {
		case <-timer.C:
			t.Fatalf("inference waiters = %d, want at least %d", gate.waiting.Load(), minimum)
		default:
			time.Sleep(time.Millisecond)
		}
	}
}

func TestInferenceGateSerializesTwentyASRAndTwentyTranslationRequests(t *testing.T) {
	const perKind = 20
	const total = perKind * 2
	started := make(chan inferenceGateWork, total)
	releaseAll := make(chan struct{})
	callbackDone := make(chan struct{}, total)
	handlerDone := make(chan error, total)
	var active atomic.Int64
	var maximum atomic.Int64
	var handlers sync.WaitGroup

	enter := func(kind string) {
		current := active.Add(1)
		for previous := maximum.Load(); current > previous && !maximum.CompareAndSwap(previous, current); previous = maximum.Load() {
		}
		work := inferenceGateWork{kind: kind, release: make(chan struct{})}
		started <- work
		select {
		case <-work.release:
		case <-releaseAll:
		}
		active.Add(-1)
		callbackDone <- struct{}{}
	}

	s := newTestServer(t, mockFuncs{
		transcribe: func([]byte, string) (string, string, error) {
			enter("asr")
			return "source", "ja", nil
		},
		translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
			enter("translation")
			return "translation", nil
		},
	})
	defer func() {
		close(releaseAll)
		done := make(chan struct{})
		go func() {
			handlers.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("request handlers did not finish after releasing test callbacks")
		}
	}()

	start := make(chan struct{})
	for i := 0; i < perKind; i++ {
		req := buildAudioFormForPath(t, "/transcribe", nil, fakeWAV)
		w := httptest.NewRecorder()
		handlers.Add(1)
		go func() {
			defer handlers.Done()
			<-start
			s.handleTranscribe(w, req)
			if w.Code != http.StatusOK {
				handlerDone <- fmt.Errorf("ASR response status = %d, body = %s", w.Code, w.Body.String())
				return
			}
			handlerDone <- nil
		}()

		form := url.Values{"text": {fmt.Sprintf("translation source %02d", i)}, "source_lang": {"en"}, "target_lang": {"ja"}}
		translationRequest := httptest.NewRequest(http.MethodPost, "/translate", strings.NewReader(form.Encode()))
		translationRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		translationResponse := httptest.NewRecorder()
		handlers.Add(1)
		go func() {
			defer handlers.Done()
			<-start
			s.handleTranslate(translationResponse, translationRequest)
			if translationResponse.Code != http.StatusOK {
				handlerDone <- fmt.Errorf("translation response status = %d, body = %s", translationResponse.Code, translationResponse.Body.String())
				return
			}
			handlerDone <- nil
		}()
	}
	close(start)

	first := <-started
	waitForInferenceWaiters(t, s.inferenceGate, 1)
	if current := active.Load(); current != 1 {
		t.Fatalf("active inference before releasing first call = %d, want 1", current)
	}

	counts := map[string]int{first.kind: 1}
	close(first.release)
	<-callbackDone
	for entered := 1; entered < total; entered++ {
		work := <-started
		if current := active.Load(); current != 1 {
			t.Fatalf("active inference at callback %d = %d, want 1", entered+1, current)
		}
		counts[work.kind]++
		close(work.release)
		<-callbackDone
	}
	for i := 0; i < total; i++ {
		if err := <-handlerDone; err != nil {
			t.Error(err)
		}
	}
	if counts["asr"] != perKind || counts["translation"] != perKind {
		t.Fatalf("inference call counts = %#v, want %d ASR and %d translations", counts, perKind, perKind)
	}
	if got := maximum.Load(); got != 1 {
		t.Fatalf("max(active inference) = %d, want 1", got)
	}
}

func TestInferenceGateCoversEveryProductionInferenceEntrypoint(t *testing.T) {
	transcript := "The team discussed several important changes during the meeting."
	cases := []struct {
		name        string
		wantStages  []string
		makeRequest func(*testing.T) *http.Request
		invoke      func(*server, http.ResponseWriter, *http.Request) error
	}{
		{
			name:       "transcribe",
			wantStages: []string{"asr"},
			makeRequest: func(t *testing.T) *http.Request {
				return buildAudioFormForPath(t, "/transcribe", nil, fakeWAV)
			},
			invoke: func(s *server, w http.ResponseWriter, r *http.Request) error {
				s.ServeHTTP(w, r)
				return nil
			},
		},
		{
			name:       "translate",
			wantStages: []string{"translation"},
			makeRequest: func(*testing.T) *http.Request {
				return translationFormRequest(map[string]string{
					"text": transcript, "source_lang": "en", "target_lang": "ja",
				}, nil)
			},
			invoke: func(s *server, w http.ResponseWriter, r *http.Request) error {
				s.ServeHTTP(w, r)
				return nil
			},
		},
		{
			name:       "transcribe-and-translate",
			wantStages: []string{"asr", "translation"},
			makeRequest: func(t *testing.T) *http.Request {
				return buildAudioFormForPath(t, "/transcribe-and-translate", map[string]string{
					"source_lang": "en", "target_lang": "ja",
				}, fakeWAV)
			},
			invoke: func(s *server, w http.ResponseWriter, r *http.Request) error {
				s.ServeHTTP(w, r)
				return nil
			},
		},
		{
			name:       "raw-llm-generation",
			wantStages: []string{"raw"},
			invoke: func(s *server, _ http.ResponseWriter, _ *http.Request) error {
				_, err := s.generateRaw("test raw prompt")
				return err
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			releaseAll := make(chan struct{})
			t.Cleanup(func() { close(releaseAll) })
			started := make(chan string, len(tc.wantStages)+1)
			callbackDone := make(chan struct{}, len(tc.wantStages)+1)
			releaseStage := make(chan struct{}, len(tc.wantStages))
			var active atomic.Int64
			enter := func(stage string) {
				active.Add(1)
				started <- stage
				select {
				case <-releaseStage:
				case <-releaseAll:
				case <-time.After(5 * time.Second):
					t.Errorf("%s callback was not released", stage)
				}
				active.Add(-1)
				callbackDone <- struct{}{}
			}

			s := newTestServer(t, mockFuncs{
				transcribe: func([]byte, string) (string, string, error) {
					enter("asr")
					return transcript, "en", nil
				},
				translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
					enter("translation")
					return "チームは会議中に重要な変更をいくつか話し合いました。", nil
				},
			})
			s.llmBackend = inferenceGateTestBackend{generate: func(string) (string, error) {
				enter("raw")
				return "raw result", nil
			}}

			blockerEntered := make(chan struct{})
			blockerRelease := make(chan struct{})
			blockerDone := make(chan error, 1)
			go func() {
				err := s.runInference(context.Background(), "test-blocker", func() error {
					active.Add(1)
					close(blockerEntered)
					select {
					case <-blockerRelease:
					case <-releaseAll:
					}
					active.Add(-1)
					return nil
				})
				blockerDone <- err
			}()
			<-blockerEntered

			var request *http.Request
			if tc.makeRequest != nil {
				request = tc.makeRequest(t)
				request.Host = "127.0.0.1:7070"
				request.Header.Set("Authorization", "Bearer "+testAPIToken)
			}
			response := httptest.NewRecorder()
			requestDone := make(chan error, 1)
			go func() { requestDone <- tc.invoke(s, response, request) }()

			waitDeadline := time.NewTimer(2 * time.Second)
			waitPoll := time.NewTicker(time.Millisecond)
			defer waitDeadline.Stop()
			defer waitPoll.Stop()
			for s.inferenceGate.waiting.Load() == 0 {
				select {
				case stage := <-started:
					t.Fatalf("%s entered inference while another operation held the shared lane", stage)
				case err := <-requestDone:
					if err != nil {
						t.Fatalf("entrypoint returned before inference: %v", err)
					}
					t.Fatal("entrypoint returned without waiting for the held inference lane")
				case <-waitPoll.C:
				case <-waitDeadline.C:
					t.Fatal("entrypoint did not reach the shared inference lane")
				}
			}
			if got := active.Load(); got != 1 {
				t.Fatalf("active operations before blocker release = %d, want 1", got)
			}
			close(blockerRelease)
			if err := <-blockerDone; err != nil {
				t.Fatalf("test blocker error = %v", err)
			}

			for _, want := range tc.wantStages {
				select {
				case got := <-started:
					if got != want {
						t.Fatalf("inference stage = %q, want %q", got, want)
					}
				case <-time.After(2 * time.Second):
					t.Fatalf("%s inference did not start after the lane was released", want)
				}
				if got := active.Load(); got != 1 {
					t.Fatalf("active operations in %s = %d, want 1", want, got)
				}
				// Release one backend callback while keeping later stages blocked.
				releaseStage <- struct{}{}
				<-callbackDone
			}
			if err := <-requestDone; err != nil {
				t.Fatalf("entrypoint error = %v", err)
			}
			if tc.makeRequest != nil && response.Code != http.StatusOK {
				t.Fatalf("HTTP status = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestInferenceGateReportsQueueWaitSeparatelyFromExecution(t *testing.T) {
	gate := newInferenceGate()
	firstEntered := make(chan struct{})
	firstRelease := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		_, err := gate.run(context.Background(), func() error {
			close(firstEntered)
			<-firstRelease
			return nil
		})
		firstDone <- err
	}()
	<-firstEntered

	type result struct {
		timing inferenceTiming
		err    error
	}
	secondDone := make(chan result, 1)
	go func() {
		timing, err := gate.run(context.Background(), func() error { return nil })
		secondDone <- result{timing: timing, err: err}
	}()
	waitForInferenceWaiters(t, gate, 1)
	close(firstRelease)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	got := <-secondDone
	if got.err != nil {
		t.Fatal(got.err)
	}
	if got.timing.QueueWait <= 0 {
		t.Fatalf("queue wait = %s, want a positive wait", got.timing.QueueWait)
	}
	if got.timing.Execution < 0 {
		t.Fatalf("execution duration = %s, want non-negative duration", got.timing.Execution)
	}
	if got.timing.StartedAt.Sub(got.timing.QueuedAt) != got.timing.QueueWait {
		t.Fatalf("queue timing does not match timestamps: %#v", got.timing)
	}
	if got.timing.FinishedAt.Sub(got.timing.StartedAt) != got.timing.Execution {
		t.Fatalf("execution timing does not match timestamps: %#v", got.timing)
	}
}

func TestInferenceGateErrorReleasesPermit(t *testing.T) {
	gate := newInferenceGate()
	want := errors.New("backend failed")
	if _, err := gate.run(context.Background(), func() error { return want }); !errors.Is(err, want) {
		t.Fatalf("run error = %v, want %v", err, want)
	}

	called := false
	if _, err := gate.run(context.Background(), func() error { called = true; return nil }); err != nil {
		t.Fatalf("following operation error = %v", err)
	}
	if !called {
		t.Fatal("following operation did not run after backend error")
	}
}

func TestInferenceGatePanicReturnsGenericErrorAndReleasesPermit(t *testing.T) {
	gate := newInferenceGate()
	_, err := gate.run(context.Background(), func() error {
		panic("secret prompt content")
	})
	if !errors.Is(err, errInferenceOperationPanicked) {
		t.Fatalf("panic error = %v, want generic inference panic error", err)
	}
	if strings.Contains(err.Error(), "secret prompt content") {
		t.Fatalf("panic error leaked panic contents: %v", err)
	}

	called := false
	if _, err := gate.run(context.Background(), func() error { called = true; return nil }); err != nil {
		t.Fatalf("following operation error = %v", err)
	}
	if !called {
		t.Fatal("following operation did not run after backend panic")
	}
}

func TestInferenceGateTimeoutWhileWaitingKeepsNativeOperationExclusive(t *testing.T) {
	gate := newInferenceGate()
	nativeStarted := make(chan struct{})
	nativeFinished := make(chan struct{})
	go func() {
		_, _ = gate.run(context.Background(), func() error {
			close(nativeStarted)
			<-nativeFinished
			return nil
		})
	}()
	<-nativeStarted

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	waitingResult := make(chan error, 1)
	go func() {
		_, err := gate.run(timeoutCtx, func() error {
			return errors.New("timed-out waiter must not start")
		})
		waitingResult <- err
	}()
	waitForInferenceWaiters(t, gate, 1)
	<-timeoutCtx.Done()
	if err := <-waitingResult; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timed-out wait error = %v, want deadline exceeded", err)
	}

	secondStarted := make(chan struct{})
	secondDone := make(chan error, 1)
	go func() {
		_, err := gate.run(context.Background(), func() error { close(secondStarted); return nil })
		secondDone <- err
	}()
	waitForInferenceWaiters(t, gate, 1)
	select {
	case <-secondStarted:
		t.Fatal("another inference started before native operation returned")
	default:
	}
	close(nativeFinished)
	select {
	case <-secondStarted:
	case <-time.After(time.Second):
		t.Fatal("following inference did not start after native completion")
	}
	if err := <-secondDone; err != nil {
		t.Fatal(err)
	}
}

func TestInferenceGateCanceledWaiterDoesNotCancelOtherWork(t *testing.T) {
	gate := newInferenceGate()
	nativeStarted := make(chan struct{})
	nativeFinished := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		_, err := gate.run(context.Background(), func() error {
			close(nativeStarted)
			<-nativeFinished
			return nil
		})
		firstDone <- err
	}()
	<-nativeStarted

	waitCtx, cancel := context.WithCancel(context.Background())
	waiterCalled := atomic.Bool{}
	waiterDone := make(chan error, 1)
	go func() {
		_, err := gate.run(waitCtx, func() error { waiterCalled.Store(true); return nil })
		waiterDone <- err
	}()
	waitForInferenceWaiters(t, gate, 1)
	cancel()
	if err := <-waiterDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled waiter error = %v, want context canceled", err)
	}
	if waiterCalled.Load() {
		t.Fatal("canceled waiter entered inference")
	}
	if got := gate.waiting.Load(); got != 0 {
		t.Fatalf("waiting count after cancel = %d, want 0", got)
	}

	followingStarted := make(chan struct{})
	followingDone := make(chan error, 1)
	go func() {
		_, err := gate.run(context.Background(), func() error { close(followingStarted); return nil })
		followingDone <- err
	}()
	waitForInferenceWaiters(t, gate, 1)
	select {
	case <-followingStarted:
		t.Fatal("following inference started while existing native operation was active")
	default:
	}
	close(nativeFinished)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	select {
	case <-followingStarted:
	case <-time.After(time.Second):
		t.Fatal("following inference did not start after native completion")
	}
	if err := <-followingDone; err != nil {
		t.Fatal(err)
	}
}

func TestInferenceGateRunningCancellationRetainsPermitUntilNativeReturn(t *testing.T) {
	gate := newInferenceGate()
	requestCtx, cancel := context.WithCancel(context.Background())
	nativeStarted := make(chan struct{})
	nativeFinished := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		_, err := gate.run(requestCtx, func() error {
			close(nativeStarted)
			<-nativeFinished
			return nil
		})
		firstDone <- err
	}()
	<-nativeStarted
	cancel()

	nextStarted := make(chan struct{})
	nextDone := make(chan error, 1)
	go func() {
		_, err := gate.run(context.Background(), func() error { close(nextStarted); return nil })
		nextDone <- err
	}()
	waitForInferenceWaiters(t, gate, 1)
	select {
	case <-nextStarted:
		t.Fatal("next inference started before canceled native operation returned")
	default:
	}
	close(nativeFinished)
	if err := <-firstDone; err != nil {
		t.Fatalf("running native call was canceled before returning: %v", err)
	}
	select {
	case <-nextStarted:
	case <-time.After(time.Second):
		t.Fatal("next inference did not start after canceled call returned")
	}
	if err := <-nextDone; err != nil {
		t.Fatal(err)
	}
}

func TestInferenceGateSessionSwitchWaitsForOldNativeOperation(t *testing.T) {
	gate := newInferenceGate()
	oldSessionCtx, cancelOldSession := context.WithCancel(context.Background())
	oldNativeStarted := make(chan struct{})
	oldNativeFinished := make(chan struct{})
	oldDone := make(chan error, 1)
	go func() {
		_, err := gate.run(oldSessionCtx, func() error {
			close(oldNativeStarted)
			<-oldNativeFinished
			return nil
		})
		oldDone <- err
	}()
	<-oldNativeStarted

	cancelOldSession()
	newSessionStarted := make(chan struct{})
	newSessionDone := make(chan error, 1)
	go func() {
		_, err := gate.run(context.Background(), func() error { close(newSessionStarted); return nil })
		newSessionDone <- err
	}()
	waitForInferenceWaiters(t, gate, 1)
	select {
	case <-newSessionStarted:
		t.Fatal("new session inference overlapped an old session's native operation")
	default:
	}
	close(oldNativeFinished)
	if err := <-oldDone; err != nil {
		t.Fatalf("old native operation returned error after session switch: %v", err)
	}
	select {
	case <-newSessionStarted:
	case <-time.After(time.Second):
		t.Fatal("new session did not start after old native operation returned")
	}
	if err := <-newSessionDone; err != nil {
		t.Fatal(err)
	}
}

func TestInferenceGateCloseWaitsForActiveOperationAndRejectsNewWork(t *testing.T) {
	gate := newInferenceGate()
	started := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		_, _ = gate.run(context.Background(), func() error { close(started); <-finished; return nil })
	}()
	<-started
	closed := make(chan struct{})
	go func() { gate.closeAndWait(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("close returned while native operation was active")
	case <-time.After(10 * time.Millisecond):
	}
	close(finished)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("close did not finish after active operation returned")
	}
	called := false
	if _, err := gate.run(context.Background(), func() error { called = true; return nil }); !errors.Is(err, errInferenceGateClosed) {
		t.Fatalf("closed gate error = %v, want %v", err, errInferenceGateClosed)
	}
	if called {
		t.Fatal("operation ran after gate closed")
	}
}

func TestLlamaOperationWaitCanBeCanceledBeforeModelLock(t *testing.T) {
	s := newTestServer(t, mockFuncs{})
	if err := s.startLlamaOp(context.Background()); err != nil {
		t.Fatal(err)
	}

	waitCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	waiterDone := make(chan error, 1)
	go func() {
		err := s.startLlamaOp(waitCtx)
		if err == nil {
			s.endLlamaOp()
		}
		waiterDone <- err
	}()

	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for s.llamaOperationGate.waiting.Load() == 0 {
		select {
		case <-timer.C:
			t.Fatal("translation request did not enter the model-operation wait")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	cancel()
	if err := <-waiterDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled model-operation wait error = %v, want context canceled", err)
	}
	if got := s.llamaOperationGate.waiting.Load(); got != 0 {
		t.Fatalf("model-operation waiters after cancellation = %d, want 0", got)
	}

	s.endLlamaOp()
	if err := s.startLlamaOp(context.Background()); err != nil {
		t.Fatalf("model-operation gate did not recover after cancellation: %v", err)
	}
	s.endLlamaOp()
}
