package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// ─── downloadModel ───────────────────────────────────────────────────────────

func TestDownloadModel_Success(t *testing.T) {
	content := []byte("fake model data 1234")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(content)))
		w.Write(content)
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "model.bin")
	if err := downloadModel(srv.URL+"/model.bin", dest); err != nil {
		t.Fatalf("downloadModel failed: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("failed to read dest: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("content mismatch: got %q, want %q", got, content)
	}
}

func TestDownloadModel_HTTP404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "model.bin")
	err := downloadModel(srv.URL+"/notfound.bin", dest)
	if err == nil {
		t.Fatal("expected error for HTTP 404")
	}
}

func TestDownloadModel_NoTempFileOnFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Content-Length を嘘にして途中で切断
		w.Header().Set("Content-Length", "1000")
		w.Write([]byte("partial"))
		// ここで接続を切る
	}))
	srv.Close() // 直後に閉じることで次のリクエストを失敗させる

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "model.bin")
	_ = downloadModel(srv.URL+"/model.bin", dest)

	// .download 一時ファイルが残っていないこと
	tmp := dest + ".download"
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Error("temp .download file should be cleaned up on failure")
	}
}

func TestDownloadModel_CreatesParentDirectory(t *testing.T) {
	content := []byte("data")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, string(content))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "subdir1", "subdir2", "model.bin")
	if err := downloadModel(srv.URL+"/model.bin", dest); err != nil {
		t.Fatalf("downloadModel failed: %v", err)
	}
	if _, err := os.Stat(dest); err != nil {
		t.Errorf("dest file not found: %v", err)
	}
}

func TestDownloadModel_AtomicRename(t *testing.T) {
	content := []byte("atomic content")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(content)
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "model.bin")
	if err := downloadModel(srv.URL+"/model.bin", dest); err != nil {
		t.Fatal(err)
	}

	// 最終ファイルのみ存在すること (tmp ファイルなし)
	tmp := dest + ".download"
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Error("temp file should not exist after successful download")
	}
	if _, err := os.Stat(dest); err != nil {
		t.Error("final file should exist")
	}
}
