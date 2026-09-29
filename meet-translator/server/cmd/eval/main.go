package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	flag.Parse()
	if *manifestPath == "" || !validTrack(Track(*trackFlag)) {
		fmt.Fprintln(os.Stderr, "usage: go run ./cmd/eval --track <asr-only|mt-only|end-to-end> --manifest <file.jsonl> [--project-root ..]")
		os.Exit(2)
	}

	if err := runManifestCheck(Track(*trackFlag), *manifestPath, *projectRoot, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
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
