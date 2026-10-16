package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestVerifyQualificationAttestationBindsExactReportAndTrustedSigner(t *testing.T) {
	report := validQualificationReport()
	report.TestDouble = qualificationBool(true)
	report.Dataset.Synthetic = qualificationBool(true)
	reportRaw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, trustedKey := testQualificationSigningKey()
	envelopeRaw := signedTestQualificationEnvelope(t, reportRaw, report, privateKey, "untrusted-envelope-hint")

	verified, err := verifyTestQualificationAttestation(t, reportRaw, envelopeRaw, []trustedQualificationKey{trustedKey})
	if err != nil {
		t.Fatalf("verifyQualificationAttestation() error = %v", err)
	}
	if verified.keyID != trustedKey.KeyID {
		t.Fatalf("verified key id = %q, want trusted anchor %q; envelope keyid is only a hint", verified.keyID, trustedKey.KeyID)
	}
	if verified.runID != report.RunID || verified.reportSHA256 != sha256Hex(reportRaw) {
		t.Fatalf("verified binding = %#v; want exact report run and digest", verified)
	}

	assessment := assessQualificationWithProvenance(report, &verified)
	if assessment.Status != QualificationStatusBlocked || hasQualificationFinding(assessment, "TRUSTED_PROVENANCE_UNAVAILABLE") || !hasQualificationFinding(assessment, "TEST_DOUBLE_EVIDENCE") || !hasQualificationFinding(assessment, "SYNTHETIC_DATASET_EVIDENCE") {
		t.Fatalf("test-key assessment = %#v; trusted synthetic test evidence must remain blocked", assessment)
	}
	changedReport := report
	changedReport.Hardware.OSVersion = "different-but-still-present"
	changedAssessment := assessQualificationWithProvenance(changedReport, &verified)
	if !hasQualificationFinding(changedAssessment, "TRUSTED_PROVENANCE_UNAVAILABLE") {
		t.Fatalf("semantically changed report retained provenance: %#v", changedAssessment)
	}
}

func TestVerifyQualificationAttestationRejectsAlteredReportAndRunMismatch(t *testing.T) {
	report := validQualificationReport()
	report.TestDouble = qualificationBool(true)
	report.Dataset.Synthetic = qualificationBool(true)
	reportRaw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, trustedKey := testQualificationSigningKey()
	envelopeRaw := signedTestQualificationEnvelope(t, reportRaw, report, privateKey, trustedKey.KeyID)
	trust := []trustedQualificationKey{trustedKey}

	t.Run("raw report bytes changed", func(t *testing.T) {
		tampered := append(append([]byte(nil), reportRaw...), '\n')
		if _, err := verifyTestQualificationAttestation(t, tampered, envelopeRaw, trust); err == nil {
			t.Fatal("modified report bytes verified against the detached digest")
		}
	})
	t.Run("signed run id differs from report", func(t *testing.T) {
		attestation := validTestQualificationAttestation(t, reportRaw, report)
		attestation.RunID = "different-run"
		mismatchedEnvelope := marshalSignedTestAttestation(t, attestation, privateKey, trustedKey.KeyID)
		if _, err := verifyTestQualificationAttestation(t, reportRaw, mismatchedEnvelope, trust); err == nil {
			t.Fatal("run ID mismatch was accepted")
		}
	})
}

func TestVerifyQualificationAttestationBindsExactOutputAndMeasurementArtifacts(t *testing.T) {
	report := validQualificationReport()
	report.TestDouble = qualificationBool(true)
	report.Dataset.Synthetic = qualificationBool(true)
	reportRaw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, trustedKey := testQualificationSigningKey()
	envelopeRaw := signedTestQualificationEnvelope(t, reportRaw, report, privateKey, trustedKey.KeyID)
	outputsRaw, measurementsRaw := testQualificationArtifacts(t, report)
	trust := []trustedQualificationKey{trustedKey}

	if _, err := verifyQualificationAttestation(reportRaw, envelopeRaw, append(outputsRaw, '!'), measurementsRaw, trust); err == nil {
		t.Fatal("altered output bytes matched the signed digest")
	}
	if _, err := verifyQualificationAttestation(reportRaw, envelopeRaw, outputsRaw, append(measurementsRaw, '!'), trust); err == nil {
		t.Fatal("altered measurement bytes matched the signed digest")
	}
	if _, err := verifyQualificationAttestation(reportRaw, envelopeRaw, nil, measurementsRaw, trust); err == nil {
		t.Fatal("missing output artifact was accepted")
	}
}

func TestVerifyQualificationAttestationBindsExecutionIntervalToMeasurementTimeline(t *testing.T) {
	report := validQualificationReport()
	report.TestDouble = qualificationBool(true)
	report.Dataset.Synthetic = qualificationBool(true)
	reportRaw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, trustedKey := testQualificationSigningKey()
	outputsRaw, measurementsRaw := testQualificationArtifacts(t, report)
	trust := []trustedQualificationKey{trustedKey}

	t.Run("attestation covers the full reported run and sample timeline", func(t *testing.T) {
		attestation := validTestQualificationAttestation(t, reportRaw, report)
		attestation.FinishedAt = "2026-10-07T09:00:01Z"
		envelopeRaw := marshalSignedTestAttestation(t, attestation, privateKey, trustedKey.KeyID)
		if _, err := verifyQualificationAttestation(reportRaw, envelopeRaw, outputsRaw, measurementsRaw, trust); err == nil {
			t.Fatal("one-second attestation was accepted for a 62-minute measurement timeline")
		}
	})

	t.Run("measurement duration agrees with the signed report", func(t *testing.T) {
		record := testQualificationMeasurementRun(t, report)
		record.MeasuredDurationMillis -= 60_000
		mismatchedMeasurements, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		attestation := validTestQualificationAttestation(t, reportRaw, report)
		attestation.MeasurementsSHA256 = sha256Hex(mismatchedMeasurements)
		envelopeRaw := marshalSignedTestAttestation(t, attestation, privateKey, trustedKey.KeyID)
		if _, err := verifyQualificationAttestation(reportRaw, envelopeRaw, outputsRaw, mismatchedMeasurements, trust); err == nil {
			t.Fatal("measurement duration that disagrees with the report was accepted")
		}
	})
}

func TestVerifyQualificationAttestationRequiresPinnedExecutorAndCompleteEvidence(t *testing.T) {
	report := validQualificationReport()
	report.TestDouble = qualificationBool(true)
	report.Dataset.Synthetic = qualificationBool(true)
	reportRaw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, trustedKey := testQualificationSigningKey()
	trust := []trustedQualificationKey{trustedKey}

	tests := []struct {
		name    string
		mutate  func(*qualificationAttestationPayload)
		wantErr bool
	}{
		{name: "floating executor revision", mutate: func(attestation *qualificationAttestationPayload) { attestation.ExecutorRevision = "main" }, wantErr: true},
		{name: "missing output digest", mutate: func(attestation *qualificationAttestationPayload) { attestation.OutputsSHA256 = "" }, wantErr: true},
		{name: "missing measurement digest", mutate: func(attestation *qualificationAttestationPayload) { attestation.MeasurementsSHA256 = "" }, wantErr: true},
		{name: "invalid interval", mutate: func(attestation *qualificationAttestationPayload) { attestation.FinishedAt = attestation.StartedAt }, wantErr: true},
		{name: "nonzero executor exit", mutate: func(attestation *qualificationAttestationPayload) { attestation.ExitCode = 1 }, wantErr: true},
		{name: "missing test double attestation", mutate: func(attestation *qualificationAttestationPayload) { attestation.TestDouble = nil }, wantErr: true},
		{name: "missing synthetic attestation", mutate: func(attestation *qualificationAttestationPayload) { attestation.Synthetic = nil }, wantErr: true},
		{name: "unsupported payload type", mutate: nil, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			attestation := validTestQualificationAttestation(t, reportRaw, report)
			if test.mutate != nil {
				test.mutate(&attestation)
			}
			payloadType := qualificationAttestationPayloadType
			if test.name == "unsupported payload type" {
				payloadType = "application/json"
			}
			envelopeRaw := marshalSignedTestAttestationType(t, attestation, payloadType, privateKey, trustedKey.KeyID)
			_, err := verifyTestQualificationAttestation(t, reportRaw, envelopeRaw, trust)
			if (err != nil) != test.wantErr {
				t.Fatalf("verifyQualificationAttestation() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestVerifyQualificationAttestationRejectsUntrustedSignerAndDuplicateJSONKeys(t *testing.T) {
	report := validQualificationReport()
	report.TestDouble = qualificationBool(true)
	report.Dataset.Synthetic = qualificationBool(true)
	reportRaw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, trustedKey := testQualificationSigningKey()
	envelopeRaw := signedTestQualificationEnvelope(t, reportRaw, report, privateKey, trustedKey.KeyID)
	if _, err := verifyTestQualificationAttestation(t, reportRaw, envelopeRaw, nil); err == nil {
		t.Fatal("empty trust registry accepted a signer")
	}
	if _, err := verifyTestQualificationAttestation(t, reportRaw, envelopeRaw, []trustedQualificationKey{{KeyID: "other", PublicKey: ed25519.PublicKey(strings.Repeat("x", ed25519.PublicKeySize))}}); err == nil {
		t.Fatal("untrusted signer was accepted")
	}
	var envelope qualificationDSSEEnvelope
	if err := json.Unmarshal(envelopeRaw, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Signatures[0].Signature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	tamperedEnvelope, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifyTestQualificationAttestation(t, reportRaw, tamperedEnvelope, []trustedQualificationKey{trustedKey}); err == nil {
		t.Fatal("tampered DSSE signature was accepted")
	}

	duplicateReport := strings.Replace(string(reportRaw), `"runId":"`+report.RunID+`"`, `"runId":"`+report.RunID+`","runId":"`+report.RunID+`"`, 1)
	if _, err := verifyTestQualificationAttestation(t, []byte(duplicateReport), envelopeRaw, []trustedQualificationKey{trustedKey}); err == nil {
		t.Fatal("duplicate report JSON key was accepted")
	}

	attestation := validTestQualificationAttestation(t, reportRaw, report)
	payloadRaw, err := json.Marshal(attestation)
	if err != nil {
		t.Fatal(err)
	}
	duplicatePayload := strings.Replace(string(payloadRaw), `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1)
	duplicateEnvelope := marshalRawSignedTestPayload(t, []byte(duplicatePayload), qualificationAttestationPayloadType, privateKey, trustedKey.KeyID)
	if _, err := verifyTestQualificationAttestation(t, reportRaw, duplicateEnvelope, []trustedQualificationKey{trustedKey}); err == nil {
		t.Fatal("duplicate attestation JSON key was accepted")
	}
}

func TestQualificationCLIUsesOnlyCompiledEmptyTrustRegistry(t *testing.T) {
	report := validQualificationReport()
	report.TestDouble = qualificationBool(true)
	report.Dataset.Synthetic = qualificationBool(true)
	reportRaw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, _ := testQualificationSigningKey()
	envelopeRaw := signedTestQualificationEnvelope(t, reportRaw, report, privateKey, "caller-selected-key")
	var output strings.Builder
	outputsRaw, measurementsRaw := testQualificationArtifacts(t, report)
	assessment, err := runQualificationCheckWithAttestation(reportRaw, envelopeRaw, outputsRaw, measurementsRaw, productionTrustedQualificationKeys(), &output)
	if err != nil {
		t.Fatalf("runQualificationCheckWithAttestation() error = %v", err)
	}
	if assessment.Status != QualificationStatusBlocked || qualificationExitCode(assessment.Status) != 2 || !hasQualificationFinding(assessment, "TRUSTED_PROVENANCE_UNAVAILABLE") {
		t.Fatalf("production assessment = %#v, exit=%d; no approved signing key exists", assessment, qualificationExitCode(assessment.Status))
	}
	if len(productionTrustedQualificationKeys()) != 0 {
		t.Fatal("test signer or caller key entered production trust registry")
	}
}

func TestRunQualificationReportRemainsBlockedWithoutDetachedAttestation(t *testing.T) {
	report := validQualificationReport()
	reportRaw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	assessment, err := runQualificationCheckWithAttestation(reportRaw, nil, nil, nil, productionTrustedQualificationKeys(), &output)
	if err != nil {
		t.Fatalf("runQualificationCheckWithAttestation() error = %v", err)
	}
	if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "TRUSTED_PROVENANCE_UNAVAILABLE") {
		t.Fatalf("report-only assessment = %#v; caller-authored JSON must stay blocked", assessment)
	}
}

func testQualificationSigningKey() (ed25519.PrivateKey, trustedQualificationKey) {
	seed := sha256.Sum256([]byte("meet-translator provenance unit-test key; never trust in production"))
	privateKey := ed25519.NewKeyFromSeed(seed[:])
	publicKey := append(ed25519.PublicKey(nil), privateKey.Public().(ed25519.PublicKey)...)
	return privateKey, trustedQualificationKey{KeyID: "unit-test-only", PublicKey: publicKey}
}

func testQualificationArtifacts(t *testing.T, report QualificationReport) ([]byte, []byte) {
	t.Helper()
	measurementsRaw, err := json.Marshal(testQualificationMeasurementRun(t, report))
	if err != nil {
		t.Fatal(err)
	}
	return []byte("test-only exact model output artifact\n"), measurementsRaw
}

func verifyTestQualificationAttestation(t *testing.T, reportRaw, envelopeRaw []byte, trustedKeys []trustedQualificationKey) (verifiedQualificationProvenance, error) {
	t.Helper()
	var report QualificationReport
	if err := json.Unmarshal(reportRaw, &report); err != nil {
		return verifiedQualificationProvenance{}, err
	}
	outputsRaw, measurementsRaw := testQualificationArtifacts(t, report)
	return verifyQualificationAttestation(reportRaw, envelopeRaw, outputsRaw, measurementsRaw, trustedKeys)
}

func validTestQualificationAttestation(t *testing.T, reportRaw []byte, report QualificationReport) qualificationAttestationPayload {
	t.Helper()
	outputsRaw, measurementsRaw := testQualificationArtifacts(t, report)
	return qualificationAttestationPayload{
		SchemaVersion:       1,
		RunID:               report.RunID,
		ReportSHA256:        sha256Hex(reportRaw),
		ExecutorRevision:    strings.Repeat("a", 40),
		EnvironmentSHA256:   qualificationEnvironmentSHA256(report),
		ConfigurationSHA256: qualificationConfigurationSHA256(report),
		ManifestSetSHA256:   qualificationManifestSetSHA256(report),
		OutputsSHA256:       sha256Hex(outputsRaw),
		MeasurementsSHA256:  sha256Hex(measurementsRaw),
		ScorerRevision:      strings.Repeat("d", 64),
		StartedAt:           "2026-10-07T09:00:00Z",
		FinishedAt:          "2026-10-07T10:02:02Z",
		ExitCode:            0,
		TestDouble:          report.TestDouble,
		Synthetic:           report.Dataset.Synthetic,
	}
}

func testQualificationMeasurementRun(t *testing.T, report QualificationReport) MeasurementRunRecord {
	t.Helper()
	if report.Performance.WarmupMinutes == nil || report.Performance.MeasuredMinutes == nil {
		t.Fatal("qualification report fixture requires warmup and measured duration")
	}
	warmupMillis := int64(*report.Performance.WarmupMinutes * 60_000)
	measuredMillis := int64(*report.Performance.MeasuredMinutes * 60_000)
	record := MeasurementRunRecord{
		SchemaVersion: 1,
		RunID:         report.RunID,
		TestDouble:    report.TestDouble,
		Synthetic:     report.Dataset.Synthetic,
		Hardware: MeasurementHardware{
			Chip: report.Hardware.Chip, UnifiedMemoryGiB: report.Hardware.UnifiedMemoryGiB,
			GPUCores: report.Hardware.GPUCores, Architecture: report.Hardware.Architecture,
			OSVersion: report.Hardware.OSVersion,
		},
		Browser:                      MeasurementBrowser{Name: report.Browser.Name, Version: report.Browser.Version},
		RootProcess:                  MeasurementProcessIdentity{PID: 100, StartedAtUnixNano: 1_000},
		SampleIntervalMillis:         1_000,
		WarmupDurationMillis:         warmupMillis,
		MeasuredDurationMillis:       measuredMillis,
		ModelReleaseObserved:         true,
		ACConnected:                  report.Performance.ACConnected,
		LowPowerModeEnabled:          report.Performance.LowPowerModeEnabled,
		AcceleratorExecutionVerified: report.Performance.AcceleratorExecutionVerified,
	}
	measurementEnd := warmupMillis + measuredMillis
	for elapsed := int64(0); elapsed <= measurementEnd; elapsed += measurementSampleMaxGapMillis {
		record.Samples = append(record.Samples, testQualificationMeasurementSample(elapsed))
	}
	record.Samples = append(record.Samples, testQualificationMeasurementSample(measurementEnd+measurementSampleMaxGapMillis))
	return record
}

func testQualificationMeasurementSample(elapsed int64) MeasurementSample {
	return MeasurementSample{
		ElapsedMillis: elapsed, ProcessMembershipComplete: true,
		MemoryPressure: measurementString("normal"), SwapUsedBytes: measurementUint64(0),
		Processes: []MeasurementProcess{
			{PID: 100, ParentPID: 1, StartedAtUnixNano: 1_000, RSSBytes: 1, PhysFootprintBytes: measurementUint64(1)},
			{PID: 101, ParentPID: 100, StartedAtUnixNano: 2_000, RSSBytes: 1, PhysFootprintBytes: measurementUint64(1)},
		},
	}
}

func signedTestQualificationEnvelope(t *testing.T, reportRaw []byte, report QualificationReport, privateKey ed25519.PrivateKey, keyID string) []byte {
	t.Helper()
	return marshalSignedTestAttestation(t, validTestQualificationAttestation(t, reportRaw, report), privateKey, keyID)
}

func marshalSignedTestAttestation(t *testing.T, attestation qualificationAttestationPayload, privateKey ed25519.PrivateKey, keyID string) []byte {
	t.Helper()
	return marshalSignedTestAttestationType(t, attestation, qualificationAttestationPayloadType, privateKey, keyID)
}

func marshalSignedTestAttestationType(t *testing.T, attestation qualificationAttestationPayload, payloadType string, privateKey ed25519.PrivateKey, keyID string) []byte {
	t.Helper()
	payloadRaw, err := json.Marshal(attestation)
	if err != nil {
		t.Fatal(err)
	}
	return marshalRawSignedTestPayload(t, payloadRaw, payloadType, privateKey, keyID)
}

func marshalRawSignedTestPayload(t *testing.T, payloadRaw []byte, payloadType string, privateKey ed25519.PrivateKey, keyID string) []byte {
	t.Helper()
	signature := ed25519.Sign(privateKey, dssePreAuthenticationEncoding([]byte(payloadType), payloadRaw))
	envelope := qualificationDSSEEnvelope{
		PayloadType: payloadType,
		Payload:     base64.StdEncoding.EncodeToString(payloadRaw),
		Signatures:  []qualificationDSSESignature{{KeyID: keyID, Signature: base64.StdEncoding.EncodeToString(signature)}},
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestProvenanceDigestFixturesAreStable(t *testing.T) {
	report := validQualificationReport()
	digestFns := []struct {
		name string
		fn   func(QualificationReport) string
	}{
		{name: "environment", fn: qualificationEnvironmentSHA256},
		{name: "configuration", fn: qualificationConfigurationSHA256},
		{name: "manifest-set", fn: qualificationManifestSetSHA256},
	}
	for _, item := range digestFns {
		first := item.fn(report)
		if !isSHA256(first) || first != item.fn(report) {
			t.Errorf("%s projection digest = %q; want stable lowercase SHA-256", item.name, first)
		}
	}
}
