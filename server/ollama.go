// ollama.go – Ollama /api/chat クライアント

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

var langNames = map[string]string{
	"ja": "Japanese", "en": "English",    "zh": "Chinese",
	"ko": "Korean",   "fr": "French",     "de": "German",
	"es": "Spanish",  "pt": "Portuguese", "ru": "Russian",
	"ar": "Arabic",   "it": "Italian",    "nl": "Dutch",
}

func langLabel(code string) string {
	if n, ok := langNames[code]; ok {
		return n
	}
	if code == "" {
		return "the detected language"
	}
	return code
}

// translate は Ollama の /api/chat エンドポイントを呼んで翻訳結果を返す。
func (s *server) translate(text, sourceLang, targetLang, model string) (string, error) {
	prompt := fmt.Sprintf(
		"Translate the following %s text to %s.\n"+
			"Output only the translated text, no explanation, no extra lines.\n\n"+
			"Text: %s",
		langLabel(sourceLang), langLabel(targetLang), text,
	)

	type message struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	type ollamaRequest struct {
		Model    string             `json:"model"`
		Messages []message          `json:"messages"`
		Stream   bool               `json:"stream"`
		Options  map[string]float64 `json:"options"`
	}

	reqBody, err := json.Marshal(ollamaRequest{
		Model:    model,
		Messages: []message{{Role: "user", Content: prompt}},
		Stream:   false,
		Options:  map[string]float64{"temperature": 0.1},
	})
	if err != nil {
		return "", err
	}

	resp, err := http.Post(s.cfg.ollamaURL+"/api/chat", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return "", fmt.Errorf("ollama unreachable: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("ollama %d: %s", resp.StatusCode, respBody)
	}

	var result struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("decode ollama response: %w", err)
	}
	return strings.TrimSpace(result.Message.Content), nil
}
