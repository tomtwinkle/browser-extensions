package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunScoreCheckWritesContentFreeUntrustedReport(t *testing.T) {
	root := t.TempDir()
	manifestPath := filepath.Join(root, "manifest.jsonl")
	outputsPath := filepath.Join(root, "outputs.jsonl")
	manifest := `{"schemaVersion":1,"caseId":"mt.contract","track":"mt-only","split":"contract","sourceLanguage":"en","targetLanguage":"ja","sourceText":"private source sentence","referenceTranslations":["非公開の参照訳"],"annotationVersion":"v1","annotationStatus":"contract-test","fixtureKind":"synthetic"}` + "\n"
	outputs := `{"caseId":"mt.contract","split":"contract","translationText":"非公開の出力訳"}` + "\n"
	if err := os.WriteFile(manifestPath, []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outputsPath, []byte(outputs), 0o600); err != nil {
		t.Fatal(err)
	}
	var result bytes.Buffer
	if err := runScoreCheck(TrackMTOnly, "contract", manifestPath, outputsPath, root, &result); err != nil {
		t.Fatal(err)
	}
	encoded := result.String()
	for _, content := range []string{"private source sentence", "非公開の参照訳", "非公開の出力訳"} {
		if strings.Contains(encoded, content) {
			t.Fatalf("report leaked input content %q: %s", content, encoded)
		}
	}
	for _, required := range []string{`"mode": "score-only-untrusted"`, `"qualityEvidence": false`, `"productStatus": "not-evaluated"`, `"manifestSHA256":`, `"outputsSHA256":`} {
		if !strings.Contains(encoded, required) {
			t.Fatalf("report is missing %q: %s", required, encoded)
		}
	}
}

func TestRunQualificationFilesDoesNotTrustDetachedCallerKey(t *testing.T) {
	root := t.TempDir()
	report := validQualificationReport()
	report.TestDouble = qualificationBool(true)
	report.Dataset.Synthetic = qualificationBool(true)
	reportRaw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, _ := testQualificationSigningKey()
	attestationRaw := signedTestQualificationEnvelope(t, reportRaw, report, privateKey, "caller-selected-key")
	outputsRaw, measurementsRaw := testQualificationArtifacts(t, report)
	reportPath := filepath.Join(root, "report.json")
	attestationPath := filepath.Join(root, "attestation.json")
	outputsPath := filepath.Join(root, "outputs.bin")
	measurementsPath := filepath.Join(root, "measurements.json")
	if err := os.WriteFile(reportPath, reportRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(attestationPath, attestationRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outputsPath, outputsRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(measurementsPath, measurementsRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	assessment, err := runQualificationFiles(reportPath, attestationPath, outputsPath, measurementsPath, &output)
	if err != nil {
		t.Fatalf("runQualificationFiles() error = %v", err)
	}
	if assessment.Status != QualificationStatusBlocked || qualificationExitCode(assessment.Status) != 2 || !hasQualificationFinding(assessment, "TRUSTED_PROVENANCE_UNAVAILABLE") {
		t.Fatalf("file-mode assessment = %#v, exit=%d; caller-selected signer cannot qualify", assessment, qualificationExitCode(assessment.Status))
	}
}

func TestRunQualificationFilesRequiresBothAttestedArtifacts(t *testing.T) {
	root := t.TempDir()
	reportPath := filepath.Join(root, "report.json")
	if err := os.WriteFile(reportPath, []byte(`{"schemaVersion":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := runQualificationFiles(reportPath, "attestation.json", "outputs.bin", "", &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "requires both") {
		t.Fatalf("runQualificationFiles() error = %v, want missing artifact error", err)
	}
}

func TestReadQualificationFileRejectsOversizeArtifact(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversize.json")
	if err := os.WriteFile(path, []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readQualificationFile(path, 4); err == nil {
		t.Fatal("oversize artifact was accepted")
	}
}
