package main

import (
	"errors"
	"os"
	"os/exec"
	"reflect"
	"testing"
)

func patchCurrentPlatform(t *testing.T, goos, goarch string) {
	t.Helper()
	origGOOS, origGOARCH := currentGOOS, currentGOARCH
	currentGOOS, currentGOARCH = goos, goarch
	t.Cleanup(func() {
		currentGOOS, currentGOARCH = origGOOS, origGOARCH
	})
}

func patchExecLookPath(t *testing.T, paths map[string]string) {
	t.Helper()
	orig := execLookPath
	execLookPath = func(file string) (string, error) {
		if path, ok := paths[file]; ok {
			return path, nil
		}
		return "", exec.ErrNotFound
	}
	t.Cleanup(func() { execLookPath = orig })
}

func patchDetectPythonMachine(t *testing.T, machines map[string]string) {
	t.Helper()
	orig := detectPythonMachine
	detectPythonMachine = func(path string) (string, error) {
		if machine, ok := machines[path]; ok {
			return machine, nil
		}
		return "", errors.New("unknown python machine")
	}
	t.Cleanup(func() { detectPythonMachine = orig })
}

func TestResolvePythonLaunchSpec_AutoPrefersPython311(t *testing.T) {
	patchCurrentPlatform(t, "linux", "amd64")
	patchExecLookPath(t, map[string]string{
		"python3.11": "/usr/bin/python3.11",
		"python3":    "/usr/bin/python3",
		"uv":         "/usr/bin/uv",
	})

	spec, err := resolvePythonLaunchSpec("ASR_PYTHON_BIN", "/tmp/requirements.txt")
	if err != nil {
		t.Fatalf("resolvePythonLaunchSpec() error = %v", err)
	}
	if spec.bin != "/usr/bin/python3.11" {
		t.Fatalf("bin = %q, want %q", spec.bin, "/usr/bin/python3.11")
	}
	if !spec.canRetryWithUV {
		t.Fatal("expected direct python launch to allow UV fallback in auto mode")
	}
	if len(spec.args) != 0 {
		t.Fatalf("args = %v, want nil", spec.args)
	}
}

func TestResolvePythonLaunchSpec_AutoFallsBackToPython3WhenPython311Missing(t *testing.T) {
	patchCurrentPlatform(t, "linux", "amd64")
	patchExecLookPath(t, map[string]string{
		"python3": "/usr/bin/python3",
		"uv":      "/usr/bin/uv",
	})

	spec, err := resolvePythonLaunchSpec("ASR_PYTHON_BIN", "/tmp/requirements.txt")
	if err != nil {
		t.Fatalf("resolvePythonLaunchSpec() error = %v", err)
	}
	if spec.bin != "/usr/bin/python3" {
		t.Fatalf("bin = %q, want %q", spec.bin, "/usr/bin/python3")
	}
}

func TestResolvePythonLaunchSpec_AutoFallsBackToUV(t *testing.T) {
	patchCurrentPlatform(t, "linux", "amd64")
	patchExecLookPath(t, map[string]string{
		"uv": "/usr/bin/uv",
	})

	spec, err := resolvePythonLaunchSpec("ASR_PYTHON_BIN", "/tmp/requirements.txt")
	if err != nil {
		t.Fatalf("resolvePythonLaunchSpec() error = %v", err)
	}
	wantArgs := []string{
		"run",
		"--quiet",
		"--isolated",
		"--no-project",
		"--python", pythonLauncherUVPython,
		"--with-requirements", "/tmp/requirements.txt",
		"python",
	}
	if spec.bin != "/usr/bin/uv" {
		t.Fatalf("bin = %q, want %q", spec.bin, "/usr/bin/uv")
	}
	if spec.canRetryWithUV {
		t.Fatal("UV launch should not retry with UV again")
	}
	if !reflect.DeepEqual(spec.args, wantArgs) {
		t.Fatalf("args = %v, want %v", spec.args, wantArgs)
	}
}

func TestResolvePythonLaunchSpec_ForceUV(t *testing.T) {
	patchCurrentPlatform(t, "linux", "amd64")
	t.Setenv(pythonLauncherEnvVar, pythonLauncherUV)
	patchExecLookPath(t, map[string]string{
		"python3": "/usr/bin/python3",
		"uv":      "/usr/bin/uv",
	})

	spec, err := resolvePythonLaunchSpec("ASR_PYTHON_BIN", "/tmp/requirements.txt")
	if err != nil {
		t.Fatalf("resolvePythonLaunchSpec() error = %v", err)
	}
	if spec.bin != "/usr/bin/uv" {
		t.Fatalf("bin = %q, want %q", spec.bin, "/usr/bin/uv")
	}
}

func TestResolvePythonLaunchSpec_ForcePython(t *testing.T) {
	patchCurrentPlatform(t, "linux", "amd64")
	t.Setenv(pythonLauncherEnvVar, pythonLauncherDirect)
	patchExecLookPath(t, map[string]string{
		"python3.11": "/usr/bin/python3.11",
		"python3":    "/usr/bin/python3",
		"uv":         "/usr/bin/uv",
	})

	spec, err := resolvePythonLaunchSpec("ASR_PYTHON_BIN", "/tmp/requirements.txt")
	if err != nil {
		t.Fatalf("resolvePythonLaunchSpec() error = %v", err)
	}
	if spec.bin != "/usr/bin/python3.11" {
		t.Fatalf("bin = %q, want %q", spec.bin, "/usr/bin/python3.11")
	}
	if spec.canRetryWithUV {
		t.Fatal("forced python launcher should not retry with UV")
	}
}

func TestResolvePythonLaunchSpec_ExplicitPythonOverrideSkipsUVFallback(t *testing.T) {
	patchCurrentPlatform(t, "linux", "amd64")
	t.Setenv("LLM_PYTHON_BIN", "/custom/python")
	patchExecLookPath(t, map[string]string{
		"uv": "/usr/bin/uv",
	})

	spec, err := resolvePythonLaunchSpec("LLM_PYTHON_BIN", "/tmp/requirements.txt")
	if err != nil {
		t.Fatalf("resolvePythonLaunchSpec() error = %v", err)
	}
	if spec.bin != "/custom/python" {
		t.Fatalf("bin = %q, want %q", spec.bin, "/custom/python")
	}
	if spec.canRetryWithUV {
		t.Fatal("explicit python override should not retry with UV")
	}
}

func TestResolvePythonLaunchSpec_InvalidPreference(t *testing.T) {
	patchCurrentPlatform(t, "linux", "amd64")
	t.Setenv(pythonLauncherEnvVar, "bogus")
	patchExecLookPath(t, map[string]string{
		"python3": "/usr/bin/python3",
	})

	_, err := resolvePythonLaunchSpec("ASR_PYTHON_BIN", "/tmp/requirements.txt")
	if err == nil {
		t.Fatal("expected invalid launcher preference error")
	}
}

func TestRetryWithUV_OnDependencyFailures(t *testing.T) {
	patchCurrentPlatform(t, "linux", "amd64")
	patchExecLookPath(t, map[string]string{
		"uv": "/usr/bin/uv",
	})

	spec := pythonLaunchSpec{bin: "/usr/bin/python3", canRetryWithUV: true}
	tests := []struct {
		name      string
		failure   string
		wantRetry bool
	}{
		{
			name:      "missing module",
			failure:   "ModuleNotFoundError: No module named 'mlx_lm'",
			wantRetry: true,
		},
		{
			name:      "dependency attribute mismatch",
			failure:   "AttributeError: module 'torchaudio' has no attribute 'AudioMetaData'",
			wantRetry: true,
		},
		{
			name:      "dependency api mismatch",
			failure:   "TypeError: load_model() got an unexpected keyword argument 'vad_method'",
			wantRetry: true,
		},
		{
			name:      "dependency runtime unavailable",
			failure:   "RuntimeError: Numpy is not available",
			wantRetry: true,
		},
		{
			name:      "non dependency failure",
			failure:   "ffmpeg not found",
			wantRetry: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			uvSpec, ok, err := retryWithUV(spec, "/tmp/requirements.txt", tc.failure)
			if err != nil {
				t.Fatalf("retryWithUV() error = %v", err)
			}
			if ok != tc.wantRetry {
				t.Fatalf("retryWithUV() retry = %v, want %v", ok, tc.wantRetry)
			}
			if !tc.wantRetry {
				return
			}
			if uvSpec.bin != "/usr/bin/uv" {
				t.Fatalf("uv bin = %q, want %q", uvSpec.bin, "/usr/bin/uv")
			}
		})
	}
}

func TestResolvePythonLaunchSpec_NoPythonOrUV(t *testing.T) {
	patchCurrentPlatform(t, "linux", "amd64")
	patchExecLookPath(t, map[string]string{})

	_, err := resolvePythonLaunchSpec("ASR_PYTHON_BIN", "/tmp/requirements.txt")
	if err == nil {
		t.Fatal("expected missing launcher error")
	}
	if !errors.Is(err, exec.ErrNotFound) && err.Error() == "" {
		t.Fatalf("unexpected empty error: %v", err)
	}
}

func TestResolvePythonLaunchSpec_AutoSkipsIntelPythonOnAppleSilicon(t *testing.T) {
	patchCurrentPlatform(t, "darwin", "arm64")
	patchExecLookPath(t, map[string]string{
		"python3.11": "/usr/local/bin/python3.11",
		"python3":    "/opt/homebrew/bin/python3",
		"uv":         "/usr/bin/uv",
	})
	patchDetectPythonMachine(t, map[string]string{
		"/usr/local/bin/python3.11": "x86_64",
		"/opt/homebrew/bin/python3": "arm64",
	})

	spec, err := resolvePythonLaunchSpec("LLM_PYTHON_BIN", "/tmp/requirements.txt")
	if err != nil {
		t.Fatalf("resolvePythonLaunchSpec() error = %v", err)
	}
	if spec.bin != "/opt/homebrew/bin/python3" {
		t.Fatalf("bin = %q, want %q", spec.bin, "/opt/homebrew/bin/python3")
	}
}

func TestResolvePythonLaunchSpec_AutoFallsBackToManagedUVWhenOnlyIntelPythonExistsOnAppleSilicon(t *testing.T) {
	patchCurrentPlatform(t, "darwin", "arm64")
	patchExecLookPath(t, map[string]string{
		"python3.11": "/usr/local/bin/python3.11",
		"uv":         "/usr/bin/uv",
	})
	patchDetectPythonMachine(t, map[string]string{
		"/usr/local/bin/python3.11": "x86_64",
	})

	spec, err := resolvePythonLaunchSpec("LLM_PYTHON_BIN", "/tmp/requirements.txt")
	if err != nil {
		t.Fatalf("resolvePythonLaunchSpec() error = %v", err)
	}
	wantArgs := []string{
		"run",
		"--quiet",
		"--isolated",
		"--no-project",
		"--managed-python",
		"--python", pythonLauncherUVPython,
		"--with-requirements", "/tmp/requirements.txt",
		"python",
	}
	if spec.bin != "/usr/bin/uv" {
		t.Fatalf("bin = %q, want %q", spec.bin, "/usr/bin/uv")
	}
	if !reflect.DeepEqual(spec.args, wantArgs) {
		t.Fatalf("args = %v, want %v", spec.args, wantArgs)
	}
}

func TestIsExpectedPythonWorkerShutdownError_InterruptWithKeyboardInterrupt(t *testing.T) {
	err := errors.New("signal: interrupt")
	stderr := "Traceback ... KeyboardInterrupt"
	if !isExpectedPythonWorkerShutdownError(err, stderr) {
		t.Fatal("expected KeyboardInterrupt shutdown to be ignored")
	}
}

func TestIsExpectedPythonWorkerShutdownError_RegularError(t *testing.T) {
	err := errors.New("exit status 1")
	stderr := "ModuleNotFoundError: No module named mlx_lm"
	if isExpectedPythonWorkerShutdownError(err, stderr) {
		t.Fatal("did not expect regular startup error to be ignored")
	}
}

func TestPythonWorkerTranscriberCloseForRetryPreservesTempDir(t *testing.T) {
	tempDir := t.TempDir()
	worker := &pythonWorkerTranscriber{tempDir: tempDir}
	if err := worker.closeForRetry(); err != nil {
		t.Fatalf("closeForRetry() error = %v", err)
	}
	if _, err := os.Stat(tempDir); err != nil {
		t.Fatalf("temp dir removed during retry close: %v", err)
	}
}

func TestPythonWorkerTranscriberCloseRemovesTempDir(t *testing.T) {
	parent := t.TempDir()
	tempDir := parent + "/worker"
	if err := os.Mkdir(tempDir, 0o755); err != nil {
		t.Fatalf("Mkdir() error = %v", err)
	}
	worker := &pythonWorkerTranscriber{tempDir: tempDir}
	if err := worker.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if _, err := os.Stat(tempDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temp dir still exists after Close(): %v", err)
	}
}

func TestPythonMLXBackendCloseForRetryPreservesTempDir(t *testing.T) {
	tempDir := t.TempDir()
	worker := &pythonMLXBackend{tempDir: tempDir}
	if err := worker.closeForRetry(); err != nil {
		t.Fatalf("closeForRetry() error = %v", err)
	}
	if _, err := os.Stat(tempDir); err != nil {
		t.Fatalf("temp dir removed during retry close: %v", err)
	}
}

func TestPythonMLXBackendCloseRemovesTempDir(t *testing.T) {
	parent := t.TempDir()
	tempDir := parent + "/worker"
	if err := os.Mkdir(tempDir, 0o755); err != nil {
		t.Fatalf("Mkdir() error = %v", err)
	}
	worker := &pythonMLXBackend{tempDir: tempDir}
	if err := worker.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if _, err := os.Stat(tempDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temp dir still exists after Close(): %v", err)
	}
}
