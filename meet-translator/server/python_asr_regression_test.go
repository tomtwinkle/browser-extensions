package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWhisperXWorkerNoSpeechReturnsEmptyWithoutError(t *testing.T) {
	spec, err := resolveDirectPythonLaunchSpec("", false)
	if err != nil {
		t.Skipf("python interpreter not available: %v", err)
	}

	stubDir := t.TempDir()
	writeTestFile(t, filepath.Join(stubDir, "numpy.py"), "# minimal stub for asr_worker import\n")
	writeTestFile(t, filepath.Join(stubDir, "torch.py"), `
class _Tensor:
    def __init__(self, value):
        self.value = value

    def unsqueeze(self, _axis):
        return self

def from_numpy(value):
    return _Tensor(value)
`)
	writeTestFile(t, filepath.Join(stubDir, "whisperx", "__init__.py"), `
class FakeOptions:
    def __init__(self):
        self.initial_prompt = None

class FakeModel:
    def __init__(self):
        self.options = FakeOptions()
        self._vad_params = {"vad_onset": 0.5, "vad_offset": 0.3}

    def vad_model(self, request):
        return request

    def transcribe(self, audio, batch_size=8, language=None):
        raise AssertionError("transcribe should not be called for no-speech audio")

def load_model(model_ref, device=None, compute_type=None, asr_options=None):
    return FakeModel()
`)
	writeTestFile(t, filepath.Join(stubDir, "whisperx", "audio.py"), "SAMPLE_RATE = 16000\n")
	writeTestFile(t, filepath.Join(stubDir, "whisperx", "vad.py"), `
def merge_chunks(_segments, _chunk_size, onset=None, offset=None):
    return []
`)

	serverDir := serverTestDir(t)
	pythonPath := strings.Join([]string{
		stubDir,
		filepath.Join(serverDir, "python"),
	}, string(os.PathListSeparator))
	script := `
import json
import asr_worker

class FakeAudio:
    def __len__(self):
        return 16000

asr_worker.load_wav_float32 = lambda _path: FakeAudio()

backend = asr_worker.WhisperXBackend("fake-model", "cpu")
text, detected = backend.transcribe("ignored.wav", "en", "glossary hint")
print(json.dumps({"text": text, "detected": detected}))
`

	cmd := exec.Command(spec.bin, "-c", script)
	cmd.Env = append(os.Environ(),
		"PYTHONDONTWRITEBYTECODE=1",
		"PYTHONPATH="+pythonPath,
	)
	cmd.Dir = serverDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("python worker regression script failed: %v\n%s", err, out)
	}

	var resp struct {
		Text     string `json:"text"`
		Detected string `json:"detected"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("json.Unmarshal() error = %v, output = %s", err, out)
	}
	if resp.Text != "" {
		t.Fatalf("text = %q, want empty", resp.Text)
	}
	if resp.Detected != "en" {
		t.Fatalf("detected = %q, want %q", resp.Detected, "en")
	}
}

func TestExecuteTestWorkflowPinsWhisperXDependencies(t *testing.T) {
	workflowPath := filepath.Join(serverTestDir(t), "..", "..", ".github", "workflows", "execute-test.yml")
	content, err := os.ReadFile(workflowPath)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", workflowPath, err)
	}

	text := string(content)
	wantSnippets := []string{
		`whisperx*|whisperX*|kotoba-whisper-v2.2-faster|RoachLin/kotoba-whisper-v2.2-faster)`,
		`"torch==2.2.2"`,
		`"torchaudio==2.2.2"`,
		`"transformers<5"`,
		`"numpy<2"`,
		`matplotlib`,
		`whisperx`,
	}
	for _, want := range wantSnippets {
		if !strings.Contains(text, want) {
			t.Fatalf("workflow missing %q", want)
		}
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%q) error = %v", path, err)
	}
}

func serverTestDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) failed")
	}
	return filepath.Dir(file)
}
