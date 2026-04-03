// whisper.go – whisper.cpp HTTP サーバーへのクライアント

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
)

// transcribe は WAV バイト列を whisper.cpp の /inference エンドポイントに送り
// 文字起こしテキストを返す。
//
// whisper.cpp サーバーの起動例:
//   ./build/bin/whisper-server -m models/ggml-base.bin --port 8080
func (s *server) transcribe(audioData []byte, lang string) (string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	// audio/wav ファイルパート
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", `form-data; name="file"; filename="audio.wav"`)
	h.Set("Content-Type", "audio/wav")
	fw, err := mw.CreatePart(h)
	if err != nil {
		return "", err
	}
	if _, err := fw.Write(audioData); err != nil {
		return "", err
	}

	_ = mw.WriteField("response_format", "json")
	_ = mw.WriteField("temperature", "0.0")
	if lang != "" {
		_ = mw.WriteField("language", lang)
	}
	mw.Close()

	req, err := http.NewRequest(http.MethodPost, s.cfg.whisperURL+"/inference", &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("whisper server unreachable: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("whisper server %d: %s", resp.StatusCode, body)
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("decode whisper response: %w", err)
	}
	return result.Text, nil
}
