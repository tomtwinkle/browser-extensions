package main

import (
	"crypto/subtle"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

const maxAudioRequestBytes int64 = 8 << 20

func validateAPISecurityConfig(cfg config) error {
	if len([]byte(cfg.apiToken)) < 32 || strings.TrimSpace(cfg.apiToken) != cfg.apiToken || strings.ContainsAny(cfg.apiToken, "\r\n") {
		return fmt.Errorf("MEET_TRANSLATOR_API_TOKEN must contain at least 32 bytes without surrounding whitespace")
	}
	if cfg.port == "" {
		return fmt.Errorf("server port is required")
	}
	if port, err := strconv.Atoi(cfg.port); err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("server port must be between 1 and 65535")
	}
	origin, err := url.Parse(cfg.extensionOrigin)
	if err != nil || origin.Scheme != "chrome-extension" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return fmt.Errorf("MEET_TRANSLATOR_EXTENSION_ORIGIN must be the exact chrome-extension://<extension-id> origin")
	}
	return nil
}

func isLoopbackRequestHost(hostHeader, expectedPort string) bool {
	host, port, err := net.SplitHostPort(hostHeader)
	if err != nil || port != expectedPort {
		return false
	}
	switch strings.ToLower(strings.TrimSuffix(host, ".")) {
	case "localhost", "127.0.0.1":
		return true
	default:
		return false
	}
}

func hasValidBearerToken(header, expected string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	provided := strings.TrimPrefix(header, prefix)
	if len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func validCORSPreflightMethod(method string) bool {
	switch method {
	case "GET", "POST", "DELETE":
		return true
	default:
		return false
	}
}

func validCORSPreflightHeaders(headers string) bool {
	for _, header := range strings.Split(headers, ",") {
		switch strings.ToLower(strings.TrimSpace(header)) {
		case "", "authorization", "content-type":
		default:
			return false
		}
	}
	return true
}
