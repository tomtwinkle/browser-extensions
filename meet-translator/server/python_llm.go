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

//go:embed python/llm_worker.py
var embeddedLLMWorker string

//go:embed python/requirements-llm.txt
var embeddedLLMRequirements string

type llmWorkerRequest struct {
	Action      string  `json:"action,omitempty"`
	Prompt      string  `json:"prompt,omitempty"`
	MaxTokens   int     `json:"max_tokens,omitempty"`
	Temperature float32 `json:"temperature,omitempty"`
}

type llmWorkerResponse struct {
	Status           string `json:"status,omitempty"`
	Text             string `json:"text,omitempty"`
	Error            string `json:"error,omitempty"`
	RequirementsPath string `json:"requirements_path,omitempty"`
}

type pythonMLXBackend struct {
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

func newPythonMLXBackend(modelRef string) (llmBackend, error) {
	if currentGOOS != "darwin" || currentGOARCH != "arm64" {
		return nil, fmt.Errorf("MLX backend requires Apple Silicon (darwin/arm64)")
	}

	tempDir, scriptPath, requirementsPath, err := materializePythonLLMFiles()
	if err != nil {
		return nil, err
	}
	launchSpec, err := resolvePythonLaunchSpec("LLM_PYTHON_BIN", requirementsPath)
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, err
	}

	return startPythonMLXBackend(launchSpec, modelRef, tempDir, scriptPath, requirementsPath)
}

func startPythonMLXBackend(
	launchSpec pythonLaunchSpec,
	modelRef string,
	tempDir string,
	scriptPath string,
	requirementsPath string,
) (llmBackend, error) {
	cmd := launchSpec.command(
		scriptPath,
		"--model", modelRef,
		"--requirements-path", requirementsPath,
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("failed to capture MLX worker stdout: %w", err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return nil, fmt.Errorf("failed to capture MLX worker stdin: %w", err)
	}

	worker := &pythonMLXBackend{
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
		return nil, fmt.Errorf("failed to start MLX worker: %w", err)
	}

	var ready llmWorkerResponse
	if err := worker.dec.Decode(&ready); err != nil {
		stderrText := worker.stderr.String()
		_ = worker.Close()
		if uvSpec, ok, retryErr := retryWithUV(launchSpec, requirementsPath, stderrText); retryErr != nil {
			return nil, retryErr
		} else if ok {
			return startPythonMLXBackend(uvSpec, modelRef, tempDir, scriptPath, requirementsPath)
		}
		return nil, fmt.Errorf("failed to initialize MLX worker: %w%s", err, worker.stderrSuffix())
	}
	if ready.Status != "ready" {
		if uvSpec, ok, retryErr := retryWithUV(launchSpec, requirementsPath, ready.Error+"\n"+worker.stderr.String()); retryErr != nil {
			_ = worker.Close()
			return nil, retryErr
		} else if ok {
			_ = worker.Close()
			return startPythonMLXBackend(uvSpec, modelRef, tempDir, scriptPath, requirementsPath)
		}
		_ = worker.Close()
		return nil, fmt.Errorf("MLX worker failed to initialize: %s%s", ready.Error, llmInstallHint(ready.RequirementsPath))
	}

	return worker, nil
}

func (w *pythonMLXBackend) Generate(prompt string, maxTokens int, temperature float32) (string, error) {
	req := llmWorkerRequest{
		Prompt:      prompt,
		MaxTokens:   maxTokens,
		Temperature: temperature,
	}

	w.requestMutex.Lock()
	defer w.requestMutex.Unlock()

	if err := w.enc.Encode(req); err != nil {
		return "", fmt.Errorf("failed to send request to MLX worker: %w%s", err, w.stderrSuffix())
	}

	var resp llmWorkerResponse
	if err := w.dec.Decode(&resp); err != nil {
		return "", fmt.Errorf("failed to read response from MLX worker: %w%s", err, w.stderrSuffix())
	}
	if resp.Status != "ok" {
		return "", fmt.Errorf("MLX generation failed: %s%s", resp.Error, llmInstallHint(resp.RequirementsPath))
	}
	return resp.Text, nil
}

func (w *pythonMLXBackend) Close() error {
	var closeErr error
	w.closeOnce.Do(func() {
		if w.stdin != nil {
			w.requestMutex.Lock()
			_ = w.enc.Encode(llmWorkerRequest{Action: "shutdown"})
			_ = w.stdin.Close()
			w.requestMutex.Unlock()
			w.stdin = nil
		}
		if w.cmd != nil {
			if err := w.cmd.Wait(); err != nil {
				if !isExpectedPythonWorkerShutdownError(err, w.stderr.String()) {
					closeErr = fmt.Errorf("MLX worker exited with error: %w%s", err, w.stderrSuffix())
				}
			}
		}
		if w.tempDir != "" {
			_ = os.RemoveAll(w.tempDir)
		}
	})
	return closeErr
}

func (w *pythonMLXBackend) stderrSuffix() string {
	if w == nil {
		return ""
	}
	msg := strings.TrimSpace(w.stderr.String())
	if msg == "" {
		return ""
	}
	return "\n  worker stderr: " + msg
}

func materializePythonLLMFiles() (tempDir, scriptPath, requirementsPath string, err error) {
	tempDir, err = os.MkdirTemp("", "meet-translator-llm-*")
	if err != nil {
		return "", "", "", fmt.Errorf("failed to create temporary LLM worker directory: %w", err)
	}

	scriptPath = filepath.Join(tempDir, "llm_worker.py")
	requirementsPath = filepath.Join(tempDir, "requirements-llm.txt")

	if err := os.WriteFile(scriptPath, []byte(embeddedLLMWorker), 0o700); err != nil {
		_ = os.RemoveAll(tempDir)
		return "", "", "", fmt.Errorf("failed to write LLM worker script: %w", err)
	}
	if err := os.WriteFile(requirementsPath, []byte(embeddedLLMRequirements), 0o600); err != nil {
		_ = os.RemoveAll(tempDir)
		return "", "", "", fmt.Errorf("failed to write LLM worker requirements: %w", err)
	}
	return tempDir, scriptPath, requirementsPath, nil
}

func llmInstallHint(_ string) string {
	return "\n  install uv to auto-provision MLX dependencies on demand, or install them manually with: python3 -m pip install -r ./python/requirements-llm.txt"
}
