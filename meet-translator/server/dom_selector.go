// dom_selector.go – POST /find-chat-input
//
// DOM スニペットを LLM に渡し、チャット入力欄の CSS セレクタを返すエンドポイント。
// 既存のセレクタが全滅したときのフォールバックとして content.js から呼ばれる。

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
)

type findChatInputRequest struct {
	HTML string `json:"html"`
}

type findChatInputResponse struct {
	Selector string `json:"selector"`
}

// handleFindChatInput は DOM フラグメントを受け取り LLM にセレクタを問い合わせる。
// POST /find-chat-input  body: application/json { "html": "..." }
// response: { "selector": "css-selector" }  (空文字列 = 見つからず)
func (s *server) handleFindChatInput(w http.ResponseWriter, r *http.Request) {
	var req findChatInputRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.HTML) == "" {
		http.Error(w, "html is required", http.StatusBadRequest)
		return
	}

	selector, err := s.findChatInputSelector(req.HTML)
	if err != nil {
		log.Printf("[find-chat-input] LLM error: %v", err)
		http.Error(w, "selector search failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	s.logVerbose("find-chat-input: selector=%q", selector)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(findChatInputResponse{Selector: selector})
}

// findChatInputSelector は DOM HTML を LLM に解析させ CSS セレクタを返す。
func (s *server) findChatInputSelector(domHTML string) (string, error) {
	// LLM に渡す前に HTML を削減する（コンテキスト節約）
	const maxLen = 8000
	if len(domHTML) > maxLen {
		domHTML = domHTML[:maxLen]
	}

	prompt := fmt.Sprintf(`You are analyzing a Google Meet embedded Google Chat DOM snippet.
Find the element where users TYPE chat messages (NOT search boxes, NOT buttons).

Rules:
- Exclude elements whose placeholder or aria-label contains "search" or "検索"
- Target: contenteditable div, textarea, or input for composing messages
- Output ONLY valid JSON, no markdown, no explanation

Output format:
{"selector": "css-selector-here"}

If not found:
{"selector": ""}

DOM:
%s`, domHTML)

	raw, err := s.generateRaw(prompt)
	if err != nil {
		return "", fmt.Errorf("LLM call failed: %w", err)
	}

	s.logVerbose("find-chat-input raw LLM output: %q", raw)

	cleaned := extractJSONObject(raw)
	var resp findChatInputResponse
	if err := json.Unmarshal([]byte(cleaned), &resp); err != nil {
		return "", fmt.Errorf("JSON parse failed (raw=%q): %w", raw, err)
	}
	return strings.TrimSpace(resp.Selector), nil
}

// extractJSONObject はモデル出力から最初の { ... } を取り出す。
// コードフェンス (```json ... ```) も除去する。
func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	// コードフェンスを除去
	for _, fence := range []string{"```json", "```"} {
		s = strings.TrimPrefix(s, fence)
	}
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)

	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start == -1 || end == -1 || end < start {
		return s
	}
	return s[start : end+1]
}
