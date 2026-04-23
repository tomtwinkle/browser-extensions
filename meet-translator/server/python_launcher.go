package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const (
	pythonLauncherEnvVar   = "MEET_TRANSLATOR_PYTHON_LAUNCHER"
	pythonLauncherAuto     = "auto"
	pythonLauncherDirect   = "python"
	pythonLauncherUV       = "uv"
	pythonLauncherUVPython = "3.11"
)

var execLookPath = exec.LookPath

type pythonLaunchSpec struct {
	bin            string
	args           []string
	canRetryWithUV bool
}

func resolvePythonLaunchSpec(envVar, requirementsPath string) (pythonLaunchSpec, error) {
	preference, err := pythonLauncherPreference()
	if err != nil {
		return pythonLaunchSpec{}, err
	}

	explicitPython := strings.TrimSpace(os.Getenv(envVar))
	switch preference {
	case pythonLauncherUV:
		return resolveUVLaunchSpec(requirementsPath)
	case pythonLauncherDirect:
		return resolveDirectPythonLaunchSpec(explicitPython, false)
	case pythonLauncherAuto:
		return resolveAutoPythonLaunchSpec(explicitPython, requirementsPath)
	default:
		return pythonLaunchSpec{}, fmt.Errorf("unsupported python launcher preference: %s", preference)
	}
}

func pythonLauncherPreference() (string, error) {
	preference := strings.ToLower(strings.TrimSpace(os.Getenv(pythonLauncherEnvVar)))
	switch preference {
	case "", pythonLauncherAuto:
		return pythonLauncherAuto, nil
	case pythonLauncherDirect:
		return pythonLauncherDirect, nil
	case pythonLauncherUV:
		return pythonLauncherUV, nil
	default:
		return "", fmt.Errorf("invalid %s=%q (expected auto, python, or uv)", pythonLauncherEnvVar, preference)
	}
}

func resolveAutoPythonLaunchSpec(explicitPython, requirementsPath string) (pythonLaunchSpec, error) {
	if explicitPython != "" {
		return pythonLaunchSpec{bin: explicitPython}, nil
	}

	if path, err := execLookPath("python3"); err == nil {
		return pythonLaunchSpec{bin: path, canRetryWithUV: true}, nil
	}
	if path, err := execLookPath("python"); err == nil {
		return pythonLaunchSpec{bin: path, canRetryWithUV: true}, nil
	}

	if spec, err := resolveUVLaunchSpec(requirementsPath); err == nil {
		return spec, nil
	}

	return pythonLaunchSpec{}, fmt.Errorf("python backend selected but neither python3/python nor uv was found in PATH")
}

func resolveDirectPythonLaunchSpec(explicitPython string, canRetryWithUV bool) (pythonLaunchSpec, error) {
	if explicitPython != "" {
		return pythonLaunchSpec{bin: explicitPython, canRetryWithUV: canRetryWithUV}, nil
	}

	if path, err := execLookPath("python3"); err == nil {
		return pythonLaunchSpec{bin: path, canRetryWithUV: canRetryWithUV}, nil
	}
	if path, err := execLookPath("python"); err == nil {
		return pythonLaunchSpec{bin: path, canRetryWithUV: canRetryWithUV}, nil
	}

	return pythonLaunchSpec{}, fmt.Errorf("python backend selected but neither python3 nor python was found in PATH")
}

func resolveUVLaunchSpec(requirementsPath string) (pythonLaunchSpec, error) {
	uvPath, err := execLookPath("uv")
	if err != nil {
		return pythonLaunchSpec{}, fmt.Errorf("uv is not available in PATH")
	}

	return pythonLaunchSpec{
		bin: uvPath,
		args: []string{
			"run",
			"--quiet",
			"--isolated",
			"--no-project",
			"--python", pythonLauncherUVPython,
			"--with-requirements", requirementsPath,
			"python",
		},
	}, nil
}

func (spec pythonLaunchSpec) command(scriptPath string, scriptArgs ...string) *exec.Cmd {
	args := append([]string{}, spec.args...)
	args = append(args, scriptPath)
	args = append(args, scriptArgs...)
	return exec.Command(spec.bin, args...)
}

func retryWithUV(spec pythonLaunchSpec, requirementsPath, failureText string) (pythonLaunchSpec, bool, error) {
	if !spec.canRetryWithUV || !looksLikeMissingPythonDependency(failureText) {
		return pythonLaunchSpec{}, false, nil
	}

	uvSpec, err := resolveUVLaunchSpec(requirementsPath)
	if err != nil {
		return pythonLaunchSpec{}, false, nil
	}
	return uvSpec, true, nil
}

func looksLikeMissingPythonDependency(message string) bool {
	lower := strings.ToLower(message)
	return strings.Contains(lower, "no module named") ||
		strings.Contains(lower, "modulenotfounderror") ||
		strings.Contains(lower, "importerror:") ||
		strings.Contains(lower, "cannot import name")
}

func isExpectedPythonWorkerShutdownError(err error, stderr string) bool {
	if err == nil {
		return false
	}

	lowerErr := strings.ToLower(err.Error())
	lowerStderr := strings.ToLower(stderr)
	if strings.Contains(lowerErr, "signal: interrupt") && strings.Contains(lowerStderr, "keyboardinterrupt") {
		return true
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if exitErr.ExitCode() == 130 {
			return true
		}
	}
	return false
}
