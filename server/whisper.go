// whisper.go – whisper.cpp Go バインディングによる文字起こし
//
// CGo 経由で whisper.cpp を直接呼び出す。
// 別プロセスの起動は不要。モデルファイルは起動時に一度だけロードされキャッシュされる。

package main

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/ggerganov/whisper.cpp/bindings/go/pkg/whisper"
)

// transcribe は WAV バイト列を受け取り、文字起こしテキストを返す。
// 初回呼び出し時に whisper モデルが s.cfg.whisperModel からロードされる。
func (s *server) transcribe(audioData []byte, lang string) (string, error) {
	// モデルが未ロードであればロードする（server.whisperModel に格納済みのはず）
	model := s.whisperModel
	if model == nil {
		return "", fmt.Errorf("whisper モデルが初期化されていません")
	}

	// WAV をパース → 16kHz float32 に変換
	wav, err := parseWAV(bytes.NewReader(audioData))
	if err != nil {
		return "", fmt.Errorf("WAV パース失敗: %w", err)
	}
	samples := resampleTo16k(wav.samples, wav.sampleRate)
	if len(samples) == 0 {
		return "", nil
	}

	// whisper コンテキストを作成
	ctx, err := model.NewContext()
	if err != nil {
		return "", fmt.Errorf("whisper context 作成失敗: %w", err)
	}

	if lang != "" {
		if err := ctx.SetLanguage(lang); err != nil {
			return "", fmt.Errorf("言語設定失敗 (%s): %w", lang, err)
		}
	} else {
		_ = ctx.SetLanguage("auto")
	}

	// 文字起こし実行
	if err := ctx.Process(samples, nil, nil, nil); err != nil {
		return "", fmt.Errorf("whisper 処理失敗: %w", err)
	}

	// セグメントを結合してテキストを返す
	var sb strings.Builder
	for {
		seg, err := ctx.NextSegment()
		if err != nil {
			break
		}
		sb.WriteString(seg.Text)
	}
	return strings.TrimSpace(sb.String()), nil
}

