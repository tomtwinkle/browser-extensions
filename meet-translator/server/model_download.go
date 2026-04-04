// model_download.go – モデルファイルの HTTP ダウンロード
//
// ダウンロード中のプログレス表示付き。
// 途中失敗時の部分ファイルを残さないようアトミックに書き込む。

package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// downloadModel は url からファイルをダウンロードして dest に保存する。
func downloadModel(url, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	tmp := dest + ".download"
	success := false
	defer func() {
		if !success {
			os.Remove(tmp)
		}
	}()

	resp, err := http.Get(url) //nolint:noctx
	if err != nil {
		return fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, url)
	}

	f, err := os.Create(tmp)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	defer f.Close()

	total := resp.ContentLength
	var done int64
	buf := make([]byte, 256*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return fmt.Errorf("write failed: %w", werr)
			}
			done += int64(n)
			if total > 0 {
				fmt.Printf("\r  %.1f / %.1f MB (%.0f%%)%s",
					float64(done)/1e6, float64(total)/1e6,
					float64(done)/float64(total)*100,
					strings.Repeat(" ", 5))
			} else {
				fmt.Printf("\r  %.1f MB downloaded", float64(done)/1e6)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("download failed: %w", err)
		}
	}
	fmt.Printf("\r  %.1f MB done%s\n", float64(done)/1e6, strings.Repeat(" ", 30))

	if err := f.Close(); err != nil {
		return err
	}
	success = true
	return os.Rename(tmp, dest)
}
