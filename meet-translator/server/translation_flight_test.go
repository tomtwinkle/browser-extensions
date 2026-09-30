package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func translationFormRequest(fields map[string]string, ctx context.Context) *http.Request {
	values := make(url.Values, len(fields))
	for key, value := range fields {
		values.Set(key, value)
	}
	req := httptest.NewRequest(http.MethodPost, "/translate", strings.NewReader(values.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if ctx != nil {
		req = req.WithContext(ctx)
	}
	return req
}

func runTranslationRequest(s *server, fields map[string]string, ctx context.Context) (*httptest.ResponseRecorder, error) {
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.handleTranslate(w, translationFormRequest(fields, ctx))
	}()
	select {
	case <-done:
		return w, nil
	case <-time.After(5 * time.Second):
		return w, errors.New("translation request did not finish")
	}
}

func waitForActiveTranslationWaiters(t *testing.T, s *server, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := s.translationFlights.activeWaiters(); got == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("active translation waiters = %d, want %d", s.translationFlights.activeWaiters(), want)
}

func waitForActiveTranslationFlights(t *testing.T, s *server, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := s.translationFlights.activeFlightCount(); got == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("active translation flights = %d, want %d", s.translationFlights.activeFlightCount(), want)
}

func TestHandleTranslateCoalescesTwentyIdenticalRequests(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	s := newTestServer(t, mockFuncs{
		translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
			if calls.Add(1) == 1 {
				close(started)
			}
			<-release
			return "translated once", nil
		},
	})
	fields := map[string]string{
		"text":              "the original utterance",
		"source_text":       "the complete original utterance",
		"source_lang":       "en",
		"target_lang":       "ja",
		"session_id":        "session-a",
		"audio_source":      "tab",
		"stream_generation": "4",
		"segment_id":        "segment-a",
		"source_revision":   "2",
		"llama_options":     `{"thinking":false}`,
	}

	const requestCount = 20
	responses := make([]*httptest.ResponseRecorder, requestCount)
	var wg sync.WaitGroup
	wg.Add(requestCount)
	for i := range requestCount {
		go func(i int) {
			defer wg.Done()
			responses[i], _ = runTranslationRequest(s, fields, nil)
		}(i)
		if i == 0 {
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("translation did not start")
			}
		}
	}
	waitForActiveTranslationWaiters(t, s, requestCount)
	if got := s.translationFlights.activeFlightCount(); got != 1 {
		t.Fatalf("active translation flights = %d, want 1", got)
	}
	close(release)
	waitDone := make(chan struct{})
	go func() { wg.Wait(); close(waitDone) }()
	select {
	case <-waitDone:
	case <-time.After(5 * time.Second):
		t.Fatal("coalesced requests did not finish")
	}

	if got := calls.Load(); got != 1 {
		t.Fatalf("translation calls = %d, want 1", got)
	}
	for i, response := range responses {
		if response == nil || response.Code != http.StatusOK {
			t.Fatalf("request %d response = %#v, want 200", i, response)
		}
		var body map[string]string
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body["translation"] != "translated once" {
			t.Fatalf("request %d response body = %s, err=%v", i, response.Body, err)
		}
	}
	if got := len(s.contextBuf.Entries()); got != 1 {
		t.Fatalf("context entries = %d, want one side effect", got)
	}
}

func TestTranslationFlightKeyIncludesEveryInferenceAndSourceRevisionDimension(t *testing.T) {
	base := translationRequestIdentity{
		Text: "translation input", SourceText: "original utterance", SourceLanguage: "en", TargetLanguage: "ja",
		SessionID: "session-a", AudioSource: "tab", StreamGeneration: "4", SegmentID: "segment-a", SourceRevision: "2",
		ContextHistoryRevision: "history-a", GlossaryRevision: "glossary-a", Model: "model-a-q4", Runtime: "runtime-a", Quantization: "q4",
		Template: "template-a", DecodeSettings: ModelOptions{Thinking: false}, MaxTokens: 512, Temperature: 0.1,
	}
	baseKey := fingerprintTranslationRequest(base)
	cases := []struct {
		name   string
		change func(*translationRequestIdentity)
	}{
		{"translation input", func(v *translationRequestIdentity) { v.Text += " changed" }},
		{"original text", func(v *translationRequestIdentity) { v.SourceText += " changed" }},
		{"source language", func(v *translationRequestIdentity) { v.SourceLanguage = "ja" }},
		{"target language", func(v *translationRequestIdentity) { v.TargetLanguage = "en" }},
		{"session", func(v *translationRequestIdentity) { v.SessionID = "session-b" }},
		{"audio source", func(v *translationRequestIdentity) { v.AudioSource = "mic" }},
		{"stream generation", func(v *translationRequestIdentity) { v.StreamGeneration = "5" }},
		{"segment", func(v *translationRequestIdentity) { v.SegmentID = "segment-b" }},
		{"source revision", func(v *translationRequestIdentity) { v.SourceRevision = "3" }},
		{"request nonce", func(v *translationRequestIdentity) { v.RequestNonce = "request-b" }},
		{"context history", func(v *translationRequestIdentity) { v.ContextHistoryRevision = "history-b" }},
		{"glossary revision", func(v *translationRequestIdentity) { v.GlossaryRevision = "glossary-b" }},
		{"model", func(v *translationRequestIdentity) { v.Model = "model-b-q4" }},
		{"runtime", func(v *translationRequestIdentity) { v.Runtime = "runtime-b" }},
		{"quantization", func(v *translationRequestIdentity) { v.Quantization = "q5" }},
		{"template", func(v *translationRequestIdentity) { v.Template = "template-b" }},
		{"decode settings", func(v *translationRequestIdentity) { v.DecodeSettings = ModelOptions{Thinking: true} }},
		{"max tokens", func(v *translationRequestIdentity) { v.MaxTokens++ }},
		{"temperature", func(v *translationRequestIdentity) { v.Temperature = 0.2 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			changed := base
			tc.change(&changed)
			if got := fingerprintTranslationRequest(changed); got == baseKey {
				t.Fatalf("changing %s did not change the in-flight key", tc.name)
			}
		})
	}
}

func TestHandleTranslateSeparatesFlightsWhenContextHistoryChangesBeforeDispatch(t *testing.T) {
	histories := make(chan []contextEntry, 2)
	s := newTestServer(t, mockFuncs{
		translate: func(_ string, _, _ string, _ ModelOptions, history []contextEntry) (string, error) {
			histories <- append([]contextEntry(nil), history...)
			return "translated", nil
		},
	})
	s.setLoadedLlamaIdentity("test-local-model-q4", runtimeIdentityForModelSpec("test-local-model-q4"))
	s.contextBuf.Add(contextEntry{Transcription: "history zero", Translation: "履歴ゼロ"})
	fields := map[string]string{
		"text": "same source revision", "source_text": "same source revision", "source_lang": "en", "target_lang": "ja",
		"session_id": "session-a", "audio_source": "tab", "stream_generation": "4",
		"segment_id": "segment-a", "source_revision": "1",
	}

	// Hold model dispatch after the first request has captured H0, then change
	// the context seen by a retry with the same source/revision.
	s.modelMu.Lock()
	modelLocked := true
	t.Cleanup(func() {
		if modelLocked {
			s.modelMu.Unlock()
		}
	})
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		_, _ = runTranslationRequest(s, fields, nil)
	}()
	waitForActiveTranslationFlights(t, s, 1)
	s.contextBuf.Add(contextEntry{Transcription: "history one", Translation: "履歴一"})
	secondDone := make(chan struct{})
	go func() {
		defer close(secondDone)
		_, _ = runTranslationRequest(s, fields, nil)
	}()
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) && s.translationFlights.activeFlightCount() != 2 {
		time.Sleep(time.Millisecond)
	}
	if got := s.translationFlights.activeFlightCount(); got != 2 {
		t.Fatalf("context history change created %d flights, want 2", got)
	}
	s.modelMu.Unlock()
	modelLocked = false

	for name, done := range map[string]<-chan struct{}{"first": firstDone, "second": secondDone} {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s request did not finish", name)
		}
	}
	close(histories)
	observed := make(map[string]bool)
	for history := range histories {
		var fingerprint string
		for _, entry := range history {
			fingerprint += entry.Transcription + "/" + entry.Translation + ";"
		}
		observed[fingerprint] = true
	}
	if len(observed) != 2 || !observed["history zero/履歴ゼロ;"] || !observed["history zero/履歴ゼロ;history one/履歴一;"] {
		t.Fatalf("translation contexts = %#v, want independent H0 and H1 snapshots", observed)
	}
}

func TestHandleTranslateUsesFormFieldsAndGlossaryToCoalesceOnlyMatchingWork(t *testing.T) {
	baseFields := map[string]string{
		"text":              "hello there",
		"source_text":       "the complete hello there utterance",
		"source_lang":       "en",
		"target_lang":       "ja",
		"session_id":        "session-a",
		"audio_source":      "tab",
		"stream_generation": "4",
		"segment_id":        "segment-a",
		"source_revision":   "2",
	}
	cases := []struct {
		name     string
		model    string
		change   func(map[string]string)
		glossary bool
	}{
		{name: "translation text", change: func(v map[string]string) { v["text"] += " changed" }},
		{name: "original source text", change: func(v map[string]string) { v["source_text"] += " changed" }},
		{name: "source language", change: func(v map[string]string) { v["source_lang"] = "ja" }},
		{name: "target language", change: func(v map[string]string) { v["target_lang"] = "fr" }},
		{name: "session id", change: func(v map[string]string) { v["session_id"] = "session-b" }},
		{name: "audio source", change: func(v map[string]string) { v["audio_source"] = "mic" }},
		{name: "stream generation", change: func(v map[string]string) { v["stream_generation"] = "5" }},
		{name: "segment id", change: func(v map[string]string) { v["segment_id"] = "segment-b" }},
		{name: "source revision", change: func(v map[string]string) { v["source_revision"] = "3" }},
		{
			name:   "requested model",
			model:  "qwen3:0.6b-q4_k_m",
			change: func(v map[string]string) { v["llama_model"] = "qwen3:1.7b-q4_k_m" },
		},
		{
			name:   "model options",
			model:  "qwen3:0.6b-q4_k_m",
			change: func(v map[string]string) { v["llama_options"] = `{"thinking":true}` },
		},
		{name: "translation glossary revision", glossary: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			started := make(chan struct{})
			release := make(chan struct{})
			var releaseOnce sync.Once
			t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })

			s := newTestServer(t, mockFuncs{
				translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
					if calls.Add(1) == 1 {
						close(started)
					}
					<-release
					return "translated", nil
				},
			})
			model := tc.model
			if model == "" {
				model = "test-local-model-q4"
			}
			s.setLoadedLlamaIdentity(model, runtimeIdentityForModelSpec(model))

			fields := make(map[string]string, len(baseFields)+2)
			for key, value := range baseFields {
				fields[key] = value
			}
			if tc.model != "" {
				fields["llama_model"] = tc.model
			}
			if tc.name == "model options" {
				fields["llama_options"] = `{"thinking":false}`
			}

			type responseResult struct {
				response *httptest.ResponseRecorder
				err      error
			}
			launch := func(requestFields map[string]string) <-chan responseResult {
				done := make(chan responseResult, 1)
				go func() {
					response, err := runTranslationRequest(s, requestFields, nil)
					done <- responseResult{response: response, err: err}
				}()
				return done
			}

			first := launch(fields)
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("first translation did not start")
			}

			identical := launch(fields)
			waitForActiveTranslationWaiters(t, s, 2)
			if got := s.translationFlights.activeFlightCount(); got != 1 {
				t.Fatalf("identical form fields created %d flights, want 1", got)
			}

			if tc.glossary {
				s.glossary.mu.Lock()
				s.glossary.data.Terms["flight test term"] = GlossaryEntry{Source: "flight test term", Target: "translated test term"}
				s.glossary.mu.Unlock()
			}
			changedFields := make(map[string]string, len(fields)+1)
			for key, value := range fields {
				changedFields[key] = value
			}
			if tc.change != nil {
				tc.change(changedFields)
			}
			changed := launch(changedFields)
			waitForActiveTranslationFlights(t, s, 2)
			waitForActiveTranslationWaiters(t, s, 3)

			releaseOnce.Do(func() { close(release) })
			for name, done := range map[string]<-chan responseResult{
				"first": first, "identical": identical, "changed": changed,
			} {
				select {
				case result := <-done:
					if result.err != nil {
						t.Fatalf("%s request: %v", name, result.err)
					}
					if result.response == nil || result.response.Code != http.StatusOK {
						t.Fatalf("%s response = %#v, want 200", name, result.response)
					}
				case <-time.After(5 * time.Second):
					t.Fatalf("%s request did not finish", name)
				}
			}
			if got := calls.Load(); got != 2 {
				t.Fatalf("translation calls = %d, want 2 for one shared and one distinct request", got)
			}
			if got := len(s.contextBuf.Entries()); got != 2 {
				t.Fatalf("context entries = %d, want one per distinct inference", got)
			}
		})
	}
}

func TestHandleTranslateFailureIsRemovedSoTheSameRequestCanRetry(t *testing.T) {
	var calls atomic.Int32
	s := newTestServer(t, mockFuncs{
		translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
			if calls.Add(1) == 1 {
				return "", errors.New("temporary model failure")
			}
			return "retry succeeded", nil
		},
	})
	fields := map[string]string{
		"text": "retry me", "source_text": "retry me", "source_lang": "en", "target_lang": "ja",
		"session_id": "session-a", "audio_source": "tab", "stream_generation": "4",
		"segment_id": "segment-a", "source_revision": "1",
	}

	first, err := runTranslationRequest(s, fields, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.Code != http.StatusInternalServerError {
		t.Fatalf("first status = %d, want 500", first.Code)
	}
	second, err := runTranslationRequest(s, fields, nil)
	if err != nil {
		t.Fatal(err)
	}
	if second.Code != http.StatusOK || calls.Load() != 2 {
		t.Fatalf("retry status/calls = %d/%d, want 200/2", second.Code, calls.Load())
	}
}

func TestCancellingOneTranslationWaiterDoesNotCancelSharedWork(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	s := newTestServer(t, mockFuncs{
		translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
			if calls.Add(1) == 1 {
				close(started)
			}
			<-release
			return "still available", nil
		},
	})
	fields := map[string]string{
		"text": "shared work", "source_text": "shared work", "source_lang": "en", "target_lang": "ja",
		"session_id": "session-a", "audio_source": "tab", "stream_generation": "4",
		"segment_id": "segment-a", "source_revision": "1",
	}
	leaderDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w, _ := runTranslationRequest(s, fields, nil)
		leaderDone <- w
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("translation did not start")
	}

	cancelledCtx, cancel := context.WithCancel(context.Background())
	cancelledDone := make(chan struct{})
	go func() {
		_, _ = runTranslationRequest(s, fields, cancelledCtx)
		close(cancelledDone)
	}()
	survivorDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w, _ := runTranslationRequest(s, fields, nil)
		survivorDone <- w
	}()
	waitForActiveTranslationWaiters(t, s, 3)
	cancel()
	select {
	case <-cancelledDone:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled waiter did not return")
	}
	if calls.Load() != 1 {
		t.Fatalf("cancelling one waiter changed inference count to %d", calls.Load())
	}
	close(release)
	if leader := <-leaderDone; leader == nil || leader.Code != http.StatusOK {
		t.Fatalf("leader response = %#v, want 200", leader)
	}
	if survivor := <-survivorDone; survivor == nil || survivor.Code != http.StatusOK {
		t.Fatalf("surviving waiter response = %#v, want 200", survivor)
	}
	if got := len(s.contextBuf.Entries()); got != 1 {
		t.Fatalf("context entries = %d, want one side effect", got)
	}
}
