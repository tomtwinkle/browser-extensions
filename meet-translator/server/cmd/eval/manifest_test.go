package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadCasesKeepsEvaluationTracksSeparate(t *testing.T) {
	input := strings.Join([]string{
		`{"schemaVersion":1,"caseId":"mt-1","track":"mt-only","split":"development","sourceLanguage":"en","targetLanguage":"ja","sourceText":"The meeting starts at 10.","referenceTranslations":["会議は10時に始まります。"],"meetingId":"meeting-dev-1","speakerGroup":"speaker-dev-1","annotationVersion":"draft-1","annotationStatus":"pending"}`,
		`{"schemaVersion":1,"caseId":"asr-1","track":"asr-only","split":"contract","sourceLanguage":"en","targetLanguage":"","audioRef":"eval/fixtures/audio/silence_100ms.wav","audioSHA256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","referenceText":"","annotationVersion":"contract-1","annotationStatus":"contract-test","fixtureKind":"synthetic"}`,
	}, "\n")

	if _, err := LoadCases(strings.NewReader(input), TrackMTOnly); err == nil {
		t.Fatal("expected mixed-track manifest to be rejected")
	}
}

func TestLoadCasesAcceptsValidMTOnlyCase(t *testing.T) {
	input := `{"schemaVersion":1,"caseId":"mt-1","track":"mt-only","split":"development","sourceLanguage":"en","targetLanguage":"ja","sourceText":"The meeting starts at 10.","referenceTranslations":["会議は10時に始まります。"],"meetingId":"meeting-dev-1","speakerGroup":"speaker-dev-1","annotationVersion":"draft-1","annotationStatus":"pending"}`

	cases, err := LoadCases(strings.NewReader(input), TrackMTOnly)
	if err != nil {
		t.Fatalf("LoadCases() error = %v", err)
	}
	if len(cases) != 1 || cases[0].CaseID != "mt-1" {
		t.Fatalf("LoadCases() = %#v, want one mt-1 case", cases)
	}
	if PromotionEligible(cases[0]) {
		t.Fatal("draft development data must not be promotion eligible")
	}
}

func TestLoadCasesRejectsSyntheticQualityHoldout(t *testing.T) {
	input := `{"schemaVersion":1,"caseId":"synthetic-holdout","track":"mt-only","split":"holdout","sourceLanguage":"en","targetLanguage":"ja","sourceText":"The meeting starts at 10.","referenceTranslations":["会議は10時に始まります。"],"meetingId":"meeting-holdout-1","speakerGroup":"speaker-holdout-1","annotationVersion":"contract-1","annotationStatus":"verified","fixtureKind":"synthetic"}`

	if _, err := LoadCases(strings.NewReader(input), TrackMTOnly); err == nil {
		t.Fatal("synthetic quality holdout must be rejected")
	}
}

func TestLoadCasesRejectsUnsafeAudioPath(t *testing.T) {
	input := `{"schemaVersion":1,"caseId":"asr-1","track":"asr-only","split":"contract","sourceLanguage":"ja","audioRef":"../private/meeting.wav","audioSHA256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","referenceText":"","annotationVersion":"contract-1","annotationStatus":"contract-test","fixtureKind":"synthetic"}`

	if _, err := LoadCases(strings.NewReader(input), TrackASROnly); err == nil {
		t.Fatal("expected parent traversal in audioRef to be rejected")
	}
}

func TestPromotionEligibleRequiresVerifiedHoldout(t *testing.T) {
	caseData := EvalCase{Split: "holdout", AnnotationStatus: "verified"}
	if !PromotionEligible(caseData) {
		t.Fatal("verified holdout case should be eligible")
	}

	caseData.AnnotationStatus = "pending"
	if PromotionEligible(caseData) {
		t.Fatal("unreviewed holdout case must not be eligible")
	}
	caseData.Split = "contract"
	caseData.AnnotationStatus = "verified"
	if PromotionEligible(caseData) {
		t.Fatal("contract fixture must not be eligible")
	}
	caseData = EvalCase{Split: "holdout", AnnotationStatus: "verified", FixtureKind: "synthetic"}
	if PromotionEligible(caseData) {
		t.Fatal("synthetic holdout must not be eligible")
	}
}

func TestRunManifestCheckLabelsReportAsNonInference(t *testing.T) {
	root := t.TempDir()
	manifestPath := filepath.Join(root, "cases.jsonl")
	input := `{"schemaVersion":1,"caseId":"mt-1","track":"mt-only","split":"development","sourceLanguage":"en","targetLanguage":"ja","sourceText":"The meeting starts at 10.","referenceTranslations":["会議は10時に始まります。"],"meetingId":"meeting-dev-1","speakerGroup":"speaker-dev-1","annotationVersion":"draft-1","annotationStatus":"pending"}`
	if err := os.WriteFile(manifestPath, []byte(input+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	if err := runManifestCheck(TrackMTOnly, manifestPath, root, &output); err != nil {
		t.Fatalf("runManifestCheck() error = %v", err)
	}
	var report manifestReport
	if err := json.Unmarshal(output.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if report.InferenceExecuted {
		t.Fatal("manifest validation must never claim inference was executed")
	}
	if report.PromotionEligibleCount != 0 {
		t.Fatalf("PromotionEligibleCount = %d, want 0 for unreviewed development data", report.PromotionEligibleCount)
	}
}

func TestVerifyAudioAssetsChecksContentHash(t *testing.T) {
	projectRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	cases := []EvalCase{{
		CaseID:      "silence-contract",
		AudioRef:    "eval/fixtures/audio/silence_100ms.wav",
		AudioSHA256: "2976da01e205a110c9fa41d47659e238a5c6d3c3f3137582f2949853faa201dd",
	}}
	if err := VerifyAudioAssets(projectRoot, cases); err != nil {
		t.Fatalf("VerifyAudioAssets() error = %v", err)
	}
	cases[0].AudioSHA256 = strings.Repeat("0", 64)
	if err := VerifyAudioAssets(projectRoot, cases); err == nil {
		t.Fatal("expected modified audio digest to be rejected")
	}
}
