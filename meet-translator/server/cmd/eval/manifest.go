package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

type Track string

const (
	TrackASROnly  Track = "asr-only"
	TrackMTOnly   Track = "mt-only"
	TrackEndToEnd Track = "end-to-end"
)

type EvalCase struct {
	SchemaVersion         int               `json:"schemaVersion"`
	CaseID                string            `json:"caseId"`
	Track                 Track             `json:"track"`
	Split                 string            `json:"split"`
	SourceLanguage        string            `json:"sourceLanguage"`
	TargetLanguage        string            `json:"targetLanguage,omitempty"`
	AudioRef              string            `json:"audioRef,omitempty"`
	AudioSHA256           string            `json:"audioSHA256,omitempty"`
	SourceText            string            `json:"sourceText,omitempty"`
	ReferenceText         string            `json:"referenceText,omitempty"`
	ReferenceTranslations []string          `json:"referenceTranslations,omitempty"`
	ApprovedTerminology   map[string]string `json:"approvedTerminology,omitempty"`
	Context               []string          `json:"context,omitempty"`
	MeetingID             string            `json:"meetingId,omitempty"`
	SpeakerGroup          string            `json:"speakerGroup,omitempty"`
	Tags                  []string          `json:"tags,omitempty"`
	CriticalAssertions    []string          `json:"criticalAssertions,omitempty"`
	AnnotationVersion     string            `json:"annotationVersion"`
	AnnotationStatus      string            `json:"annotationStatus"`
	FixtureKind           string            `json:"fixtureKind,omitempty"`
	ExpectedDecision      string            `json:"expectedDecision,omitempty"`
}

var (
	caseIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,95}$`)
	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func LoadCases(r io.Reader, expectedTrack Track) ([]EvalCase, error) {
	if !validTrack(expectedTrack) {
		return nil, fmt.Errorf("unsupported requested track %q", expectedTrack)
	}

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	cases := make([]EvalCase, 0)
	seenIDs := make(map[string]struct{})
	for line := 1; scanner.Scan(); line++ {
		payload := strings.TrimSpace(scanner.Text())
		if payload == "" || strings.HasPrefix(payload, "#") {
			continue
		}

		var item EvalCase
		decoder := json.NewDecoder(strings.NewReader(payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&item); err != nil {
			return nil, fmt.Errorf("line %d: decode case: %w", line, err)
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			if err == nil {
				return nil, fmt.Errorf("line %d: expected one JSON object", line)
			}
			return nil, fmt.Errorf("line %d: trailing JSON: %w", line, err)
		}
		if err := validateCase(item, expectedTrack); err != nil {
			return nil, fmt.Errorf("line %d, case %q: %w", line, item.CaseID, err)
		}
		if _, exists := seenIDs[item.CaseID]; exists {
			return nil, fmt.Errorf("line %d: duplicate caseId %q", line, item.CaseID)
		}
		seenIDs[item.CaseID] = struct{}{}
		cases = append(cases, item)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read cases: %w", err)
	}
	if len(cases) == 0 {
		return nil, fmt.Errorf("manifest contains no cases")
	}
	if err := validateSplitIsolation(cases); err != nil {
		return nil, err
	}
	return cases, nil
}

func validateCase(item EvalCase, expectedTrack Track) error {
	if item.SchemaVersion != 1 {
		return fmt.Errorf("schemaVersion must be 1")
	}
	if !caseIDPattern.MatchString(item.CaseID) {
		return fmt.Errorf("caseId must be a lowercase stable identifier")
	}
	if !validTrack(item.Track) {
		return fmt.Errorf("unsupported track %q", item.Track)
	}
	if item.Track != expectedTrack {
		return fmt.Errorf("track %q does not match requested track %q", item.Track, expectedTrack)
	}
	if item.Split != "development" && item.Split != "holdout" && item.Split != "contract" {
		return fmt.Errorf("split must be development, holdout, or contract")
	}
	if item.AnnotationVersion == "" {
		return fmt.Errorf("annotationVersion is required")
	}
	if item.AnnotationStatus != "pending" && item.AnnotationStatus != "verified" && item.AnnotationStatus != "contract-test" {
		return fmt.Errorf("annotationStatus must be pending, verified, or contract-test")
	}
	if item.Split == "contract" {
		if item.FixtureKind != "synthetic" || item.AnnotationStatus != "contract-test" {
			return fmt.Errorf("contract cases must be synthetic contract-test fixtures")
		}
	} else {
		if item.MeetingID == "" || item.SpeakerGroup == "" {
			return fmt.Errorf("development and holdout cases require meetingId and speakerGroup")
		}
		if item.FixtureKind == "synthetic" {
			return fmt.Errorf("synthetic fixtures must use split=contract")
		}
		if item.AnnotationStatus == "contract-test" {
			return fmt.Errorf("contract-test annotationStatus requires split=contract")
		}
	}
	if !supportedLanguage(item.SourceLanguage) {
		return fmt.Errorf("sourceLanguage must be en or ja")
	}

	needsAudio := item.Track == TrackASROnly || item.Track == TrackEndToEnd
	if needsAudio {
		if err := validateAudioRef(item.AudioRef, item.AudioSHA256); err != nil {
			return err
		}
	} else if item.AudioRef != "" || item.AudioSHA256 != "" {
		return fmt.Errorf("mt-only cases must not contain audioRef or audioSHA256")
	}

	switch item.Track {
	case TrackASROnly:
		if item.TargetLanguage != "" || len(item.ReferenceTranslations) != 0 || item.SourceText != "" {
			return fmt.Errorf("asr-only cases use referenceText and must not contain translation inputs")
		}
		if item.ReferenceText == "" && item.FixtureKind != "synthetic" {
			return fmt.Errorf("empty referenceText is allowed only for synthetic no-speech fixtures")
		}
	case TrackMTOnly:
		if !supportedLanguage(item.TargetLanguage) || item.SourceLanguage == item.TargetLanguage {
			return fmt.Errorf("mt-only cases require distinct en/ja source and target languages")
		}
		if strings.TrimSpace(item.SourceText) == "" || len(item.ReferenceTranslations) == 0 {
			return fmt.Errorf("mt-only cases require sourceText and at least one reference translation")
		}
	case TrackEndToEnd:
		if !supportedLanguage(item.TargetLanguage) || item.SourceLanguage == item.TargetLanguage {
			return fmt.Errorf("end-to-end cases require distinct en/ja source and target languages")
		}
		if (item.ReferenceText == "" || len(item.ReferenceTranslations) == 0) && item.FixtureKind != "synthetic" {
			return fmt.Errorf("end-to-end quality cases require source and translation references")
		}
	}
	return nil
}

func validateAudioRef(audioRef, digest string) error {
	if audioRef == "" || strings.Contains(audioRef, `\`) || strings.Contains(audioRef, "://") {
		return fmt.Errorf("audioRef must be a local relative path")
	}
	if path.IsAbs(audioRef) || path.Clean(audioRef) != audioRef || strings.HasPrefix(audioRef, "../") || audioRef == ".." {
		return fmt.Errorf("audioRef must not be absolute or contain path traversal")
	}
	if !sha256Pattern.MatchString(digest) {
		return fmt.Errorf("audioSHA256 must be a lowercase SHA-256 digest")
	}
	return nil
}

func supportedLanguage(code string) bool {
	return code == "en" || code == "ja"
}

func validTrack(track Track) bool {
	return track == TrackASROnly || track == TrackMTOnly || track == TrackEndToEnd
}

func validateSplitIsolation(cases []EvalCase) error {
	meetings := make(map[string]string)
	speakers := make(map[string]string)
	for _, item := range cases {
		if item.Split == "contract" {
			continue
		}
		if previous, ok := meetings[item.MeetingID]; ok && previous != item.Split {
			return fmt.Errorf("meetingId %q appears in both %s and %s splits", item.MeetingID, previous, item.Split)
		}
		meetings[item.MeetingID] = item.Split
		if previous, ok := speakers[item.SpeakerGroup]; ok && previous != item.Split {
			return fmt.Errorf("speakerGroup %q appears in both %s and %s splits", item.SpeakerGroup, previous, item.Split)
		}
		speakers[item.SpeakerGroup] = item.Split
	}
	return nil
}

func PromotionEligible(item EvalCase) bool {
	return item.Split == "holdout" && item.AnnotationStatus == "verified" && item.FixtureKind != "synthetic"
}

func VerifyAudioAssets(projectRoot string, cases []EvalCase) error {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return fmt.Errorf("resolve project root: %w", err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("resolve project root symlinks: %w", err)
	}
	for _, item := range cases {
		if item.AudioRef == "" {
			continue
		}
		candidate := filepath.Join(root, filepath.FromSlash(item.AudioRef))
		rel, err := filepath.Rel(root, candidate)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("case %q audioRef escapes project root", item.CaseID)
		}
		current := root
		for _, segment := range strings.Split(filepath.FromSlash(item.AudioRef), string(filepath.Separator)) {
			current = filepath.Join(current, segment)
			info, err := os.Lstat(current)
			if err != nil {
				return fmt.Errorf("case %q audio asset %q: %w", item.CaseID, item.AudioRef, err)
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("case %q audioRef must not traverse symlinks", item.CaseID)
			}
		}

		file, err := os.Open(candidate)
		if err != nil {
			return fmt.Errorf("case %q open audio asset: %w", item.CaseID, err)
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil {
			return fmt.Errorf("case %q hash audio asset: %w", item.CaseID, copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("case %q close audio asset: %w", item.CaseID, closeErr)
		}
		if actual := hex.EncodeToString(hash.Sum(nil)); actual != item.AudioSHA256 {
			return fmt.Errorf("case %q audioSHA256 mismatch", item.CaseID)
		}
	}
	return nil
}
