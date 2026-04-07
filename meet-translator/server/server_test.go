package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ─── テスト用サーバー構築 ─────────────────────────────────────────────────────

type mockFuncs struct {
	transcribe func([]byte, string) (string, string, error)
	translate  func(string, string, string, ModelOptions, []contextEntry) (string, error)
	swapModel  func(string) error
}

func newTestServer(t *testing.T, m mockFuncs) *server {
	t.Helper()
	s := &server{
		cfg:             config{port: "7070"},
		mux:             http.NewServeMux(),
		loadedModelSpec: "",
		contextBuf:      newContextBuffer(3),
		glossary:        loadGlossary(), // テスト用：空の辞書
		improver:        nil,            // テスト中はバックグラウンド LLM 解析なし
	}
	if m.transcribe != nil {
		s.transcribeFn = m.transcribe
	} else {
		s.transcribeFn = func([]byte, string) (string, string, error) { return "hello", "", nil }
	}
	if m.translate != nil {
		s.translateFn = m.translate
	} else {
		s.translateFn = func(string, string, string, ModelOptions, []contextEntry) (string, error) {
			return "こんにちは", nil
		}
	}
	if m.swapModel != nil {
		s.swapModelFn = m.swapModel
	} else {
		s.swapModelFn = func(spec string) error {
			s.loadedModelSpec = spec
			return nil
		}
	}
	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.HandleFunc("POST /transcribe-and-translate", s.handleTranscribeAndTranslate)
	s.mux.HandleFunc("POST /transcribe", s.handleTranscribe)
	s.mux.HandleFunc("POST /translate", s.handleTranslate)
	s.mux.HandleFunc("GET /glossary", s.handleGlossaryGet)
	s.mux.HandleFunc("POST /glossary/corrections", s.handleGlossaryUpsertCorrection)
	s.mux.HandleFunc("DELETE /glossary/corrections/{source}", s.handleGlossaryDeleteCorrection)
	s.mux.HandleFunc("POST /glossary/terms", s.handleGlossaryUpsertTerm)
	s.mux.HandleFunc("DELETE /glossary/terms/{source}", s.handleGlossaryDeleteTerm)
	s.mux.HandleFunc("POST /glossary/learn", s.handleGlossaryLearn)
	return s
}

// buildAudioForm は /transcribe-and-translate 用の multipart リクエストを組み立てる。
func buildAudioForm(t *testing.T, fields map[string]string, audioData []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	// audio ファイルフィールド
	if audioData != nil {
		fw, err := mw.CreateFormFile("audio", "audio.wav")
		if err != nil {
			t.Fatal(err)
		}
		fw.Write(audioData)
	}
	for k, v := range fields {
		mw.WriteField(k, v)
	}
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/transcribe-and-translate", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

// fakeWAV は最小限の WAV ヘッダー (有効なバイト列ではないが audio フォームに渡せる)。
var fakeWAV = []byte("RIFF\x00\x00\x00\x00WAVEfmt ")

// ─── GET /health ─────────────────────────────────────────────────────────────

func TestHandleHealth_OK(t *testing.T) {
	s := newTestServer(t, mockFuncs{})
	s.whisperModelSpec = "base"
	s.loadedModelSpec = "qwen3.5:4b-q4_k_m"
	w := httptest.NewRecorder()
	s.handleHealth(w, httptest.NewRequest(http.MethodGet, "/health", nil))

	if w.Code != http.StatusOK {
		t.Errorf("status=%d, want 200", w.Code)
	}
	var body map[string]string
	json.NewDecoder(w.Body).Decode(&body)
	if body["status"] != "ok" {
		t.Errorf("body[status]=%q, want \"ok\"", body["status"])
	}
	if body["whisper_model"] != "base" {
		t.Errorf("body[whisper_model]=%q, want \"base\"", body["whisper_model"])
	}
	if body["llama_model"] != "qwen3.5:4b-q4_k_m" {
		t.Errorf("body[llama_model]=%q, want \"qwen3.5:4b-q4_k_m\"", body["llama_model"])
	}
}

func TestHandleHealth_CORS(t *testing.T) {
	s := newTestServer(t, mockFuncs{})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	s.ServeHTTP(w, req)
	if w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("CORS header missing: %v", w.Header())
	}
}

func TestHandleHealth_CORS_Preflight(t *testing.T) {
	s := newTestServer(t, mockFuncs{})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/health", nil)
	s.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("OPTIONS should return 204, got %d", w.Code)
	}
}

// ─── POST /transcribe-and-translate ──────────────────────────────────────────

func TestHandleTranscribeAndTranslate_Success(t *testing.T) {
	s := newTestServer(t, mockFuncs{
		transcribe: func([]byte, string) (string, string, error) { return "hello world", "", nil },
		translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
			return "こんにちは世界", nil
		},
	})

	req := buildAudioForm(t, map[string]string{"target_lang": "ja"}, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status=%d, want 200; body=%s", w.Code, w.Body)
	}
	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["transcription"] != "hello world" {
		t.Errorf("transcription=%q", resp["transcription"])
	}
	if resp["translation"] != "こんにちは世界" {
		t.Errorf("translation=%q", resp["translation"])
	}
}

func TestHandleTranscribeAndTranslate_MissingAudio(t *testing.T) {
	s := newTestServer(t, mockFuncs{})
	req := buildAudioForm(t, nil, nil)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status=%d, want 400", w.Code)
	}
}

func TestHandleTranscribeAndTranslate_EmptyTranscription(t *testing.T) {
	s := newTestServer(t, mockFuncs{
		transcribe: func([]byte, string) (string, string, error) { return "  ", "", nil }, // whitespace only
	})
	req := buildAudioForm(t, map[string]string{"target_lang": "ja"}, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status=%d, want 200", w.Code)
	}
	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["translation"] != "" {
		t.Errorf("expected empty translation, got %q", resp["translation"])
	}
}

func TestHandleTranscribeAndTranslate_TranscribeError(t *testing.T) {
	s := newTestServer(t, mockFuncs{
		transcribe: func([]byte, string) (string, string, error) { return "", "", errors.New("whisper error") },
	})
	req := buildAudioForm(t, nil, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status=%d, want 500", w.Code)
	}
}

func TestHandleTranscribeAndTranslate_TranslateError(t *testing.T) {
	s := newTestServer(t, mockFuncs{
		transcribe: func([]byte, string) (string, string, error) { return "hello", "", nil },
		translate: func(string, string, string, ModelOptions, []contextEntry) (string, error) {
			return "", errors.New("llama error")
		},
	})
	req := buildAudioForm(t, nil, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status=%d, want 500", w.Code)
	}
}

func TestHandleTranscribeAndTranslate_DefaultTargetLang(t *testing.T) {
	var capturedTgt string
	s := newTestServer(t, mockFuncs{
		translate: func(_, _, tgt string, _ ModelOptions, _ []contextEntry) (string, error) {
			capturedTgt = tgt
			return "翻訳", nil
		},
	})
	// target_lang を送らない
	req := buildAudioForm(t, nil, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if capturedTgt != "ja" {
		t.Errorf("default target_lang should be 'ja', got %q", capturedTgt)
	}
}

func TestHandleTranscribeAndTranslate_ModelOptions_Thinking(t *testing.T) {
	var capturedOpts ModelOptions
	s := newTestServer(t, mockFuncs{
		translate: func(_, _, _ string, opts ModelOptions, _ []contextEntry) (string, error) {
			capturedOpts = opts
			return "result", nil
		},
	})
	s.loadedModelSpec = "qwen3:8b-q4_k_m"

	req := buildAudioForm(t, map[string]string{
		"llama_options": `{"thinking":false}`,
	}, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d; body=%s", w.Code, w.Body)
	}
	if capturedOpts.Thinking {
		t.Error("expected Thinking=false from llama_options")
	}
}

func TestHandleTranscribeAndTranslate_ModelSwap(t *testing.T) {
	var swappedTo string
	s := newTestServer(t, mockFuncs{
		swapModel: func(spec string) error {
			swappedTo = spec
			return nil
		},
	})
	s.loadedModelSpec = "qwen2.5:7b-instruct-q4_k_m"

	req := buildAudioForm(t, map[string]string{
		"llama_model": "qwen3:8b-q4_k_m",
	}, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if swappedTo != "qwen3:8b-q4_k_m" {
		t.Errorf("expected swap to qwen3:8b-q4_k_m, got %q", swappedTo)
	}
}

func TestHandleTranscribeAndTranslate_NoSwapWhenModelMatches(t *testing.T) {
	swapCalled := false
	s := newTestServer(t, mockFuncs{
		swapModel: func(spec string) error {
			swapCalled = true
			return nil
		},
	})
	s.loadedModelSpec = "qwen3:8b-q4_k_m"

	// 同じモデルを指定 → スワップ不要
	req := buildAudioForm(t, map[string]string{
		"llama_model": "qwen3:8b-q4_k_m",
	}, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if swapCalled {
		t.Error("swap should not be called when model already matches")
	}
}

func TestHandleTranscribeAndTranslate_ModelSwapError(t *testing.T) {
	s := newTestServer(t, mockFuncs{
		swapModel: func(string) error { return errors.New("download failed") },
	})
	s.loadedModelSpec = "qwen2.5:7b-instruct-q4_k_m"

	req := buildAudioForm(t, map[string]string{"llama_model": "gemma4:e4b-q4_k_m"}, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status=%d, want 500", w.Code)
	}
}

// ─── JSON レスポンス形式 ──────────────────────────────────────────────────────

func TestResponseIsJSON(t *testing.T) {
	s := newTestServer(t, mockFuncs{})
	req := buildAudioForm(t, nil, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	ct := w.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type=%q, want application/json", ct)
	}
}

func TestHandleTranscribeAndTranslate_SourceLangPassed(t *testing.T) {
	var capturedSrc string
	s := newTestServer(t, mockFuncs{
		transcribe: func(_ []byte, lang string) (string, string, error) {
			capturedSrc = lang
			return "transcript", "", nil
		},
	})

	req := buildAudioForm(t, map[string]string{"source_lang": "en"}, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if capturedSrc != "en" {
		t.Errorf("source_lang not passed to transcribe: got %q", capturedSrc)
	}
}

// ─── context buffer 連携テスト ────────────────────────────────────────────────

func TestHandleTranscribeAndTranslate_RepeatFiltered(t *testing.T) {
	// Whisper が直近の発話と同一テキストを返した場合（hallucination）は破棄する
	s := newTestServer(t, mockFuncs{
		transcribe: func(_ []byte, _ string) (string, string, error) {
			return "previous utterance", "", nil // 直前と同一
		},
	})
	s.contextBuf.Add(contextEntry{Transcription: "previous utterance", Translation: "前の発話"})

	req := buildAudioForm(t, nil, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d", w.Code)
	}
	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["transcription"] != "" || resp["translation"] != "" {
		t.Errorf("repeated transcription should be filtered, got transcription=%q translation=%q",
			resp["transcription"], resp["translation"])
	}
}

func TestHandleTranscribeAndTranslate_HistoryPassedToTranslate(t *testing.T) {
	var capturedHistory []contextEntry
	s := newTestServer(t, mockFuncs{
		// "good morning" is distinct from the pre-loaded "Hello" so repeat-filter won't trigger
		transcribe: func([]byte, string) (string, string, error) { return "good morning", "", nil },
		translate: func(_ string, _ string, _ string, _ ModelOptions, hist []contextEntry) (string, error) {
			capturedHistory = hist
			return "result", nil
		},
	})
	s.contextBuf.Add(contextEntry{Transcription: "Hello", Translation: "こんにちは"})

	req := buildAudioForm(t, nil, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	if len(capturedHistory) != 1 || capturedHistory[0].Transcription != "Hello" {
		t.Errorf("history not passed to translate: got %v", capturedHistory)
	}
}

func TestHandleTranscribeAndTranslate_AddsToContextBuf(t *testing.T) {
	s := newTestServer(t, mockFuncs{
		transcribe: func([]byte, string) (string, string, error) { return "good morning", "", nil },
		translate:  func(string, string, string, ModelOptions, []contextEntry) (string, error) { return "おはよう", nil },
	})

	req := buildAudioForm(t, nil, fakeWAV)
	w := httptest.NewRecorder()
	s.handleTranscribeAndTranslate(w, req)

	entries := s.contextBuf.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 context entry, got %d", len(entries))
	}
	if entries[0].Transcription != "good morning" || entries[0].Translation != "おはよう" {
		t.Errorf("unexpected context entry: %+v", entries[0])
	}
}

// ─── インテグレーション: 実サーバー経由の E2E ─────────────────────────────────

func TestServerEndToEnd(t *testing.T) {
	s := newTestServer(t, mockFuncs{
		transcribe: func([]byte, string) (string, string, error) { return "good morning", "", nil },
		translate: func(text, _, tgt string, _ ModelOptions, _ []contextEntry) (string, error) {
			return fmt.Sprintf("[%s] %s", tgt, text), nil
		},
	})

	ts := httptest.NewServer(s)
	defer ts.Close()

	// Health check
	resp, err := http.Get(ts.URL + "/health")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("health check failed: %v %v", err, resp)
	}

	// Transcribe + Translate
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("audio", "audio.wav")
	fw.Write(fakeWAV)
	mw.WriteField("target_lang", "ja")
	mw.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/transcribe-and-translate", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("POST failed: %v %v", err, resp)
	}

	var result map[string]string
	json.NewDecoder(resp.Body).Decode(&result)
	resp.Body.Close()

	if result["transcription"] != "good morning" {
		t.Errorf("transcription=%q", result["transcription"])
	}
	if result["translation"] != "[ja] good morning" {
		t.Errorf("translation=%q", result["translation"])
	}
}
