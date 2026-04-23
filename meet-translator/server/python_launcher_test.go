package main

import (
	"errors"
	"os/exec"
	"reflect"
	"testing"
)

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

func TestResolvePythonLaunchSpec_AutoPrefersPython3(t *testing.T) {
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
	if !spec.canRetryWithUV {
		t.Fatal("expected direct python launch to allow UV fallback in auto mode")
	}
	if len(spec.args) != 0 {
		t.Fatalf("args = %v, want nil", spec.args)
	}
}

func TestResolvePythonLaunchSpec_AutoFallsBackToUV(t *testing.T) {
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
	t.Setenv(pythonLauncherEnvVar, pythonLauncherDirect)
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
	if spec.canRetryWithUV {
		t.Fatal("forced python launcher should not retry with UV")
	}
}

func TestResolvePythonLaunchSpec_ExplicitPythonOverrideSkipsUVFallback(t *testing.T) {
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
	t.Setenv(pythonLauncherEnvVar, "bogus")
	patchExecLookPath(t, map[string]string{
		"python3": "/usr/bin/python3",
	})

	_, err := resolvePythonLaunchSpec("ASR_PYTHON_BIN", "/tmp/requirements.txt")
	if err == nil {
		t.Fatal("expected invalid launcher preference error")
	}
}

func TestRetryWithUV_OnlyOnImportLikeFailures(t *testing.T) {
	patchExecLookPath(t, map[string]string{
		"uv": "/usr/bin/uv",
	})

	spec := pythonLaunchSpec{bin: "/usr/bin/python3", canRetryWithUV: true}
	uvSpec, ok, err := retryWithUV(spec, "/tmp/requirements.txt", "ModuleNotFoundError: No module named 'mlx_lm'")
	if err != nil {
		t.Fatalf("retryWithUV() error = %v", err)
	}
	if !ok {
		t.Fatal("expected UV retry for import error")
	}
	if uvSpec.bin != "/usr/bin/uv" {
		t.Fatalf("uv bin = %q, want %q", uvSpec.bin, "/usr/bin/uv")
	}

	_, ok, err = retryWithUV(spec, "/tmp/requirements.txt", "ffmpeg not found")
	if err != nil {
		t.Fatalf("retryWithUV() error = %v", err)
	}
	if ok {
		t.Fatal("did not expect UV retry for non-import error")
	}
}

func TestResolvePythonLaunchSpec_NoPythonOrUV(t *testing.T) {
	patchExecLookPath(t, map[string]string{})

	_, err := resolvePythonLaunchSpec("ASR_PYTHON_BIN", "/tmp/requirements.txt")
	if err == nil {
		t.Fatal("expected missing launcher error")
	}
	if !errors.Is(err, exec.ErrNotFound) && err.Error() == "" {
		t.Fatalf("unexpected empty error: %v", err)
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
