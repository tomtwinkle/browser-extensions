package main

import (
	"strings"
	"testing"
)

func scoreTestString(value string) *string { return &value }
func scoreTestBool(value bool) *bool       { return &value }

func scoreTestASRCase(id, language, reference string) EvalCase {
	return EvalCase{CaseID: id, Track: TrackASROnly, Split: "contract", SourceLanguage: language,
		ReferenceText: reference, AnnotationVersion: "contract-v1", AnnotationStatus: "contract-test", FixtureKind: "synthetic"}
}

func scoreTestMTCase(id, sourceLanguage, targetLanguage string, references ...string) EvalCase {
	return EvalCase{CaseID: id, Track: TrackMTOnly, Split: "contract", SourceLanguage: sourceLanguage,
		TargetLanguage: targetLanguage, SourceText: "verified source", ReferenceTranslations: references,
		AnnotationVersion: "contract-v1", AnnotationStatus: "contract-test", FixtureKind: "synthetic"}
}

func scoreTestE2ECase(id, sourceLanguage, targetLanguage, sourceReference string, translationReferences []string, assertions ...string) EvalCase {
	return EvalCase{CaseID: id, Track: TrackEndToEnd, Split: "contract", SourceLanguage: sourceLanguage,
		TargetLanguage: targetLanguage, ReferenceText: sourceReference, ReferenceTranslations: translationReferences,
		CriticalAssertions: assertions, AnnotationVersion: "contract-v1", AnnotationStatus: "contract-test", FixtureKind: "synthetic"}
}

func scoreTestASROutput(id, hypothesis string) EvaluationOutput {
	return EvaluationOutput{CaseID: id, Split: "contract", ASRText: scoreTestString(hypothesis)}
}

func scoreTestTranslationOutput(id, hypothesis string) EvaluationOutput {
	return EvaluationOutput{CaseID: id, Split: "contract", TranslationText: scoreTestString(hypothesis)}
}

func scoreTestE2EOutput(id, source, translation string, published bool, assertions ...EvaluationAssertionResult) EvaluationOutput {
	return EvaluationOutput{CaseID: id, Split: "contract", ASRText: scoreTestString(source),
		TranslationText: scoreTestString(translation), Published: scoreTestBool(published), CriticalAssertions: assertions}
}

func TestScoreASRNormalizesNFCAndKeepsLanguageMetricsSeparate(t *testing.T) {
	cases := []EvalCase{
		scoreTestASRCase("ja.nfc", "ja", "か\u3099き"),
		scoreTestASRCase("en.fold", "en", "STRAẞE."),
	}
	outputs := []EvaluationOutput{
		scoreTestASROutput("ja.nfc", "がき"),
		scoreTestASROutput("en.fold", "straße."),
	}
	report, err := ScoreEvaluationTrack(TrackASROnly, "contract", cases, outputs, "manifest-hash", "outputs-hash")
	if err != nil {
		t.Fatal(err)
	}
	if got := report.ASRByLanguage["ja"].ErrorRate; got == nil || *got != 0 {
		t.Fatalf("Japanese CER = %v; want 0", got)
	}
	if got := report.ASRByLanguage["en"].ErrorRate; got == nil || *got != 0 {
		t.Fatalf("English WER = %v; want 0", got)
	}
}

func TestScoreASRAggregatesCorpusSubstitutionDeletionAndInsertionCounts(t *testing.T) {
	cases := []EvalCase{
		scoreTestASRCase("asr.sdi.1", "en", "a b c"),
		scoreTestASRCase("asr.sdi.2", "en", "one two"),
		scoreTestASRCase("asr.sdi.3", "en", "same"),
	}
	outputs := []EvaluationOutput{
		scoreTestASROutput("asr.sdi.1", "a d"),
		scoreTestASROutput("asr.sdi.2", "one extra two"),
		scoreTestASROutput("asr.sdi.3", "same"),
	}
	report, err := ScoreEvaluationTrack(TrackASROnly, "contract", cases, outputs, "manifest", "outputs")
	if err != nil {
		t.Fatal(err)
	}
	metric := report.ASRByLanguage["en"]
	if metric.Substitutions != 1 || metric.Deletions != 1 || metric.Insertions != 1 || metric.ReferenceUnits != 6 {
		t.Fatalf("corpus edit counts = %#v; want S=1 D=1 I=1 N=6", metric)
	}
	if metric.ErrorRate == nil || *metric.ErrorRate != 0.5 {
		t.Fatalf("WER = %v; want 0.5", metric.ErrorRate)
	}
}

func TestScoreSelectsOnlyTheRequestedSplit(t *testing.T) {
	development := scoreTestASRCase("asr.dev", "en", "hello")
	development.Split = "development"
	holdout := scoreTestASRCase("asr.holdout", "en", "private holdout")
	holdout.Split = "holdout"
	report, err := ScoreEvaluationTrack(TrackASROnly, "development", []EvalCase{development, holdout},
		[]EvaluationOutput{{CaseID: "asr.dev", Split: "development", ASRText: scoreTestString("hello")}}, "manifest", "outputs")
	if err != nil {
		t.Fatal(err)
	}
	if report.CaseCount != 1 || report.ASRByLanguage["en"].ScoredCases != 1 {
		t.Fatalf("selected split report = %#v", report)
	}
}

func TestScoreTranslationUsesPinnedSacreBLEUChrF2AndMultipleReferences(t *testing.T) {
	caseItem := scoreTestMTCase("mt.multi", "ja", "en", "old phrasing", "The build must fail.")
	report, err := ScoreEvaluationTrack(TrackMTOnly, "contract", []EvalCase{caseItem},
		[]EvaluationOutput{scoreTestTranslationOutput("mt.multi", "The build must fail.")}, "manifest-hash", "outputs-hash")
	if err != nil {
		t.Fatal(err)
	}
	metric := report.MTByDirection["ja->en"]
	if metric.Score == nil || *metric.Score != 100 {
		t.Fatalf("ChrF2 = %v; want 100", metric.Score)
	}
	if metric.Signature != "chrF2|nrefs:2|case:mixed|eff:yes|nc:6|nw:0|space:no|version:2.6.0" {
		t.Fatalf("signature = %q", metric.Signature)
	}
}

func TestChrF2RemovesWhitespaceButKeepsPunctuation(t *testing.T) {
	caseItem := scoreTestMTCase("mt.whitespace", "en", "ja", "A B")
	report, err := ScoreEvaluationTrack(TrackMTOnly, "contract", []EvalCase{caseItem},
		[]EvaluationOutput{scoreTestTranslationOutput("mt.whitespace", "AB")}, "manifest", "outputs")
	if err != nil {
		t.Fatal(err)
	}
	if got := report.MTByDirection["en->ja"].Score; got == nil || *got != 100 {
		t.Fatalf("whitespace-insensitive chrF2 = %v; want 100", got)
	}
	caseItem.ReferenceTranslations = []string{"Hi."}
	report, err = ScoreEvaluationTrack(TrackMTOnly, "contract", []EvalCase{caseItem},
		[]EvaluationOutput{scoreTestTranslationOutput("mt.whitespace", "Hi")}, "manifest", "outputs")
	if err != nil {
		t.Fatal(err)
	}
	if got := report.MTByDirection["en->ja"].Score; got == nil || *got >= 100 {
		t.Fatalf("punctuation-sensitive chrF2 = %v; want less than 100", got)
	}
}

func TestChrF2RequiresAStableReferenceCountWithinEachDirection(t *testing.T) {
	first := scoreTestMTCase("mt.refs.1", "ja", "en", "one", "first alternate")
	second := scoreTestMTCase("mt.refs.2", "ja", "en", "two")
	_, err := ScoreEvaluationTrack(TrackMTOnly, "contract", []EvalCase{first, second}, []EvaluationOutput{
		scoreTestTranslationOutput("mt.refs.1", "one"), scoreTestTranslationOutput("mt.refs.2", "two"),
	}, "manifest", "outputs")
	if err == nil || !strings.Contains(err.Error(), "inconsistent reference translation counts") {
		t.Fatalf("inconsistent reference counts error = %v", err)
	}
}

func TestScoreCriticalAssertionFailuresCoverNegationNumberNameAndAddedContent(t *testing.T) {
	assertions := []string{"negation preserved", "20 ms stays milliseconds", "Acme remains Acme", "no extra approval claim"}
	results := make([]EvaluationAssertionResult, 0, len(assertions))
	for _, assertion := range assertions {
		results = append(results, EvaluationAssertionResult{Assertion: assertion, Passed: false})
	}
	caseItem := scoreTestE2ECase("e2e.critical", "en", "ja", "Do not ship 20 ms to Acme.",
		[]string{"Acmeへ20ミリ秒の出荷をしないでください。"}, assertions...)
	report, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", []EvalCase{caseItem},
		[]EvaluationOutput{scoreTestE2EOutput("e2e.critical", "Do not ship 20 ms to Acme.", "Acmeへ20秒の出荷を許可してください。追加承認済みです。", true, results...)},
		"manifest-hash", "outputs-hash")
	if err != nil {
		t.Fatal(err)
	}
	if report.CriticalAssertionCount != 4 || report.CriticalAssertionFailures != 4 || len(report.CriticalAssertionFailureCaseIDs) != 1 {
		t.Fatalf("assertion report = %#v", report)
	}
}

func TestScoreFlagsPublishedTextForNonSpeechE2ECase(t *testing.T) {
	caseItem := scoreTestE2ECase("e2e.silence", "en", "ja", "", nil)
	report, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", []EvalCase{caseItem},
		[]EvaluationOutput{scoreTestE2EOutput("e2e.silence", "unspoken text", "未発話の訳", true)},
		"manifest-hash", "outputs-hash")
	if err != nil {
		t.Fatal(err)
	}
	if report.NonSpeechFalsePublications != 1 {
		t.Fatalf("false publications = %d; want 1", report.NonSpeechFalsePublications)
	}
	if report.NonSpeechFalseOutputs != 1 || report.NonSpeechFalseOutputCharacters != 18 {
		t.Fatalf("false output count/chars = %d/%d; want 1/18", report.NonSpeechFalseOutputs, report.NonSpeechFalseOutputCharacters)
	}
}

func TestAllHeldCaptionsRemainDeletionsAndCannotPassCoverageGate(t *testing.T) {
	cases := []EvalCase{
		scoreTestE2ECase("ja-en.1", "ja", "en", "原文1", []string{"source one"}),
		scoreTestE2ECase("en-ja.1", "en", "ja", "Source two", []string{"原文2"}),
	}
	baselineOutputs := []EvaluationOutput{
		scoreTestE2EOutput("ja-en.1", "原文1", "source one", true),
		scoreTestE2EOutput("en-ja.1", "Source two", "原文2", true),
	}
	candidateOutputs := []EvaluationOutput{
		scoreTestE2EOutput("ja-en.1", "原文1", "source one", false),
		scoreTestE2EOutput("en-ja.1", "Source two", "原文2", false),
	}
	baseline, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", cases, baselineOutputs, "same-manifest", "baseline")
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", cases, candidateOutputs, "same-manifest", "candidate")
	if err != nil {
		t.Fatal(err)
	}
	comparison := ComparePublicationCoverage(baseline, candidate)
	if comparison.Status != CoverageStatusRejected || !containsString(comparison.Findings, "ALL_CAPTIONS_HELD") {
		t.Fatalf("coverage gate = %#v; all-hold must reject", comparison)
	}
	for _, direction := range candidate.E2EByDirection {
		if direction.PublishedTranslationChrF2 == nil || *direction.PublishedTranslationChrF2 != 0 {
			t.Fatalf("withheld translation must score as deletion, got %#v", direction)
		}
	}
}

func TestOneDirectionHoldIsVisibleInDirectionSpecificCoverage(t *testing.T) {
	cases := []EvalCase{
		scoreTestE2ECase("ja-en.1", "ja", "en", "原文1", []string{"source one"}),
		scoreTestE2ECase("en-ja.1", "en", "ja", "Source two", []string{"原文2"}),
	}
	baseline, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", cases, []EvaluationOutput{
		scoreTestE2EOutput("ja-en.1", "原文1", "source one", true), scoreTestE2EOutput("en-ja.1", "Source two", "原文2", true),
	}, "same-manifest", "baseline")
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", cases, []EvaluationOutput{
		scoreTestE2EOutput("ja-en.1", "原文1", "source one", false), scoreTestE2EOutput("en-ja.1", "Source two", "原文2", true),
	}, "same-manifest", "candidate")
	if err != nil {
		t.Fatal(err)
	}
	comparison := ComparePublicationCoverage(baseline, candidate)
	if comparison.Status != CoverageStatusRejected || !containsString(comparison.Findings, "DIRECTION_COVERAGE_REGRESSION:ja->en") {
		t.Fatalf("coverage gate = %#v", comparison)
	}
}

func TestPublicationCoverageBelowBaselineIsRejected(t *testing.T) {
	cases := []EvalCase{
		scoreTestE2ECase("ja-en.1", "ja", "en", "原文1", []string{"source one"}),
		scoreTestE2ECase("ja-en.2", "ja", "en", "原文2", []string{"source two"}),
	}
	baseline, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", cases, []EvaluationOutput{
		scoreTestE2EOutput("ja-en.1", "原文1", "source one", true), scoreTestE2EOutput("ja-en.2", "原文2", "source two", true),
	}, "same-manifest", "baseline")
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", cases, []EvaluationOutput{
		scoreTestE2EOutput("ja-en.1", "原文1", "source one", true), scoreTestE2EOutput("ja-en.2", "原文2", "source two", false),
	}, "same-manifest", "candidate")
	if err != nil {
		t.Fatal(err)
	}
	comparison := ComparePublicationCoverage(baseline, candidate)
	if comparison.Status != CoverageStatusRejected || !containsString(comparison.Findings, "TOTAL_COVERAGE_REGRESSION") {
		t.Fatalf("coverage gate = %#v", comparison)
	}
}

func TestEmptyPublishedTranslationDoesNotCountAsPublicationCoverage(t *testing.T) {
	cases := []EvalCase{scoreTestE2ECase("ja-en.blank", "ja", "en", "原文", []string{"source sentence"})}
	baseline, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", cases, []EvaluationOutput{
		scoreTestE2EOutput("ja-en.blank", "原文", "source sentence", true),
	}, "same-manifest", "baseline")
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", cases, []EvaluationOutput{
		scoreTestE2EOutput("ja-en.blank", "原文", "", true),
	}, "same-manifest", "candidate")
	if err != nil {
		t.Fatal(err)
	}
	if candidate.E2EByDirection["ja->en"].Published != 0 || candidate.E2EByDirection["ja->en"].Omitted != 1 {
		t.Fatalf("empty translation coverage = %#v; want published=0 omitted=1", candidate.E2EByDirection["ja->en"])
	}
	comparison := ComparePublicationCoverage(baseline, candidate)
	if comparison.Status != CoverageStatusRejected || !containsString(comparison.Findings, "ALL_CAPTIONS_HELD") {
		t.Fatalf("coverage comparison = %#v; empty translation must not pass", comparison)
	}
}

func TestScoreRequiresExactCaseCoverageWithoutMissingDuplicateOrUnknownCases(t *testing.T) {
	cases := []EvalCase{scoreTestASRCase("asr.one", "en", "one two")}
	valid := scoreTestASROutput("asr.one", "one two")
	tests := []struct {
		name    string
		outputs []EvaluationOutput
		want    string
	}{
		{name: "missing", outputs: nil, want: "missing case"},
		{name: "duplicate", outputs: []EvaluationOutput{valid, valid}, want: "duplicate output"},
		{name: "unknown", outputs: []EvaluationOutput{scoreTestASROutput("asr.unknown", "text")}, want: "unknown case"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := ScoreEvaluationTrack(TrackASROnly, "contract", cases, testCase.outputs, "manifest", "outputs")
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error = %v; want text %q", err, testCase.want)
			}
		})
	}
}

func TestScoreRejectsUnexpectedFieldsAndIncompleteCriticalAssertionResults(t *testing.T) {
	assertionCase := scoreTestE2ECase("e2e.assertion", "en", "ja", "hello", []string{"こんにちは"}, "meaning preserved")
	_, err := ScoreEvaluationTrack(TrackEndToEnd, "contract", []EvalCase{assertionCase},
		[]EvaluationOutput{scoreTestE2EOutput("e2e.assertion", "hello", "こんにちは", true)}, "manifest", "outputs")
	if err == nil || !strings.Contains(err.Error(), "critical assertion results do not match") {
		t.Fatalf("incomplete assertion result error = %v", err)
	}
	_, err = ScoreEvaluationTrack(TrackASROnly, "contract", []EvalCase{scoreTestASRCase("asr.fields", "en", "hello")},
		[]EvaluationOutput{{CaseID: "asr.fields", Split: "contract", ASRText: scoreTestString("hello"), TranslationText: scoreTestString("unexpected")}}, "manifest", "outputs")
	if err == nil || !strings.Contains(err.Error(), "asr-only output must contain only asrText") {
		t.Fatalf("unexpected field error = %v", err)
	}
}

func TestDecodeEvaluationOutputsRejectsUnknownFieldsAndMultipleObjects(t *testing.T) {
	for _, input := range []string{
		`{"caseId":"x","split":"contract","asrText":"ok","unexpected":true}`,
		"{\"caseId\":\"x\",\"split\":\"contract\",\"asrText\":\"ok\"} {\"caseId\":\"y\",\"split\":\"contract\",\"asrText\":\"ok\"}",
	} {
		if _, err := decodeEvaluationOutputs(strings.NewReader(input)); err == nil {
			t.Fatalf("decodeEvaluationOutputs(%q) unexpectedly succeeded", input)
		}
	}
}

func TestEmptyReferenceDoesNotInventZeroErrorRate(t *testing.T) {
	caseItem := scoreTestASRCase("asr.no-speech", "ja", "")
	report, err := ScoreEvaluationTrack(TrackASROnly, "contract", []EvalCase{caseItem},
		[]EvaluationOutput{scoreTestASROutput("asr.no-speech", "hallucinated speech")}, "manifest", "outputs")
	if err != nil {
		t.Fatal(err)
	}
	if report.ASRByLanguage["ja"].ErrorRate != nil {
		t.Fatalf("empty-reference CER must be not-applicable, got %v", *report.ASRByLanguage["ja"].ErrorRate)
	}
	if report.NonSpeechFalseOutputs != 1 {
		t.Fatalf("false outputs = %d; want 1", report.NonSpeechFalseOutputs)
	}
}

func TestScoreReportNeverClaimsProductQualityEvidence(t *testing.T) {
	caseItem := scoreTestASRCase("asr.synthetic", "en", "hello")
	report, err := ScoreEvaluationTrack(TrackASROnly, "contract", []EvalCase{caseItem},
		[]EvaluationOutput{scoreTestASROutput("asr.synthetic", "hello")}, "manifest", "outputs")
	if err != nil {
		t.Fatal(err)
	}
	if report.QualityEvidence || report.ProductStatus != "not-evaluated" || report.Mode != "score-only-untrusted" {
		t.Fatalf("score report overstates evidence: %#v", report)
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
