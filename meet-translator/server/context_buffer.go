// context_buffer.go – 直近の発話履歴を保持するリングバッファ
//
// Whisper の initial_prompt と LLM の few-shot context の両方に使われる。
// サーバー全体で単一のバッファを共有する（シングルユーザーのローカルサーバー想定）。

package main

import "sync"

// contextEntry は一発話の文字起こしと翻訳のペア。
type contextEntry struct {
	Transcription string
	Translation   string
}

// contextBuffer は直近の発話履歴を保持するリングバッファ。
type contextBuffer struct {
	mu      sync.Mutex
	entries []contextEntry
	maxSize int
}

func newContextBuffer(maxSize int) *contextBuffer {
	if maxSize <= 0 {
		maxSize = 3
	}
	return &contextBuffer{maxSize: maxSize}
}

// Add は新しいエントリをバッファに追加する。maxSize を超えた場合は最古を削除する。
func (b *contextBuffer) Add(e contextEntry) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.entries = append(b.entries, e)
	if len(b.entries) > b.maxSize {
		b.entries = b.entries[len(b.entries)-b.maxSize:]
	}
}

// Entries はバッファの全エントリのコピーを返す（古い順）。
func (b *contextBuffer) Entries() []contextEntry {
	b.mu.Lock()
	defer b.mu.Unlock()
	cp := make([]contextEntry, len(b.entries))
	copy(cp, b.entries)
	return cp
}

// Transcriptions は全エントリの文字起こし部分のみを返す。Whisper initial_prompt 用。
func (b *contextBuffer) Transcriptions() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	ss := make([]string, len(b.entries))
	for i, e := range b.entries {
		ss[i] = e.Transcription
	}
	return ss
}

// Clear はバッファを空にする。
func (b *contextBuffer) Clear() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.entries = b.entries[:0]
}
