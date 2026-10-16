package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testAPIToken = "0123456789abcdef0123456789abcdef"
const testExtensionOrigin = "chrome-extension://test-extension-id"

func secureRequest(method, path, host, origin, token string, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = host
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req
}

func TestValidateAPISecurityConfigRequiresStrongTokenAndExactExtensionOrigin(t *testing.T) {
	valid := config{port: "17070", apiToken: testAPIToken, extensionOrigin: testExtensionOrigin}
	if err := validateAPISecurityConfig(valid); err != nil {
		t.Fatalf("valid security config rejected: %v", err)
	}
	for name, cfg := range map[string]config{
		"missing token":   {port: "17070", extensionOrigin: testExtensionOrigin},
		"short token":     {port: "17070", apiToken: "short", extensionOrigin: testExtensionOrigin},
		"wildcard origin": {port: "17070", apiToken: testAPIToken, extensionOrigin: "*"},
		"http origin":     {port: "17070", apiToken: testAPIToken, extensionOrigin: "http://localhost:17070"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateAPISecurityConfig(cfg); err == nil {
				t.Fatal("expected invalid API security config to be rejected")
			}
		})
	}
}

func TestServeHTTPRequiresBearerTokenAndLocalHost(t *testing.T) {
	s := newTestServer(t, mockFuncs{})

	t.Run("missing token", func(t *testing.T) {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, secureRequest(http.MethodGet, "/health", "localhost:7070", "", "", ""))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
	})

	t.Run("invalid token", func(t *testing.T) {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, secureRequest(http.MethodGet, "/health", "localhost:7070", "", "wrong-token-012345678901234567890123456789", ""))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
	})

	t.Run("non-local host", func(t *testing.T) {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, secureRequest(http.MethodGet, "/health", "192.168.1.15:7070", "", testAPIToken, ""))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
	})
}

func TestServeHTTPUsesExactConfiguredOriginAndPreflight(t *testing.T) {
	s := newTestServer(t, mockFuncs{})

	w := httptest.NewRecorder()
	s.ServeHTTP(w, secureRequest(http.MethodGet, "/health", "localhost:7070", testExtensionOrigin, testAPIToken, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("authorized status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != testExtensionOrigin {
		t.Fatalf("allow-origin = %q, want exact extension origin", got)
	}

	w = httptest.NewRecorder()
	s.ServeHTTP(w, secureRequest(http.MethodGet, "/health", "localhost:7070", "chrome-extension://other-extension", testAPIToken, ""))
	if w.Code != http.StatusForbidden {
		t.Fatalf("unconfigured origin status = %d, want 403", w.Code)
	}

	w = httptest.NewRecorder()
	preflight := secureRequest(http.MethodOptions, "/transcribe", "localhost:7070", testExtensionOrigin, "", "")
	preflight.Header.Set("Access-Control-Request-Method", "POST")
	preflight.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
	s.ServeHTTP(w, preflight)
	if w.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != testExtensionOrigin {
		t.Fatalf("preflight allow-origin = %q, want exact extension origin", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(strings.ToLower(got), "authorization") {
		t.Fatalf("preflight allow-headers = %q, want authorization", got)
	}
}

func TestServeHTTPRejectsOversizedAudioRequest(t *testing.T) {
	s := newTestServer(t, mockFuncs{})
	body := strings.Repeat("x", int(maxAudioRequestBytes+1))
	req := secureRequest(http.MethodPost, "/transcribe", "localhost:7070", "", testAPIToken, body)
	req.Header.Set("Content-Type", "multipart/form-data; boundary=not-a-boundary")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%q", w.Code, w.Body.String())
	}
}
