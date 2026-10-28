package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"time"
)

const (
	qualificationAttestationPayloadType = "application/vnd.meet-translator.qualification-execution.v1+json"
	maxQualificationReportBytes         = 8 << 20
	maxQualificationAttestationBytes    = 1 << 20
	maxQualificationEvidenceBytes       = 64 << 20
)

var errNoTrustedQualificationKeys = errors.New("no trusted qualification executor keys are configured")

type qualificationDSSEEnvelope struct {
	PayloadType string                       `json:"payloadType"`
	Payload     string                       `json:"payload"`
	Signatures  []qualificationDSSESignature `json:"signatures"`
}

type qualificationDSSESignature struct {
	KeyID     string `json:"keyid,omitempty"`
	Signature string `json:"sig"`
}

type qualificationAttestationPayload struct {
	SchemaVersion       int    `json:"schemaVersion"`
	RunID               string `json:"runId"`
	ReportSHA256        string `json:"reportSHA256"`
	ExecutorRevision    string `json:"executorRevision"`
	EnvironmentSHA256   string `json:"environmentSHA256"`
	ConfigurationSHA256 string `json:"configurationSHA256"`
	ManifestSetSHA256   string `json:"manifestSetSHA256"`
	OutputsSHA256       string `json:"outputsSHA256"`
	MeasurementsSHA256  string `json:"measurementsSHA256"`
	ScorerRevision      string `json:"scorerRevision"`
	StartedAt           string `json:"startedAt"`
	FinishedAt          string `json:"finishedAt"`
	ExitCode            int    `json:"exitCode"`
	TestDouble          *bool  `json:"testDouble"`
	Synthetic           *bool  `json:"synthetic"`
}

type trustedQualificationKey struct {
	KeyID     string
	PublicKey ed25519.PublicKey
}

// verifiedQualificationProvenance can only be created by the detached
// attestation verifier. It is still not product evidence when generated with
// a test-only trust root; the production trust registry is empty.
type verifiedQualificationProvenance struct {
	keyID                string
	runID                string
	reportSHA256         string
	reportSemanticSHA256 string
}

// productionTrustedQualificationKeys remains empty until an independently
// approved executor and key-provisioning/revocation process exist. Never load
// keys from a qualification report, envelope, environment variable, or path.
func productionTrustedQualificationKeys() []trustedQualificationKey {
	return nil
}

func verifyQualificationAttestation(reportRaw, envelopeRaw, outputsRaw, measurementsRaw []byte, trustedKeys []trustedQualificationKey) (verifiedQualificationProvenance, error) {
	if len(trustedKeys) == 0 {
		return verifiedQualificationProvenance{}, errNoTrustedQualificationKeys
	}
	if len(reportRaw) == 0 || len(reportRaw) > maxQualificationReportBytes {
		return verifiedQualificationProvenance{}, errors.New("qualification report size is invalid")
	}
	if len(envelopeRaw) == 0 || len(envelopeRaw) > maxQualificationAttestationBytes {
		return verifiedQualificationProvenance{}, errors.New("attestation envelope size is invalid")
	}
	if len(outputsRaw) == 0 || len(outputsRaw) > maxQualificationEvidenceBytes {
		return verifiedQualificationProvenance{}, errors.New("qualification outputs artifact size is invalid")
	}
	if len(measurementsRaw) == 0 || len(measurementsRaw) > maxQualificationEvidenceBytes {
		return verifiedQualificationProvenance{}, errors.New("qualification measurements artifact size is invalid")
	}

	var report QualificationReport
	if err := decodeStrictJSON(reportRaw, &report); err != nil {
		return verifiedQualificationProvenance{}, fmt.Errorf("decode qualification report: %w", err)
	}
	var envelope qualificationDSSEEnvelope
	if err := decodeStrictJSON(envelopeRaw, &envelope); err != nil {
		return verifiedQualificationProvenance{}, fmt.Errorf("decode DSSE envelope: %w", err)
	}
	if envelope.PayloadType != qualificationAttestationPayloadType {
		return verifiedQualificationProvenance{}, errors.New("unsupported qualification attestation payload type")
	}
	if len(envelope.Signatures) != 1 {
		return verifiedQualificationProvenance{}, errors.New("qualification attestation must contain exactly one signature")
	}
	payloadRaw, err := decodeDSSEBase64(envelope.Payload)
	if err != nil {
		return verifiedQualificationProvenance{}, fmt.Errorf("decode DSSE payload: %w", err)
	}
	signature, err := decodeDSSEBase64(envelope.Signatures[0].Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return verifiedQualificationProvenance{}, errors.New("qualification attestation signature encoding is invalid")
	}
	pae := dssePreAuthenticationEncoding([]byte(envelope.PayloadType), payloadRaw)
	var matched *trustedQualificationKey
	for i := range trustedKeys {
		key := &trustedKeys[i]
		if key.KeyID == "" || len(key.PublicKey) != ed25519.PublicKeySize {
			continue
		}
		if ed25519.Verify(key.PublicKey, pae, signature) {
			if matched != nil {
				return verifiedQualificationProvenance{}, errors.New("attestation signature matches multiple trusted key identities")
			}
			matched = key
		}
	}
	if matched == nil {
		return verifiedQualificationProvenance{}, errors.New("qualification attestation signer is not trusted or signature is invalid")
	}

	var attestation qualificationAttestationPayload
	if err := decodeStrictJSON(payloadRaw, &attestation); err != nil {
		return verifiedQualificationProvenance{}, fmt.Errorf("decode signed qualification payload: %w", err)
	}
	if err := validateQualificationAttestation(attestation, report, reportRaw, outputsRaw, measurementsRaw); err != nil {
		return verifiedQualificationProvenance{}, err
	}
	return verifiedQualificationProvenance{
		keyID: matched.KeyID, runID: report.RunID,
		reportSHA256: sha256Hex(reportRaw), reportSemanticSHA256: sha256JSON(report),
	}, nil
}

func validateQualificationAttestation(attestation qualificationAttestationPayload, report QualificationReport, reportRaw, outputsRaw, measurementsRaw []byte) error {
	if attestation.SchemaVersion != 1 || attestation.RunID == "" || attestation.RunID != report.RunID {
		return errors.New("attestation run identity does not match the report")
	}
	if !isSHA256(attestation.ReportSHA256) || attestation.ReportSHA256 != sha256Hex(reportRaw) {
		return errors.New("attestation report digest does not match the exact report bytes")
	}
	if !isImmutableRuntimeRevision(attestation.ExecutorRevision) || !isImmutableRuntimeRevision(attestation.ScorerRevision) {
		return errors.New("executor and scorer revisions must be full immutable hashes")
	}
	if !isSHA256(attestation.EnvironmentSHA256) || attestation.EnvironmentSHA256 != qualificationEnvironmentSHA256(report) {
		return errors.New("attested environment digest does not match the report")
	}
	if !isSHA256(attestation.ConfigurationSHA256) || attestation.ConfigurationSHA256 != qualificationConfigurationSHA256(report) {
		return errors.New("attested configuration digest does not match the report")
	}
	if !isSHA256(attestation.ManifestSetSHA256) || attestation.ManifestSetSHA256 != qualificationManifestSetSHA256(report) {
		return errors.New("attested manifest and dataset digest does not match the report")
	}
	if !isSHA256(attestation.OutputsSHA256) || attestation.OutputsSHA256 != sha256Hex(outputsRaw) {
		return errors.New("attested outputs digest does not match the exact artifact bytes")
	}
	if !isSHA256(attestation.MeasurementsSHA256) || attestation.MeasurementsSHA256 != sha256Hex(measurementsRaw) {
		return errors.New("attested measurements digest does not match the exact artifact bytes")
	}
	startedAt, err := time.Parse(time.RFC3339Nano, attestation.StartedAt)
	if err != nil {
		return errors.New("attestation start time must be RFC3339")
	}
	finishedAt, err := time.Parse(time.RFC3339Nano, attestation.FinishedAt)
	if err != nil || !finishedAt.After(startedAt) {
		return errors.New("attestation end time must follow the start time")
	}
	if err := validateQualificationMeasurementTimeline(report, measurementsRaw, startedAt, finishedAt); err != nil {
		return err
	}
	if attestation.ExitCode != 0 {
		return errors.New("attested executor did not exit successfully")
	}
	if attestation.TestDouble == nil || report.TestDouble == nil || *attestation.TestDouble != *report.TestDouble {
		return errors.New("test-double attestation is missing or disagrees with the report")
	}
	if attestation.Synthetic == nil || report.Dataset.Synthetic == nil || *attestation.Synthetic != *report.Dataset.Synthetic {
		return errors.New("synthetic-data attestation is missing or disagrees with the report")
	}
	return nil
}

func validateQualificationMeasurementTimeline(report QualificationReport, measurementsRaw []byte, startedAt, finishedAt time.Time) error {
	var measurements MeasurementRunRecord
	if err := decodeStrictJSON(measurementsRaw, &measurements); err != nil {
		return fmt.Errorf("decode qualification measurements: %w", err)
	}
	if err := validateMeasurementRun(measurements); err != nil {
		return fmt.Errorf("validate qualification measurement timeline: %w", err)
	}
	if measurements.RunID != report.RunID {
		return errors.New("measurement run identity does not match the report")
	}
	if !measurementDurationMatchesMinutes(measurements.WarmupDurationMillis, report.Performance.WarmupMinutes) ||
		!measurementDurationMatchesMinutes(measurements.MeasuredDurationMillis, report.Performance.MeasuredMinutes) {
		return errors.New("measurement durations do not match the qualification report")
	}
	attestedDurationMillis := finishedAt.Sub(startedAt).Milliseconds()
	lastSampleElapsedMillis := measurements.Samples[len(measurements.Samples)-1].ElapsedMillis
	if attestedDurationMillis < lastSampleElapsedMillis {
		return errors.New("attestation interval ends before the final measurement sample")
	}
	return nil
}

func measurementDurationMatchesMinutes(durationMillis int64, reportedMinutes *float64) bool {
	if reportedMinutes == nil || math.IsNaN(*reportedMinutes) || math.IsInf(*reportedMinutes, 0) {
		return false
	}
	reportedMillis := *reportedMinutes * 60_000
	if reportedMillis < 0 || reportedMillis >= math.Ldexp(1, 63) {
		return false
	}
	return int64(math.Round(reportedMillis)) == durationMillis
}

func qualificationEnvironmentSHA256(report QualificationReport) string {
	projection := struct {
		Hardware           QualificationHardware
		Browser            QualificationBrowser
		ACConnected        *bool
		LowPowerModeEnable *bool
	}{
		Hardware:           report.Hardware,
		Browser:            report.Browser,
		ACConnected:        report.Performance.ACConnected,
		LowPowerModeEnable: report.Performance.LowPowerModeEnabled,
	}
	return sha256JSON(projection)
}

func qualificationConfigurationSHA256(report QualificationReport) string {
	projection := struct {
		ProfileID                 string
		Baseline                  QualificationBaseline
		Candidate                 QualificationCandidate
		BaselineConditionsSHA256  string
		CandidateConditionsSHA256 string
	}{
		ProfileID:                 report.ProfileID,
		Baseline:                  report.Baseline,
		Candidate:                 report.Candidate,
		BaselineConditionsSHA256:  report.BaselineConditionsSHA256,
		CandidateConditionsSHA256: report.CandidateConditionsSHA256,
	}
	return sha256JSON(projection)
}

func qualificationManifestSetSHA256(report QualificationReport) string {
	return sha256JSON(report.Dataset)
}

func sha256JSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return sha256Hex(encoded)
}

func dssePreAuthenticationEncoding(payloadType, payload []byte) []byte {
	var result bytes.Buffer
	_, _ = fmt.Fprintf(&result, "DSSEv1 %d ", len(payloadType))
	_, _ = result.Write(payloadType)
	_, _ = fmt.Fprintf(&result, " %d ", len(payload))
	_, _ = result.Write(payload)
	return result.Bytes()
}

func decodeDSSEBase64(value string) ([]byte, error) {
	encodings := []*base64.Encoding{
		base64.StdEncoding.Strict(),
		base64.RawStdEncoding.Strict(),
		base64.URLEncoding.Strict(),
		base64.RawURLEncoding.Strict(),
	}
	for _, encoding := range encodings {
		decoded, err := encoding.DecodeString(value)
		if err == nil {
			return decoded, nil
		}
	}
	return nil, errors.New("invalid base64")
}

func decodeStrictJSON(raw []byte, destination any) error {
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("input must contain one JSON value")
		}
		return fmt.Errorf("read end of JSON input: %w", err)
	}
	return nil
}

func rejectDuplicateJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil {
		return err
	}
	if err := consumeJSONValue(decoder, first); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return errors.New("input must contain one JSON value")
		}
		return err
	}
	return nil
}

func consumeJSONValue(decoder *json.Decoder, token json.Token) error {
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}
			valueToken, err := decoder.Token()
			if err != nil {
				return err
			}
			if err := consumeJSONValue(decoder, valueToken); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("malformed JSON object")
		}
	case '[':
		for decoder.More() {
			valueToken, err := decoder.Token()
			if err != nil {
				return err
			}
			if err := consumeJSONValue(decoder, valueToken); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("malformed JSON array")
		}
	default:
		return errors.New("unexpected JSON delimiter")
	}
	return nil
}

func runQualificationCheckWithAttestation(reportRaw, envelopeRaw, outputsRaw, measurementsRaw []byte, trustedKeys []trustedQualificationKey, output io.Writer) (QualificationAssessment, error) {
	if len(reportRaw) == 0 || len(reportRaw) > maxQualificationReportBytes {
		return QualificationAssessment{}, errors.New("qualification report size is invalid")
	}
	var report QualificationReport
	if err := decodeStrictJSON(reportRaw, &report); err != nil {
		return QualificationAssessment{}, fmt.Errorf("decode qualification report: %w", err)
	}

	var provenance *verifiedQualificationProvenance
	var provenanceErr error
	if len(envelopeRaw) > 0 {
		verified, err := verifyQualificationAttestation(reportRaw, envelopeRaw, outputsRaw, measurementsRaw, trustedKeys)
		if err == nil {
			provenance = &verified
		} else {
			provenanceErr = err
		}
	} else if len(outputsRaw) > 0 || len(measurementsRaw) > 0 {
		return QualificationAssessment{}, errors.New("output and measurement artifacts require a detached attestation")
	}
	assessment := assessQualificationWithProvenance(report, provenance)
	if provenanceErr != nil && !errors.Is(provenanceErr, errNoTrustedQualificationKeys) {
		addQualificationFinding(&assessment, QualificationFinding{
			Code:   "TRUSTED_PROVENANCE_INVALID",
			Detail: "The detached execution attestation could not be verified against a trusted executor key.",
			Kind:   "blocked",
		})
	}
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(assessment); err != nil {
		return QualificationAssessment{}, err
	}
	return assessment, nil
}

func addQualificationFinding(assessment *QualificationAssessment, finding QualificationFinding) {
	for _, current := range assessment.Findings {
		if current.Code == finding.Code {
			return
		}
	}
	assessment.Findings = append(assessment.Findings, finding)
	if assessment.Status != QualificationStatusRejected {
		assessment.Status = QualificationStatusBlocked
	}
	sortQualificationFindings(assessment.Findings)
}

func sortQualificationFindings(findings []QualificationFinding) {
	for i := 1; i < len(findings); i++ {
		for j := i; j > 0 && findings[j].Code < findings[j-1].Code; j-- {
			findings[j], findings[j-1] = findings[j-1], findings[j]
		}
	}
}

// readLimited reads a local qualification artifact without permitting an
// unexpectedly large report, envelope, or evidence bundle to exhaust memory.
func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	if limit <= 0 {
		return nil, errors.New("read limit must be positive")
	}
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("qualification artifact exceeds size limit")
	}
	return data, nil
}
