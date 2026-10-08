package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

type EvaluationOutput struct {
	CaseID             string                      `json:"caseId"`
	Split              string                      `json:"split"`
	ASRText            *string                     `json:"asrText,omitempty"`
	TranslationText    *string                     `json:"translationText,omitempty"`
	Published          *bool                       `json:"published,omitempty"`
	CriticalAssertions []EvaluationAssertionResult `json:"criticalAssertions,omitempty"`
}

type EvaluationAssertionResult struct {
	Assertion string `json:"assertion"`
	Passed    bool   `json:"passed"`
}

type ErrorMetric struct {
	Cases          int      `json:"cases"`
	ScoredCases    int      `json:"scoredCases"`
	Substitutions  int      `json:"substitutions"`
	Deletions      int      `json:"deletions"`
	Insertions     int      `json:"insertions"`
	ReferenceUnits int      `json:"referenceUnits"`
	ErrorRate      *float64 `json:"errorRate"`
}

type TranslationMetric struct {
	Cases       int      `json:"cases"`
	ScoredCases int      `json:"scoredCases"`
	Score       *float64 `json:"score"`
	Signature   string   `json:"signature"`
	scoreCases  []chrfCase
}

type EndToEndDirectionMetric struct {
	Cases                     int      `json:"cases"`
	Published                 int      `json:"published"`
	Omitted                   int      `json:"omitted"`
	PublicationRate           *float64 `json:"publicationRate"`
	TranslationScoredCases    int      `json:"translationScoredCases"`
	PublishedTranslationChrF2 *float64 `json:"publishedTranslationChrF2"`
	ChrF2Signature            string   `json:"chrf2Signature"`
	scoreCases                []chrfCase
}

type EvaluationScoreReport struct {
	Mode                            string                             `json:"mode"`
	Track                           Track                              `json:"track"`
	Split                           string                             `json:"split"`
	ManifestSHA256                  string                             `json:"manifestSHA256"`
	OutputsSHA256                   string                             `json:"outputsSHA256"`
	CaseCount                       int                                `json:"caseCount"`
	ASRByLanguage                   map[string]ErrorMetric             `json:"asrByLanguage,omitempty"`
	E2EASRByLanguage                map[string]ErrorMetric             `json:"e2eAsrByLanguage,omitempty"`
	PublishedASRByLanguage          map[string]ErrorMetric             `json:"publishedAsrByLanguage,omitempty"`
	MTByDirection                   map[string]TranslationMetric       `json:"mtByDirection,omitempty"`
	E2EByDirection                  map[string]EndToEndDirectionMetric `json:"e2eByDirection,omitempty"`
	CriticalAssertionCount          int                                `json:"criticalAssertionCount"`
	CriticalAssertionFailures       int                                `json:"criticalAssertionFailures"`
	CriticalAssertionFailureCaseIDs []string                           `json:"criticalAssertionFailureCaseIds"`
	NonSpeechFalseOutputs           int                                `json:"nonSpeechFalseOutputs"`
	NonSpeechFalseOutputCharacters  int                                `json:"nonSpeechFalseOutputCharacters"`
	NonSpeechFalsePublications      int                                `json:"nonSpeechFalsePublications"`
	QualityEvidence                 bool                               `json:"qualityEvidence"`
	ProductStatus                   string                             `json:"productStatus"`
}

type CoverageStatus string

const (
	CoverageStatusBlocked  CoverageStatus = "BLOCKED"
	CoverageStatusRejected CoverageStatus = "REJECTED"
	CoverageStatusPass     CoverageStatus = "PASS"
)

type CoverageComparison struct {
	Mode     string         `json:"mode"`
	Status   CoverageStatus `json:"status"`
	Findings []string       `json:"findings"`
}

// ScoreEvaluationTrack computes reproducible offline metrics for exactly one
// split. Its report is intentionally untrusted: it cannot qualify a model or
// turn contract fixtures into product-quality evidence.
func ScoreEvaluationTrack(track Track, split string, cases []EvalCase, outputs []EvaluationOutput, manifestHash, outputsHash string) (EvaluationScoreReport, error) {
	if !validTrack(track) {
		return EvaluationScoreReport{}, fmt.Errorf("unsupported track %q", track)
	}
	if split != "development" && split != "holdout" && split != "contract" {
		return EvaluationScoreReport{}, fmt.Errorf("unsupported split %q", split)
	}
	if len(cases) == 0 {
		return EvaluationScoreReport{}, fmt.Errorf("manifest contains no cases")
	}

	selected := make(map[string]EvalCase)
	seenManifest := make(map[string]struct{}, len(cases))
	for _, item := range cases {
		if item.Track != track {
			return EvaluationScoreReport{}, fmt.Errorf("case %q track %q does not match requested track %q", item.CaseID, item.Track, track)
		}
		if !caseIDPattern.MatchString(item.CaseID) || !supportedLanguage(item.SourceLanguage) {
			return EvaluationScoreReport{}, fmt.Errorf("case %q has invalid case ID or source language", item.CaseID)
		}
		if item.Split != "development" && item.Split != "holdout" && item.Split != "contract" {
			return EvaluationScoreReport{}, fmt.Errorf("case %q has invalid split %q", item.CaseID, item.Split)
		}
		if track != TrackASROnly && (!supportedLanguage(item.TargetLanguage) || item.SourceLanguage == item.TargetLanguage) {
			return EvaluationScoreReport{}, fmt.Errorf("case %q has invalid translation direction", item.CaseID)
		}
		if track == TrackMTOnly && (strings.TrimSpace(item.SourceText) == "" || !nonEmptyReferences(item.ReferenceTranslations)) {
			return EvaluationScoreReport{}, fmt.Errorf("case %q requires a source and non-empty reference translations", item.CaseID)
		}
		if track == TrackEndToEnd && len(item.ReferenceTranslations) > 0 && !nonEmptyReferences(item.ReferenceTranslations) {
			return EvaluationScoreReport{}, fmt.Errorf("case %q contains an empty reference translation", item.CaseID)
		}
		if _, exists := seenManifest[item.CaseID]; exists {
			return EvaluationScoreReport{}, fmt.Errorf("duplicate case %q in manifest", item.CaseID)
		}
		seenManifest[item.CaseID] = struct{}{}
		if item.Split == split {
			selected[item.CaseID] = item
		}
	}
	if len(selected) == 0 {
		return EvaluationScoreReport{}, fmt.Errorf("manifest contains no %s cases", split)
	}

	byID := make(map[string]EvaluationOutput, len(outputs))
	for _, output := range outputs {
		if output.Split != split {
			return EvaluationScoreReport{}, fmt.Errorf("output %q split %q does not match requested split %q", output.CaseID, output.Split, split)
		}
		if _, exists := selected[output.CaseID]; !exists {
			return EvaluationScoreReport{}, fmt.Errorf("unknown case %q in outputs", output.CaseID)
		}
		if _, exists := byID[output.CaseID]; exists {
			return EvaluationScoreReport{}, fmt.Errorf("duplicate output for case %q", output.CaseID)
		}
		byID[output.CaseID] = output
	}
	for caseID := range selected {
		if _, exists := byID[caseID]; !exists {
			return EvaluationScoreReport{}, fmt.Errorf("missing case %q in outputs", caseID)
		}
	}

	report := EvaluationScoreReport{
		Mode: "score-only-untrusted", Track: track, Split: split,
		ManifestSHA256: manifestHash, OutputsSHA256: outputsHash,
		CaseCount: len(selected), QualityEvidence: false, ProductStatus: "not-evaluated",
		ASRByLanguage:          make(map[string]ErrorMetric),
		E2EASRByLanguage:       make(map[string]ErrorMetric),
		PublishedASRByLanguage: make(map[string]ErrorMetric),
		MTByDirection:          make(map[string]TranslationMetric),
		E2EByDirection:         make(map[string]EndToEndDirectionMetric),
	}
	ids := make([]string, 0, len(selected))
	for caseID := range selected {
		ids = append(ids, caseID)
	}
	sort.Strings(ids)

	for _, caseID := range ids {
		item := selected[caseID]
		output := byID[caseID]
		if err := validateOutputFields(track, item, output); err != nil {
			return EvaluationScoreReport{}, fmt.Errorf("case %q: %w", caseID, err)
		}
		if err := addCriticalAssertionResults(&report, item, output); err != nil {
			return EvaluationScoreReport{}, fmt.Errorf("case %q: %w", caseID, err)
		}

		switch track {
		case TrackASROnly:
			metric := report.ASRByLanguage[item.SourceLanguage]
			metric.Cases++
			if hasReference(item.ReferenceText) {
				metric.add(errorCounts(item.SourceLanguage, item.ReferenceText, *output.ASRText))
			} else if hasOutput(*output.ASRText) {
				report.NonSpeechFalseOutputs++
				report.NonSpeechFalseOutputCharacters += utf8Length(*output.ASRText)
			}
			report.ASRByLanguage[item.SourceLanguage] = metric
		case TrackMTOnly:
			direction := languageDirection(item.SourceLanguage, item.TargetLanguage)
			metric := report.MTByDirection[direction]
			metric.Cases++
			if metric.ScoredCases > 0 && signatureReferenceCount(metric.Signature) != len(item.ReferenceTranslations) {
				return EvaluationScoreReport{}, fmt.Errorf("direction %s has inconsistent reference translation counts", direction)
			}
			metric.ScoredCases++
			metric.Signature = chrfSignature(len(item.ReferenceTranslations))
			metric.scoreCases = append(metric.scoreCases, chrfCase{hypothesis: *output.TranslationText, references: item.ReferenceTranslations})
			report.MTByDirection[direction] = metric
		case TrackEndToEnd:
			direction := languageDirection(item.SourceLanguage, item.TargetLanguage)
			directionMetric := report.E2EByDirection[direction]
			directionMetric.Cases++
			published := *output.Published && hasOutput(*output.TranslationText)
			publicSource, publicTranslation := "", ""
			if published {
				directionMetric.Published++
				publicSource, publicTranslation = *output.ASRText, *output.TranslationText
			} else {
				directionMetric.Omitted++
				if *output.Published && hasOutput(*output.ASRText) {
					publicSource = *output.ASRText
				}
			}
			if directionMetric.Cases > 0 {
				directionMetric.PublicationRate = floatPointer(float64(directionMetric.Published) / float64(directionMetric.Cases))
			}
			asrMetric := report.E2EASRByLanguage[item.SourceLanguage]
			asrMetric.Cases++
			publicMetric := report.PublishedASRByLanguage[item.SourceLanguage]
			publicMetric.Cases++
			if hasReference(item.ReferenceText) {
				asrMetric.add(errorCounts(item.SourceLanguage, item.ReferenceText, *output.ASRText))
				report.E2EASRByLanguage[item.SourceLanguage] = asrMetric

				publicMetric.add(errorCounts(item.SourceLanguage, item.ReferenceText, publicSource))
			} else if hasOutput(*output.ASRText) || hasOutput(*output.TranslationText) {
				report.NonSpeechFalseOutputs++
				report.NonSpeechFalseOutputCharacters += utf8Length(*output.ASRText) + utf8Length(*output.TranslationText)
			}
			report.E2EASRByLanguage[item.SourceLanguage] = asrMetric
			report.PublishedASRByLanguage[item.SourceLanguage] = publicMetric
			if !hasReference(item.ReferenceText) && published && (hasOutput(*output.ASRText) || hasOutput(*output.TranslationText)) {
				report.NonSpeechFalsePublications++
			}
			if len(item.ReferenceTranslations) > 0 {
				if directionMetric.TranslationScoredCases == 0 {
					directionMetric.ChrF2Signature = chrfSignature(len(item.ReferenceTranslations))
				} else if signatureReferenceCount(directionMetric.ChrF2Signature) != len(item.ReferenceTranslations) {
					return EvaluationScoreReport{}, fmt.Errorf("direction %s has inconsistent reference translation counts", direction)
				}
				directionMetric.TranslationScoredCases++
				directionMetric.scoreCases = append(directionMetric.scoreCases, chrfCase{hypothesis: publicTranslation, references: item.ReferenceTranslations})
			}
			report.E2EByDirection[direction] = directionMetric
		}
	}

	for language, metric := range report.ASRByLanguage {
		metric.finish()
		report.ASRByLanguage[language] = metric
	}
	for language, metric := range report.E2EASRByLanguage {
		metric.finish()
		report.E2EASRByLanguage[language] = metric
	}
	for language, metric := range report.PublishedASRByLanguage {
		metric.finish()
		report.PublishedASRByLanguage[language] = metric
	}
	for direction, metric := range report.MTByDirection {
		metric.Score = chrf2Corpus(metric.scoreCases)
		metric.scoreCases = nil
		report.MTByDirection[direction] = metric
	}
	for direction, metric := range report.E2EByDirection {
		metric.PublishedTranslationChrF2 = chrf2Corpus(metric.scoreCases)
		metric.scoreCases = nil
		report.E2EByDirection[direction] = metric
	}
	sort.Strings(report.CriticalAssertionFailureCaseIDs)
	return report, nil
}

func validateOutputFields(track Track, item EvalCase, output EvaluationOutput) error {
	switch track {
	case TrackASROnly:
		if output.ASRText == nil || output.TranslationText != nil || output.Published != nil || len(output.CriticalAssertions) != 0 {
			return fmt.Errorf("asr-only output must contain only asrText")
		}
	case TrackMTOnly:
		if output.ASRText != nil || output.TranslationText == nil || output.Published != nil || len(output.CriticalAssertions) != 0 {
			return fmt.Errorf("mt-only output must contain only translationText")
		}
	case TrackEndToEnd:
		if output.ASRText == nil || output.TranslationText == nil || output.Published == nil {
			return fmt.Errorf("end-to-end output requires asrText, translationText, and published")
		}
	}
	seen := make(map[string]struct{}, len(output.CriticalAssertions))
	for _, result := range output.CriticalAssertions {
		if _, duplicate := seen[result.Assertion]; duplicate {
			return fmt.Errorf("duplicate critical assertion result %q", result.Assertion)
		}
		seen[result.Assertion] = struct{}{}
	}
	if len(seen) != len(item.CriticalAssertions) {
		return fmt.Errorf("critical assertion results do not match the manifest")
	}
	for _, assertion := range item.CriticalAssertions {
		if _, ok := seen[assertion]; !ok {
			return fmt.Errorf("critical assertion results do not match the manifest")
		}
	}
	return nil
}

func nonEmptyReferences(references []string) bool {
	if len(references) == 0 {
		return false
	}
	for _, reference := range references {
		if strings.TrimSpace(reference) == "" {
			return false
		}
	}
	return true
}

func addCriticalAssertionResults(report *EvaluationScoreReport, item EvalCase, output EvaluationOutput) error {
	if len(item.CriticalAssertions) == 0 {
		return nil
	}
	report.CriticalAssertionCount += len(item.CriticalAssertions)
	failed := false
	for _, assertion := range output.CriticalAssertions {
		if !assertion.Passed {
			report.CriticalAssertionFailures++
			failed = true
		}
	}
	if failed {
		report.CriticalAssertionFailureCaseIDs = append(report.CriticalAssertionFailureCaseIDs, item.CaseID)
	}
	return nil
}

type editCounts struct {
	substitutions int
	deletions     int
	insertions    int
	reference     int
}

func (metric *ErrorMetric) add(counts editCounts) {
	metric.ScoredCases++
	metric.Substitutions += counts.substitutions
	metric.Deletions += counts.deletions
	metric.Insertions += counts.insertions
	metric.ReferenceUnits += counts.reference
}

func (metric *ErrorMetric) finish() {
	if metric.ReferenceUnits == 0 {
		metric.ErrorRate = nil
		return
	}
	rate := float64(metric.Substitutions+metric.Deletions+metric.Insertions) / float64(metric.ReferenceUnits)
	metric.ErrorRate = &rate
}

func errorCounts(language, reference, hypothesis string) editCounts {
	if language == "ja" {
		ref := []rune(removeUnicodeWhitespace(norm.NFC.String(reference)))
		hyp := []rune(removeUnicodeWhitespace(norm.NFC.String(hypothesis)))
		return levenshteinCounts(ref, hyp)
	}
	fold := cases.Fold()
	ref := strings.Fields(fold.String(norm.NFC.String(reference)))
	hyp := strings.Fields(fold.String(norm.NFC.String(hypothesis)))
	return levenshteinCounts(ref, hyp)
}

func levenshteinCounts[T comparable](reference, hypothesis []T) editCounts {
	rows, columns := len(reference)+1, len(hypothesis)+1
	cost := make([][]int, rows)
	operation := make([][]byte, rows)
	for i := 0; i < rows; i++ {
		cost[i] = make([]int, columns)
		operation[i] = make([]byte, columns)
	}
	for i := 1; i < rows; i++ {
		cost[i][0], operation[i][0] = i, 'D'
	}
	for j := 1; j < columns; j++ {
		cost[0][j], operation[0][j] = j, 'I'
	}
	for i := 1; i < rows; i++ {
		for j := 1; j < columns; j++ {
			if reference[i-1] == hypothesis[j-1] {
				cost[i][j], operation[i][j] = cost[i-1][j-1], 'M'
				continue
			}
			// Stable tie order: substitution, deletion, then insertion.
			best, op := cost[i-1][j-1]+1, byte('S')
			if deletion := cost[i-1][j] + 1; deletion < best {
				best, op = deletion, 'D'
			}
			if insertion := cost[i][j-1] + 1; insertion < best {
				best, op = insertion, 'I'
			}
			cost[i][j], operation[i][j] = best, op
		}
	}
	counts := editCounts{reference: len(reference)}
	for i, j := len(reference), len(hypothesis); i > 0 || j > 0; {
		switch operation[i][j] {
		case 'M':
			i, j = i-1, j-1
		case 'S':
			counts.substitutions++
			i, j = i-1, j-1
		case 'D':
			counts.deletions++
			i--
		case 'I':
			counts.insertions++
			j--
		default:
			panic("invalid edit distance backtrace")
		}
	}
	return counts
}

func utf8Length(value string) int {
	return len([]rune(value))
}

func removeUnicodeWhitespace(value string) string {
	var builder strings.Builder
	for _, r := range value {
		if !unicode.IsSpace(r) {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func hasReference(value string) bool { return strings.TrimSpace(value) != "" }
func hasOutput(value string) bool    { return strings.TrimSpace(value) != "" }

func languageDirection(source, target string) string { return source + "->" + target }

func floatPointer(value float64) *float64 { return &value }

type chrfCase struct {
	hypothesis string
	references []string
}

func chrfSignature(referenceCount int) string {
	return fmt.Sprintf("chrF2|nrefs:%d|case:mixed|eff:yes|nc:6|nw:0|space:no|version:2.6.0", referenceCount)
}

func signatureReferenceCount(signature string) int {
	parts := strings.SplitN(signature, "|", 3)
	if len(parts) < 2 || !strings.HasPrefix(parts[1], "nrefs:") {
		return -1
	}
	var count int
	if _, err := fmt.Sscanf(parts[1], "nrefs:%d", &count); err != nil {
		return -1
	}
	return count
}

func chrf2Corpus(cases []chrfCase) *float64 {
	if len(cases) == 0 {
		return nil
	}
	const orders = 6
	corpus := [orders][3]int{}
	for _, item := range cases {
		processedHyp := removeUnicodeWhitespace(item.hypothesis)
		hypGrams := characterNGrams(processedHyp, orders)
		bestScore := -1.0
		var best [orders][3]int
		for _, reference := range item.references {
			refGrams := characterNGrams(removeUnicodeWhitespace(reference), orders)
			stats := [orders][3]int{}
			for order := 0; order < orders; order++ {
				hypCount := countNGrams(hypGrams[order])
				refCount := countNGrams(refGrams[order])
				matchCount := intersectNGrams(hypGrams[order], refGrams[order])
				if refCount == 0 {
					hypCount = 0
				}
				stats[order] = [3]int{hypCount, refCount, matchCount}
			}
			score := chrfScoreFromStatistics(stats)
			if score > bestScore {
				bestScore, best = score, stats
			}
		}
		for order := range corpus {
			for field := range corpus[order] {
				corpus[order][field] += best[order][field]
			}
		}
	}
	score := chrfScoreFromStatistics(corpus)
	return &score
}

func chrfScoreFromStatistics(stats [6][3]int) float64 {
	const beta2 = 4.0
	const eps = 1e-16
	var precision, recall float64
	effectiveOrders := 0
	for _, order := range stats {
		hypCount, refCount, matchCount := float64(order[0]), float64(order[1]), float64(order[2])
		p, r := eps, eps
		if hypCount > 0 {
			p = matchCount / hypCount
		}
		if refCount > 0 {
			r = matchCount / refCount
		}
		if hypCount > 0 && refCount > 0 {
			precision += p
			recall += r
			effectiveOrders++
		}
	}
	if effectiveOrders == 0 {
		return 0
	}
	precision /= float64(effectiveOrders)
	recall /= float64(effectiveOrders)
	if precision+recall == 0 {
		return 0
	}
	return 100 * ((1 + beta2) * precision * recall) / (beta2*precision + recall)
}

func characterNGrams(value string, maxOrder int) []map[string]int {
	runes := []rune(value)
	grams := make([]map[string]int, maxOrder)
	for order := 1; order <= maxOrder; order++ {
		counts := make(map[string]int)
		for start := 0; start+order <= len(runes); start++ {
			counts[string(runes[start:start+order])]++
		}
		grams[order-1] = counts
	}
	return grams
}

func countNGrams(ngrams map[string]int) int {
	count := 0
	for _, occurrences := range ngrams {
		count += occurrences
	}
	return count
}

func intersectNGrams(hypothesis, reference map[string]int) int {
	count := 0
	for ngram, occurrences := range hypothesis {
		if referenceOccurrences := reference[ngram]; referenceOccurrences < occurrences {
			count += referenceOccurrences
		} else {
			count += occurrences
		}
	}
	return count
}

func ComparePublicationCoverage(baseline, candidate EvaluationScoreReport) CoverageComparison {
	comparison := CoverageComparison{Mode: "coverage-only", Status: CoverageStatusBlocked, Findings: []string{}}
	if baseline.Track != TrackEndToEnd || candidate.Track != TrackEndToEnd {
		comparison.Findings = append(comparison.Findings, "TRACK_MISMATCH")
		return comparison
	}
	if baseline.Split != candidate.Split {
		comparison.Findings = append(comparison.Findings, "SPLIT_MISMATCH")
		return comparison
	}
	if baseline.ManifestSHA256 == "" || baseline.ManifestSHA256 != candidate.ManifestSHA256 {
		comparison.Findings = append(comparison.Findings, "MANIFEST_MISMATCH")
		return comparison
	}
	if baseline.CaseCount == 0 || baseline.CaseCount != candidate.CaseCount {
		comparison.Findings = append(comparison.Findings, "CASE_COUNT_MISMATCH")
		return comparison
	}
	if finding := validateCoverageCounts(baseline); finding != "" {
		comparison.Findings = append(comparison.Findings, "BASELINE_"+finding)
		return comparison
	}
	if finding := validateCoverageCounts(candidate); finding != "" {
		comparison.Findings = append(comparison.Findings, "CANDIDATE_"+finding)
		return comparison
	}
	baseKeys := make([]string, 0, len(baseline.E2EByDirection))
	for key := range baseline.E2EByDirection {
		baseKeys = append(baseKeys, key)
	}
	sort.Strings(baseKeys)
	candidateKeys := make([]string, 0, len(candidate.E2EByDirection))
	for key := range candidate.E2EByDirection {
		candidateKeys = append(candidateKeys, key)
	}
	sort.Strings(candidateKeys)
	if len(baseKeys) == 0 || strings.Join(baseKeys, "\x00") != strings.Join(candidateKeys, "\x00") {
		comparison.Findings = append(comparison.Findings, "DIRECTION_MISMATCH")
		return comparison
	}
	for _, direction := range baseKeys {
		base := baseline.E2EByDirection[direction]
		current := candidate.E2EByDirection[direction]
		if base.Cases <= 0 || base.Cases != current.Cases {
			comparison.Findings = append(comparison.Findings, "DIRECTION_CASE_COUNT_MISMATCH:"+direction)
			return comparison
		}
	}

	basePublished, currentPublished := 0, 0
	for _, direction := range baseKeys {
		base := baseline.E2EByDirection[direction]
		current := candidate.E2EByDirection[direction]
		basePublished += base.Published
		currentPublished += current.Published
		if current.Published*base.Cases < base.Published*current.Cases {
			comparison.Findings = append(comparison.Findings, "DIRECTION_COVERAGE_REGRESSION:"+direction)
		}
	}
	if currentPublished == 0 {
		comparison.Findings = append(comparison.Findings, "ALL_CAPTIONS_HELD")
	}
	if currentPublished*baseline.CaseCount < basePublished*candidate.CaseCount {
		comparison.Findings = append(comparison.Findings, "TOTAL_COVERAGE_REGRESSION")
	}
	if len(comparison.Findings) > 0 {
		comparison.Status = CoverageStatusRejected
		return comparison
	}
	comparison.Status = CoverageStatusPass
	return comparison
}

func validateCoverageCounts(report EvaluationScoreReport) string {
	if len(report.E2EByDirection) == 0 {
		return "MISSING_DIRECTIONS"
	}
	totalCases := 0
	for direction, metric := range report.E2EByDirection {
		if metric.Cases <= 0 || metric.Published < 0 || metric.Published > metric.Cases || metric.Omitted != metric.Cases-metric.Published {
			return "INVALID_DIRECTION_COUNTS:" + direction
		}
		totalCases += metric.Cases
	}
	if totalCases != report.CaseCount {
		return "INVALID_TOTAL_CASE_COUNT"
	}
	return ""
}

func decodeEvaluationOutputs(r io.Reader) ([]EvaluationOutput, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	outputs := make([]EvaluationOutput, 0)
	for line := 1; scanner.Scan(); line++ {
		payload := strings.TrimSpace(scanner.Text())
		if payload == "" || strings.HasPrefix(payload, "#") {
			continue
		}
		var output EvaluationOutput
		decoder := json.NewDecoder(strings.NewReader(payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&output); err != nil {
			return nil, fmt.Errorf("line %d: decode output: %w", line, err)
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			if err == nil {
				return nil, fmt.Errorf("line %d: expected one JSON object", line)
			}
			return nil, fmt.Errorf("line %d: trailing JSON: %w", line, err)
		}
		outputs = append(outputs, output)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read outputs: %w", err)
	}
	return outputs, nil
}
