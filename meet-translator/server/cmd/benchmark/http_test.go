package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBenchmarkRequestsUseLocalAPIToken(t *testing.T) {
	const token = "benchmark-test-token-0123456789012345"
	t.Setenv("MEET_TRANSLATOR_API_TOKEN", token)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			t.Errorf("Authorization = %q, want bearer token", got)
		}
		if r.URL.Path == "/health" {
			_, _ = w.Write([]byte(`{"llama_model":"baseline"}`))
			return
		}
		_, _ = w.Write([]byte(`{"translation":"translated"}`))
	}))
	defer server.Close()

	if got, err := getModelName(server.URL); err != nil || got != "baseline" {
		t.Fatalf("getModelName() = %q, %v; want baseline, nil", got, err)
	}
	if got, err := translateViaHTTP(server.URL, "source", "en", "ja"); err != nil || got != "translated" {
		t.Fatalf("translateViaHTTP() = %q, %v; want translated, nil", got, err)
	}
}

func TestGetModelNameRejectsUnauthorizedHealthResponse(t *testing.T) {
	t.Setenv("MEET_TRANSLATOR_API_TOKEN", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer server.Close()

	if _, err := getModelName(server.URL); err == nil {
		t.Fatal("getModelName() accepted an unauthorized health response")
	}
}

func TestAuthenticatedRequestRejectsNonLoopbackURL(t *testing.T) {
	t.Setenv("MEET_TRANSLATOR_API_TOKEN", "benchmark-test-token-0123456789012345")
	for _, endpoint := range []string{
		"https://attacker.example/health",
		"http://localhost.attacker.example/health",
		"http://user@localhost:17070/health",
	} {
		if _, err := newAuthenticatedRequest(http.MethodGet, endpoint, nil); err == nil {
			t.Errorf("newAuthenticatedRequest accepted non-loopback URL %q", endpoint)
		}
	}
}
