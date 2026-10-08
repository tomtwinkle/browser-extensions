package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

type manifestReport struct {
	Mode                   string `json:"mode"`
	Track                  Track  `json:"track"`
	ManifestSHA256         string `json:"manifestSHA256"`
	CaseCount              int    `json:"caseCount"`
	DevelopmentCount       int    `json:"developmentCount"`
	HoldoutCount           int    `json:"holdoutCount"`
	ContractCount          int    `json:"contractCount"`
	VerifiedHoldoutCount   int    `json:"verifiedHoldoutCount"`
	AudioAssetsVerified    bool   `json:"audioAssetsVerified"`
	InferenceExecuted      bool   `json:"inferenceExecuted"`
	PromotionEligibleCount int    `json:"promotionEligibleCount"`
}

func main() {
	trackFlag := flag.String("track", "", "evaluation track: asr-only, mt-only, or end-to-end")
	manifestPath := flag.String("manifest", "", "JSONL evaluation manifest")
	projectRoot := flag.String("project-root", "..", "meet-translator project root for local audio references")
	outputsPath := flag.String("score-outputs", "", "JSONL inference outputs to score without storing their text in the report")
	scoreSplit := flag.String("score-split", "", "split to score: development, holdout, or contract")
	qualificationReportPath := flag.String("qualification-report", "", "recorded M1 Max real-integration qualification report JSON")
	qualificationAttestationPath := flag.String("qualification-attestation", "", "detached DSSE execution attestation JSON (requires --qualification-report)")
	qualificationOutputsPath := flag.String("qualification-outputs", "", "exact outputs artifact covered by the detached attestation")
	qualificationMeasurementsPath := flag.String("qualification-measurements", "", "exact measurements artifact covered by the detached attestation")
	measurementRecordPath := flag.String("measurement-record", "", "untrusted process-group measurement record JSON to validate and summarize")
	flag.Parse()
	if *measurementRecordPath != "" {
		if *qualificationReportPath != "" || *qualificationAttestationPath != "" || *qualificationOutputsPath != "" || *qualificationMeasurementsPath != "" || *manifestPath != "" || *trackFlag != "" || *outputsPath != "" || *scoreSplit != "" {
			fmt.Fprintln(os.Stderr, "measurement record mode cannot be combined with other evaluator flags")
			os.Exit(2)
		}
		recordRaw, err := readQualificationFile(*measurementRecordPath, maxQualificationEvidenceBytes)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		if _, err := runMeasurementCheck(recordRaw, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		return
	}
	if *qualificationReportPath != "" || *qualificationAttestationPath != "" || *qualificationOutputsPath != "" || *qualificationMeasurementsPath != "" {
		if *qualificationReportPath == "" {
			fmt.Fprintln(os.Stderr, "--qualification-attestation requires --qualification-report")
			os.Exit(2)
		}
		if *manifestPath != "" || *trackFlag != "" || *outputsPath != "" || *scoreSplit != "" {
			fmt.Fprintln(os.Stderr, "qualification report mode cannot be combined with manifest track flags")
			os.Exit(2)
		}
		assessment, runErr := runQualificationFiles(*qualificationReportPath, *qualificationAttestationPath, *qualificationOutputsPath, *qualificationMeasurementsPath, os.Stdout)
		if runErr != nil {
			fmt.Fprintln(os.Stderr, runErr)
			os.Exit(2)
		}
		os.Exit(qualificationExitCode(assessment.Status))
	}
	if *manifestPath == "" || !validTrack(Track(*trackFlag)) {
		fmt.Fprintln(os.Stderr, "usage: go run ./cmd/eval --track <asr-only|mt-only|end-to-end> --manifest <file.jsonl> [--project-root ..] [--score-outputs <outputs.jsonl> --score-split <development|holdout|contract>] | --qualification-report <recorded-report.json> [--qualification-attestation <detached-attestation.json> --qualification-outputs <outputs.bin> --qualification-measurements <measurements.json>] | --measurement-record <record.json>")
		os.Exit(2)
	}

	var err error
	if *outputsPath != "" {
		if *scoreSplit == "" {
			fmt.Fprintln(os.Stderr, "--score-outputs requires --score-split")
			os.Exit(2)
		}
		err = runScoreCheck(Track(*trackFlag), *scoreSplit, *manifestPath, *outputsPath, *projectRoot, os.Stdout)
	} else if *scoreSplit != "" {
		fmt.Fprintln(os.Stderr, "--score-split requires --score-outputs")
		os.Exit(2)
	} else {
		err = runManifestCheck(Track(*trackFlag), *manifestPath, *projectRoot, os.Stdout)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runQualificationFiles(reportPath, attestationPath, outputsPath, measurementsPath string, output io.Writer) (QualificationAssessment, error) {
	reportRaw, err := readQualificationFile(reportPath, maxQualificationReportBytes)
	if err != nil {
		return QualificationAssessment{}, fmt.Errorf("read qualification report: %w", err)
	}
	var attestationRaw []byte
	var outputsRaw []byte
	var measurementsRaw []byte
	if attestationPath != "" {
		if outputsPath == "" || measurementsPath == "" {
			return QualificationAssessment{}, errors.New("--qualification-attestation requires both --qualification-outputs and --qualification-measurements")
		}
		attestationRaw, err = readQualificationFile(attestationPath, maxQualificationAttestationBytes)
		if err != nil {
			return QualificationAssessment{}, fmt.Errorf("read qualification attestation: %w", err)
		}
		outputsRaw, err = readQualificationFile(outputsPath, maxQualificationEvidenceBytes)
		if err != nil {
			return QualificationAssessment{}, fmt.Errorf("read qualification outputs: %w", err)
		}
		measurementsRaw, err = readQualificationFile(measurementsPath, maxQualificationEvidenceBytes)
		if err != nil {
			return QualificationAssessment{}, fmt.Errorf("read qualification measurements: %w", err)
		}
	} else if outputsPath != "" || measurementsPath != "" {
		return QualificationAssessment{}, errors.New("qualification outputs and measurements require --qualification-attestation")
	}
	return runQualificationCheckWithAttestation(reportRaw, attestationRaw, outputsRaw, measurementsRaw, productionTrustedQualificationKeys(), output)
}

func readQualificationFile(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	data, readErr := readLimited(file, limit)
	closeErr := file.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return data, nil
}

func runScoreCheck(track Track, split, manifestPath, outputsPath, projectRoot string, out io.Writer) error {
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	cases, err := LoadCases(bytes.NewReader(manifestData), track)
	if err != nil {
		return err
	}
	if err := VerifyAudioAssets(projectRoot, cases); err != nil {
		return err
	}
	outputsData, err := os.ReadFile(outputsPath)
	if err != nil {
		return fmt.Errorf("read outputs: %w", err)
	}
	outputs, err := decodeEvaluationOutputs(bytes.NewReader(outputsData))
	if err != nil {
		return err
	}
	report, err := ScoreEvaluationTrack(track, split, cases, outputs, sha256Hex(manifestData), sha256Hex(outputsData))
	if err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return fmt.Errorf("encode score report: %w", err)
	}
	if _, err := fmt.Fprintln(out, string(encoded)); err != nil {
		return fmt.Errorf("write score report: %w", err)
	}
	return nil
}

func runManifestCheck(track Track, manifestPath, projectRoot string, out io.Writer) error {
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	cases, err := LoadCases(bytes.NewReader(data), track)
	if err != nil {
		return err
	}
	if err := VerifyAudioAssets(projectRoot, cases); err != nil {
		return err
	}

	report := manifestReport{
		Mode:                "model-free-manifest-check",
		Track:               track,
		ManifestSHA256:      sha256Hex(data),
		CaseCount:           len(cases),
		AudioAssetsVerified: true,
		InferenceExecuted:   false,
	}
	for _, item := range cases {
		switch item.Split {
		case "development":
			report.DevelopmentCount++
		case "holdout":
			report.HoldoutCount++
			if item.AnnotationStatus == "verified" {
				report.VerifiedHoldoutCount++
			}
		case "contract":
			report.ContractCount++
		}
		if PromotionEligible(item) {
			report.PromotionEligibleCount++
		}
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return fmt.Errorf("encode manifest report: %w", err)
	}
	_, err = fmt.Fprintln(out, string(encoded))
	if err != nil {
		return fmt.Errorf("write manifest report: %w", err)
	}
	return nil
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
