// context_buffer.go – 直近の発話履歴を保持するリングバッファ
//
// LLM の few-shot context に使用する。
// ※ Whisper の initial_prompt には使用しない（過去発話を含めると
//    無音時に hallucination が発生し翻訳連鎖を引き起こすため）。
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
		// 新しいスライスにコピーして元の backing array を解放する。
		// 単純な再スライス (b.entries = b.entries[n:]) では元配列への参照が残り続け、
		// 古いエントリが GC されないメモリリークになる。
		newEntries := make([]contextEntry, b.maxSize)
		copy(newEntries, b.entries[len(b.entries)-b.maxSize:])
		b.entries = newEntries
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

// Transcriptions は全エントリの文字起こし部分のみを返す。
// 重複検出（isRepeatTranscription）などで使用する。
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
