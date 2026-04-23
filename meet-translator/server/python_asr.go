package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	_ "embed"
)

//go:embed python/asr_worker.py
var embeddedASRWorker string

//go:embed python/requirements-asr.txt
var embeddedASRRequirements string

type pythonWorkerRequest struct {
	Action    string `json:"action,omitempty"`
	AudioPath string `json:"audio_path,omitempty"`
	Language  string `json:"language,omitempty"`
	Prompt    string `json:"prompt,omitempty"`
}

type pythonWorkerResponse struct {
	Status           string `json:"status,omitempty"`
	Text             string `json:"text,omitempty"`
	DetectedLanguage string `json:"detected_language,omitempty"`
	Error            string `json:"error,omitempty"`
	RequirementsPath string `json:"requirements_path,omitempty"`
}

type pythonWorkerTranscriber struct {
	backend      ASRBackendKind
	modelRef     string
	tempDir      string
	cmd          *exec.Cmd
	stdin        io.WriteCloser
	enc          *json.Encoder
	dec          *json.Decoder
	stderr       bytes.Buffer
	closeOnce    sync.Once
	requestMutex sync.Mutex
}

func newPythonWorkerTranscriber(backend ASRBackendKind, modelRef string) (transcriber, error) {
	tempDir, scriptPath, requirementsPath, err := materializePythonASRFiles()
	if err != nil {
		return nil, err
	}
	launchSpec, err := resolvePythonLaunchSpec("ASR_PYTHON_BIN", requirementsPath)
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, err
	}

	device := strings.TrimSpace(os.Getenv("ASR_PYTHON_DEVICE"))
	if device == "" {
		device = "cpu"
	}

	return startPythonWorkerTranscriber(
		launchSpec,
		backend,
		modelRef,
		device,
		tempDir,
		scriptPath,
		requirementsPath,
	)
}

func startPythonWorkerTranscriber(
	launchSpec pythonLaunchSpec,
	backend ASRBackendKind,
	modelRef string,
	device string,
	tempDir string,
	scriptPath string,
	requirementsPath string,
) (transcriber, error) {
	cmd := launchSpec.command(
		scriptPath,
		"--backend", string(backend),
		"--model", modelRef,
		"--device", device,
		"--requirements-path", requirementsPath,
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("failed to capture %s worker stdout: %w", backend, err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("failed to capture %s worker stdin: %w", backend, err)
	}

	worker := &pythonWorkerTranscriber{
		backend:  backend,
		modelRef: modelRef,
		tempDir:  tempDir,
		cmd:      cmd,
		stdin:    stdin,
		enc:      json.NewEncoder(stdin),
		dec:      json.NewDecoder(stdout),
	}
	cmd.Stderr = &worker.stderr

	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("failed to start %s worker: %w", backend, err)
	}

	var ready pythonWorkerResponse
	if err := worker.dec.Decode(&ready); err != nil {
		stderrText := worker.stderr.String()
		_ = worker.Close()
		if uvSpec, ok, retryErr := retryWithUV(launchSpec, requirementsPath, stderrText); retryErr != nil {
			return nil, retryErr
		} else if ok {
			return startPythonWorkerTranscriber(uvSpec, backend, modelRef, device, tempDir, scriptPath, requirementsPath)
		}
		return nil, fmt.Errorf("failed to initialize %s worker: %w%s", backend, err, worker.stderrSuffix())
	}
	if ready.Status != "ready" {
		if uvSpec, ok, retryErr := retryWithUV(launchSpec, requirementsPath, ready.Error+"\n"+worker.stderr.String()); retryErr != nil {
			_ = worker.Close()
			return nil, retryErr
		} else if ok {
			_ = worker.Close()
			return startPythonWorkerTranscriber(uvSpec, backend, modelRef, device, tempDir, scriptPath, requirementsPath)
		}
		_ = worker.Close()
		return nil, fmt.Errorf("%s worker failed to initialize: %s%s", backend, ready.Error, pythonInstallHint(ready.RequirementsPath))
	}

	return worker, nil
}

func (w *pythonWorkerTranscriber) Transcribe(audioData []byte, lang, prompt string, _ func(string, ...any)) (string, string, error) {
	tmp, err := os.CreateTemp("", "meet-translator-asr-*.wav")
	if err != nil {
		return "", "", fmt.Errorf("failed to create temporary audio file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := tmp.Write(audioData); err != nil {
		tmp.Close()
		return "", "", fmt.Errorf("failed to write temporary audio file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", "", fmt.Errorf("failed to finalize temporary audio file: %w", err)
	}

	req := pythonWorkerRequest{
		AudioPath: tmpPath,
		Language:  strings.TrimSpace(lang),
		Prompt:    strings.TrimSpace(prompt),
	}

	w.requestMutex.Lock()
	defer w.requestMutex.Unlock()

	if err := w.enc.Encode(req); err != nil {
		return "", "", fmt.Errorf("failed to send request to %s worker: %w%s", w.backend, err, w.stderrSuffix())
	}

	var resp pythonWorkerResponse
	if err := w.dec.Decode(&resp); err != nil {
		return "", "", fmt.Errorf("failed to read response from %s worker: %w%s", w.backend, err, w.stderrSuffix())
	}
	if resp.Status != "ok" {
		return "", "", fmt.Errorf("%s transcription failed: %s%s", w.backend, resp.Error, pythonInstallHint(resp.RequirementsPath))
	}
	return resp.Text, resp.DetectedLanguage, nil
}

func (w *pythonWorkerTranscriber) Close() error {
	var closeErr error
	w.closeOnce.Do(func() {
		if w.stdin != nil {
			w.requestMutex.Lock()
			_ = w.enc.Encode(pythonWorkerRequest{Action: "shutdown"})
			_ = w.stdin.Close()
			w.requestMutex.Unlock()
			w.stdin = nil
		}
		if w.cmd != nil {
			if err := w.cmd.Wait(); err != nil {
				if !isExpectedPythonWorkerShutdownError(err, w.stderr.String()) {
					closeErr = fmt.Errorf("%s worker exited with error: %w%s", w.backend, err, w.stderrSuffix())
				}
			}
		}
		if w.tempDir != "" {
			_ = os.RemoveAll(w.tempDir)
		}
	})
	return closeErr
}

func (w *pythonWorkerTranscriber) stderrSuffix() string {
	if w == nil {
		return ""
	}
	msg := strings.TrimSpace(w.stderr.String())
	if msg == "" {
		return ""
	}
	return "\n  worker stderr: " + msg
}

func materializePythonASRFiles() (tempDir, scriptPath, requirementsPath string, err error) {
	tempDir, err = os.MkdirTemp("", "meet-translator-asr-*")
	if err != nil {
		return "", "", "", fmt.Errorf("failed to create temporary ASR worker directory: %w", err)
	}

	scriptPath = filepath.Join(tempDir, "asr_worker.py")
	requirementsPath = filepath.Join(tempDir, "requirements-asr.txt")

	if err := os.WriteFile(scriptPath, []byte(embeddedASRWorker), 0o700); err != nil {
		_ = os.RemoveAll(tempDir)
		return "", "", "", fmt.Errorf("failed to write ASR worker script: %w", err)
	}
	if err := os.WriteFile(requirementsPath, []byte(embeddedASRRequirements), 0o600); err != nil {
		_ = os.RemoveAll(tempDir)
		return "", "", "", fmt.Errorf("failed to write ASR worker requirements: %w", err)
	}
	return tempDir, scriptPath, requirementsPath, nil
}

func pythonInstallHint(_ string) string {
	return "\n  install uv to auto-provision Python dependencies on demand, or install them manually with: python3 -m pip install -r ./python/requirements-asr.txt\n  ensure ffmpeg is installed and available on PATH"
}
