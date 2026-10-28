package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func qualificationFloat(value float64) *float64 { return &value }
func qualificationInt(value int) *int           { return &value }
func qualificationBool(value bool) *bool        { return &value }

func validQualificationReport() QualificationReport {
	return QualificationReport{
		SchemaVersion: 1,
		RunID:         "m1-run-2026-09-29-01",
		Mode:          "m1-real-google-meet-integration",
		TestDouble:    qualificationBool(false),
		ProfileID:     "m1-max-balanced",
		Hardware: QualificationHardware{
			Chip: "Apple M1 Max", UnifiedMemoryGiB: 32, GPUCores: 24,
			Architecture: "arm64", OSVersion: "26.6.2",
		},
		Browser: QualificationBrowser{Name: "Microsoft Edge", Version: "154.0.4258.37"},
		Baseline: QualificationBaseline{
			ASR:         validQualificationModelPin("baseline-asr", "whisper.cpp", "metal"),
			Translation: validQualificationModelPin("baseline-mt", "llama.cpp", "metal"),
		},
		Candidate: QualificationCandidate{
			ASR:                                validQualificationModelPin("asr-candidate", "whisper.cpp", "metal"),
			Translation:                        validQualificationModelPin("mt-candidate", "llama.cpp", "metal"),
			VAD:                                QualificationVAD{Kind: "energy", Version: "energy-v1"},
			WeightsAuthorized:                  true,
			WeightTermsReviewed:                true,
			PublishedMTBenchmarkScreenPassed:   true,
			PublishedMTBenchmarkScreenID:       "CAT-Translate-1.4B",
			PublishedMTBenchmarkCandidateID:    "mt-candidate",
			PublishedMTBenchmarkEvidenceSHA256: strings.Repeat("9", 64),
			HeavyInferenceConcurrency:          1,
			LoadedASRModels:                    1,
			LoadedTranslationModels:            1,
			LocalInferenceOnly:                 true,
			ExternalModelRequests:              0,
			AdditionalRelay:                    false,
		},
		Dataset: QualificationDataset{
			ASRDevelopmentManifestSHA256: strings.Repeat("a", 64),
			ASRHoldoutManifestSHA256:     strings.Repeat("b", 64),
			ASRHoldoutAudioSHA256:        strings.Repeat("c", 64),
			MTDevelopmentManifestSHA256:  strings.Repeat("d", 64),
			MTHoldoutManifestSHA256:      strings.Repeat("e", 64),
			E2EDevelopmentManifestSHA256: strings.Repeat("f", 64),
			E2EHoldoutManifestSHA256:     strings.Repeat("1", 64),
			E2EHoldoutAudioSHA256:        strings.Repeat("2", 64),
			Authorized:                   true,
			LicenseReviewed:              true,
			HumanReviewed:                true,
			MeetingAudioConsented:        true,
			SplitIsolationVerified:       true,
			Synthetic:                    qualificationBool(false),
			ASRHoldoutCases:              40,
			ASRJapaneseHoldoutCases:      20,
			ASREnglishHoldoutCases:       20,
			MTHoldoutJapaneseToEnglish:   60,
			MTHoldoutEnglishToJapanese:   60,
			MTCriticalJapaneseToEnglish:  20,
			MTCriticalEnglishToJapanese:  20,
			E2EHoldoutCases:              40,
			E2EJapaneseToEnglishCases:    20,
			E2EEnglishToJapaneseCases:    20,
			NoSpeechHoldoutCases:         5,
			ShortNegationHoldoutCases:    10,
			NumberHoldoutCases:           10,
		},
		Integration: QualificationIntegration{
			GoogleMeetObserved:                     true,
			ConsentedTestRoom:                      true,
			ParticipantDevices:                     4,
			CaptionTabActuallyShared:               true,
			PrivateCorrectionPanelOpen:             true,
			MicrophoneAndTabCaptureExercised:       true,
			CorrectionUndoAndGlossaryExercised:     true,
			PrivateDraftNeverShared:                true,
			PublicationApprovalFlowExercised:       true,
			PublicationRequiredExplicitApproval:    true,
			MeetChatSideEffects:                    0,
			MediaRegressionComparedAndAcceptable:   true,
			ExtensionLifecycleStopAndRestartPassed: true,
		},
		BaselineQuality:           validQualificationQuality(),
		CandidateQuality:          validQualificationQuality(),
		BaselineConditionsSHA256:  strings.Repeat("7", 64),
		CandidateConditionsSHA256: strings.Repeat("7", 64),
		Performance: QualificationPerformance{
			MeasuredMinutes:                      qualificationFloat(60),
			WarmupMinutes:                        qualificationFloat(2),
			InferenceSteadyP95GiB:                qualificationFloat(7.9),
			InferencePeakGiB:                     qualificationFloat(9.9),
			BrowserAddedMemoryMiB:                qualificationFloat(500),
			ASRRealTimeFactorP95:                 qualificationFloat(0.49),
			EndSpeechToSourceP95Seconds:          qualificationFloat(1.9),
			EndSpeechToTranslationP95Seconds:     qualificationFloat(2.9),
			CorrectionInteractionP95Milliseconds: qualificationFloat(99),
			Crashes:                              qualificationInt(0),
			OOMs:                                 qualificationInt(0),
			OverloadAudioDrops:                   qualificationInt(0),
			QueueGrowthObserved:                  qualificationBool(false),
			CriticalMemoryPressureObserved:       qualificationBool(false),
			ACConnected:                          qualificationBool(true),
			LowPowerModeEnabled:                  qualificationBool(false),
			AcceleratorExecutionVerified:         qualificationBool(true),
			ProcessGroupMeasurementComplete:      qualificationBool(true),
		},
		Rollback: QualificationRollback{
			BaselineConfigSHA256:          strings.Repeat("8", 64),
			CandidateStoppedAndReleased:   true,
			BaselineRestoredAndVerified:   true,
			StaleCandidateResultsRejected: true,
		},
	}
}

func validQualificationModelPin(candidateID, runtimeID, backend string) QualificationModelPin {
	return QualificationModelPin{
		CandidateID:           candidateID,
		ModelRevision:         strings.Repeat("1", 40),
		ArtifactSHA256:        strings.Repeat("2", 64),
		RuntimeID:             runtimeID,
		RuntimeRevision:       strings.Repeat("3", 40),
		Quantization:          "Q4_K_M",
		TemplateSHA256:        strings.Repeat("4", 64),
		DecodeOptionsSHA256:   strings.Repeat("5", 64),
		GatePolicyID:          "manual-review-v1",
		GateCalibrationSHA256: strings.Repeat("6", 64),
		Backend:               backend,
		ExecutionVerified:     true,
	}
}

func validQualificationQuality() QualificationQuality {
	return QualificationQuality{
		ASRDatasetSHA256:                     strings.Repeat("b", 64),
		MTDatasetSHA256:                      strings.Repeat("e", 64),
		E2EDatasetSHA256:                     strings.Repeat("1", 64),
		ASRJapaneseCER:                       qualificationFloat(0.08),
		ASREnglishWER:                        qualificationFloat(0.15),
		PublishedJapaneseCER:                 qualificationFloat(0.08),
		PublishedEnglishWER:                  qualificationFloat(0.15),
		JapaneseToEnglishChrF2:               qualificationFloat(0.50),
		EnglishToJapaneseChrF2:               qualificationFloat(0.50),
		ShortNegationRecall:                  qualificationFloat(0.95),
		NumberRecall:                         qualificationFloat(0.96),
		NonSpeechFalsePublications:           qualificationInt(0),
		MTCriticalTranslationFailures:        qualificationInt(0),
		MTCriticalTranslationFailureCaseIDs:  []string{},
		E2ECriticalTranslationFailures:       qualificationInt(0),
		E2ECriticalTranslationFailureCaseIDs: []string{},
		MajorTranslationErrors:               qualificationInt(1),
		TerminologyErrors:                    qualificationInt(1),
		TranslationFailures:                  qualificationInt(1),
		ASRScoredCases:                       40,
		ASRJapaneseScoredCases:               qualificationInt(20),
		ASREnglishScoredCases:                qualificationInt(20),
		MTScoredCases:                        120,
		MTJapaneseToEnglishScoredCases:       qualificationInt(60),
		MTEnglishToJapaneseScoredCases:       qualificationInt(60),
		E2EScoredCases:                       40,
		PublishedScoredCases:                 qualificationInt(40),
		PublishedVisibleCases:                qualificationInt(36),
		PublishedOmittedCases:                qualificationInt(4),
		PublishedOmissionsCountedAsDeletions: qualificationBool(true),
		PublishedJapaneseToEnglishCoverage: QualificationCaptionCoverage{
			ScoredCases: qualificationInt(20), VisibleCases: qualificationInt(18), OmittedCases: qualificationInt(2),
		},
		PublishedEnglishToJapaneseCoverage: QualificationCaptionCoverage{
			ScoredCases: qualificationInt(20), VisibleCases: qualificationInt(18), OmittedCases: qualificationInt(2),
		},
		ManualCriticalReviewComplete: true,
	}
}

func TestRunQualificationCheckKeepsCallerAuthoredReportNonQualifying(t *testing.T) {
	encoded, err := json.Marshal(validQualificationReport())
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	assessment, err := runQualificationCheck(bytes.NewReader(encoded), &output)
	if err != nil {
		t.Fatal(err)
	}
	if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "TRUSTED_PROVENANCE_UNAVAILABLE") {
		t.Fatalf("assessment = %#v; caller-authored evidence must not qualify", assessment)
	}
}

func TestAssessQualificationBlocksSyntheticOrTestDoubleEvidence(t *testing.T) {
	report := validQualificationReport()
	report.TestDouble = qualificationBool(true)
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "TEST_DOUBLE_EVIDENCE") {
		t.Fatalf("assessment = %#v; synthetic evidence must be blocked", assessment)
	}
}

func TestAssessQualificationBlocksSyntheticDatasetEvenWithoutTestDouble(t *testing.T) {
	report := validQualificationReport()
	report.Dataset.Synthetic = qualificationBool(true)
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "SYNTHETIC_DATASET_EVIDENCE") {
		t.Fatalf("assessment = %#v; synthetic data must not qualify", assessment)
	}
}

func TestRunQualificationCheckBlocksMissingNegativeAttestations(t *testing.T) {
	for _, test := range []struct {
		name       string
		field      string
		finding    string
		nestedData bool
	}{
		{name: "testDouble", field: "testDouble", finding: "TEST_DOUBLE_ATTESTATION_MISSING"},
		{name: "synthetic", field: "synthetic", finding: "SYNTHETIC_DATA_ATTESTATION_MISSING", nestedData: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(validQualificationReport())
			if err != nil {
				t.Fatal(err)
			}
			var object map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &object); err != nil {
				t.Fatal(err)
			}
			if test.nestedData {
				var dataset map[string]json.RawMessage
				if err := json.Unmarshal(object["dataset"], &dataset); err != nil {
					t.Fatal(err)
				}
				delete(dataset, test.field)
				object["dataset"], err = json.Marshal(dataset)
				if err != nil {
					t.Fatal(err)
				}
			} else {
				delete(object, test.field)
			}
			encoded, err = json.Marshal(object)
			if err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			assessment, err := runQualificationCheck(bytes.NewReader(encoded), &output)
			if err != nil {
				t.Fatal(err)
			}
			if assessment.Status == QualificationStatusQualified || !hasQualificationFinding(assessment, test.finding) {
				t.Fatalf("assessment = %#v; omitted %s attestation must block", assessment, test.field)
			}
		})
	}
}

func TestAssessQualificationRejectsAllCaptionsWithheld(t *testing.T) {
	report := validQualificationReport()
	report.CandidateQuality.PublishedVisibleCases = qualificationInt(0)
	report.CandidateQuality.PublishedOmittedCases = qualificationInt(40)
	report.CandidateQuality.PublishedJapaneseToEnglishCoverage.VisibleCases = qualificationInt(0)
	report.CandidateQuality.PublishedJapaneseToEnglishCoverage.OmittedCases = qualificationInt(20)
	report.CandidateQuality.PublishedEnglishToJapaneseCoverage.VisibleCases = qualificationInt(0)
	report.CandidateQuality.PublishedEnglishToJapaneseCoverage.OmittedCases = qualificationInt(20)
	report.CandidateQuality.PublishedJapaneseCER = qualificationFloat(0)
	report.CandidateQuality.PublishedEnglishWER = qualificationFloat(0)
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusRejected || !hasQualificationFinding(assessment, "ALL_CAPTIONS_WITHHELD") {
		t.Fatalf("assessment = %#v; all-hold candidate must be rejected", assessment)
	}
}

func TestAssessQualificationRejectsMassCaptionWithholding(t *testing.T) {
	report := validQualificationReport()
	report.BaselineQuality.PublishedVisibleCases = qualificationInt(38)
	report.BaselineQuality.PublishedOmittedCases = qualificationInt(2)
	report.BaselineQuality.PublishedJapaneseToEnglishCoverage.VisibleCases = qualificationInt(19)
	report.BaselineQuality.PublishedJapaneseToEnglishCoverage.OmittedCases = qualificationInt(1)
	report.BaselineQuality.PublishedEnglishToJapaneseCoverage.VisibleCases = qualificationInt(19)
	report.BaselineQuality.PublishedEnglishToJapaneseCoverage.OmittedCases = qualificationInt(1)
	report.CandidateQuality.PublishedVisibleCases = qualificationInt(10)
	report.CandidateQuality.PublishedOmittedCases = qualificationInt(30)
	report.CandidateQuality.PublishedJapaneseToEnglishCoverage.VisibleCases = qualificationInt(5)
	report.CandidateQuality.PublishedJapaneseToEnglishCoverage.OmittedCases = qualificationInt(15)
	report.CandidateQuality.PublishedEnglishToJapaneseCoverage.VisibleCases = qualificationInt(5)
	report.CandidateQuality.PublishedEnglishToJapaneseCoverage.OmittedCases = qualificationInt(15)
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusRejected || !hasQualificationFinding(assessment, "PUBLICATION_COVERAGE_REGRESSION") {
		t.Fatalf("assessment = %#v; mass withholding must not improve published-caption metrics", assessment)
	}
}

func TestAssessQualificationRejectsDirectionSpecificCaptionWithholding(t *testing.T) {
	report := validQualificationReport()
	report.BaselineQuality.PublishedVisibleCases = qualificationInt(28)
	report.BaselineQuality.PublishedOmittedCases = qualificationInt(12)
	report.BaselineQuality.PublishedJapaneseToEnglishCoverage.VisibleCases = qualificationInt(18)
	report.BaselineQuality.PublishedJapaneseToEnglishCoverage.OmittedCases = qualificationInt(2)
	report.BaselineQuality.PublishedEnglishToJapaneseCoverage.VisibleCases = qualificationInt(10)
	report.BaselineQuality.PublishedEnglishToJapaneseCoverage.OmittedCases = qualificationInt(10)
	report.CandidateQuality.PublishedVisibleCases = qualificationInt(28)
	report.CandidateQuality.PublishedOmittedCases = qualificationInt(12)
	report.CandidateQuality.PublishedJapaneseToEnglishCoverage.VisibleCases = qualificationInt(10)
	report.CandidateQuality.PublishedJapaneseToEnglishCoverage.OmittedCases = qualificationInt(10)
	report.CandidateQuality.PublishedEnglishToJapaneseCoverage.VisibleCases = qualificationInt(18)
	report.CandidateQuality.PublishedEnglishToJapaneseCoverage.OmittedCases = qualificationInt(2)
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusRejected || !hasQualificationFinding(assessment, "PUBLICATION_COVERAGE_REGRESSION") {
		t.Fatalf("assessment = %#v; direction-specific withholding must not hide behind unchanged total coverage", assessment)
	}
}

func TestAssessQualificationBlocksUnscoredPublishedCases(t *testing.T) {
	report := validQualificationReport()
	report.CandidateQuality.PublishedJapaneseToEnglishCoverage.ScoredCases = qualificationInt(19)
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "PUBLISHED_CASES_UNSCORED") {
		t.Fatalf("assessment = %#v; every case in each direction must be accounted for", assessment)
	}
}

func TestAssessQualificationRequiresPerLanguageASRAndPerDirectionMTCoverage(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*QualificationQuality)
	}{
		{
			name: "ASR language subset with unchanged aggregate",
			mutate: func(quality *QualificationQuality) {
				quality.ASRJapaneseScoredCases = qualificationInt(19)
				quality.ASREnglishScoredCases = qualificationInt(21)
			},
		},
		{
			name: "MT direction subset with unchanged aggregate",
			mutate: func(quality *QualificationQuality) {
				quality.MTJapaneseToEnglishScoredCases = qualificationInt(59)
				quality.MTEnglishToJapaneseScoredCases = qualificationInt(61)
			},
		},
		{
			name: "missing ASR split count",
			mutate: func(quality *QualificationQuality) {
				quality.ASRJapaneseScoredCases = nil
			},
		},
		{
			name: "missing MT split count",
			mutate: func(quality *QualificationQuality) {
				quality.MTEnglishToJapaneseScoredCases = nil
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			report := validQualificationReport()
			test.mutate(&report.CandidateQuality)
			assessment := AssessQualification(report)
			if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "QUALITY_CASES_UNSCORED") {
				t.Fatalf("assessment = %#v; every language/direction must match its pinned split", assessment)
			}
		})
	}
}

func TestAssessQualificationRequiresImmutableRuntimeRevision(t *testing.T) {
	for _, revision := range []string{"nightly", "develop", "main", "v0.31.3"} {
		t.Run(revision, func(t *testing.T) {
			report := validQualificationReport()
			report.Candidate.ASR.RuntimeRevision = revision
			assessment := AssessQualification(report)
			if assessment.Status == QualificationStatusQualified || !hasQualificationFinding(assessment, "MODEL_PIN_INCOMPLETE") {
				t.Fatalf("assessment = %#v; runtime revision %q must not qualify", assessment, revision)
			}
		})
	}
}

func TestAssessQualificationRequiresPublishedTranslationBenchmarkScreen(t *testing.T) {
	t.Run("screen missing", func(t *testing.T) {
		report := validQualificationReport()
		report.Candidate.PublishedMTBenchmarkScreenPassed = false
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "MT_BENCHMARK_SCREEN_INCOMPLETE") {
			t.Fatalf("assessment = %#v; unscreened translation candidate must be blocked", assessment)
		}
	})
	t.Run("screen identity missing", func(t *testing.T) {
		report := validQualificationReport()
		report.Candidate.PublishedMTBenchmarkScreenID = ""
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "MT_BENCHMARK_SCREEN_INCOMPLETE") {
			t.Fatalf("assessment = %#v; screen evidence must be identifiable", assessment)
		}
	})
	t.Run("evidence hash missing", func(t *testing.T) {
		report := validQualificationReport()
		report.Candidate.PublishedMTBenchmarkEvidenceSHA256 = ""
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "MT_BENCHMARK_SCREEN_INCOMPLETE") {
			t.Fatalf("assessment = %#v; screen evidence must be content-pinned", assessment)
		}
	})
}

func TestAssessQualificationRejectsCaseLevelCriticalTranslationRegression(t *testing.T) {
	report := validQualificationReport()
	report.BaselineQuality.MTCriticalTranslationFailures = qualificationInt(1)
	report.BaselineQuality.MTCriticalTranslationFailureCaseIDs = []string{"case-a"}
	report.CandidateQuality.MTCriticalTranslationFailures = qualificationInt(1)
	report.CandidateQuality.MTCriticalTranslationFailureCaseIDs = []string{"case-b"}
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusRejected || !hasQualificationFinding(assessment, "CRITICAL_TRANSLATION_REGRESSION") {
		t.Fatalf("assessment = %#v; a new critical case must fail even when counts match", assessment)
	}
}

func TestAssessQualificationBlocksCriticalFailureCountMismatch(t *testing.T) {
	report := validQualificationReport()
	report.CandidateQuality.MTCriticalTranslationFailures = qualificationInt(1)
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "QUALITY_METRICS_INCOMPLETE") {
		t.Fatalf("assessment = %#v; critical case IDs must account for the reported count", assessment)
	}
}

func TestAssessQualificationRequiresTrackSpecificQualityEvidence(t *testing.T) {
	report := validQualificationReport()
	report.CandidateQuality.MTDatasetSHA256 = report.Dataset.E2EHoldoutManifestSHA256
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "QUALITY_DATASET_MISMATCH") {
		t.Fatalf("assessment = %#v; MT-only scores must use the correct-source MT holdout", assessment)
	}
}

func TestAssessQualificationRejectsNewEndToEndCriticalCase(t *testing.T) {
	report := validQualificationReport()
	report.BaselineQuality.E2ECriticalTranslationFailures = qualificationInt(1)
	report.BaselineQuality.E2ECriticalTranslationFailureCaseIDs = []string{"e2e-case-a"}
	report.CandidateQuality.E2ECriticalTranslationFailures = qualificationInt(1)
	report.CandidateQuality.E2ECriticalTranslationFailureCaseIDs = []string{"e2e-case-b"}
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusRejected || !hasQualificationFinding(assessment, "CRITICAL_TRANSLATION_REGRESSION") {
		t.Fatalf("assessment = %#v; a new E2E critical error must fail even if the count is unchanged", assessment)
	}
}

func TestAssessQualificationAllowsAlternativeAcceleratorBackends(t *testing.T) {
	for _, backend := range []string{"coreml", "mlx"} {
		t.Run(backend, func(t *testing.T) {
			report := validQualificationReport()
			report.Baseline.ASR.Backend = backend
			report.Baseline.Translation.Backend = backend
			report.Candidate.ASR.Backend = backend
			report.Candidate.Translation.Backend = backend
			assessment := AssessQualification(report)
			if assessment.Status != QualificationStatusBlocked || hasQualificationFinding(assessment, "MODEL_PIN_INCOMPLETE") || !hasQualificationFinding(assessment, "TRUSTED_PROVENANCE_UNAVAILABLE") {
				t.Fatalf("assessment = %#v; %s is allowed but report-only evidence remains blocked", assessment, backend)
			}
		})
	}
}

func TestAssessQualificationFindingsAreDeterministic(t *testing.T) {
	report := validQualificationReport()
	report.CandidateQuality.ASRJapaneseCER = nil
	report.CandidateQuality.PublishedJapaneseCER = nil
	report.CandidateQuality.MTCriticalTranslationFailures = nil
	report.Performance.InferencePeakGiB = nil
	first, err := json.Marshal(AssessQualification(report))
	if err != nil {
		t.Fatal(err)
	}
	for run := 0; run < 50; run++ {
		current, err := json.Marshal(AssessQualification(report))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(first, current) {
			t.Fatalf("assessment changed between identical runs:\nfirst:   %s\ncurrent: %s", first, current)
		}
	}
}

func TestAssessQualificationUsesPublishedCaptionMetricsForPublicQualityGate(t *testing.T) {
	report := validQualificationReport()
	report.BaselineQuality.ASRJapaneseCER = qualificationFloat(0.08)
	report.CandidateQuality.ASRJapaneseCER = qualificationFloat(0.50)
	report.BaselineQuality.PublishedJapaneseCER = qualificationFloat(0.08)
	report.CandidateQuality.PublishedJapaneseCER = qualificationFloat(0.091)
	assessment := AssessQualification(report)
	if assessment.Status != QualificationStatusRejected || !hasQualificationFinding(assessment, "ASR_QUALITY_REGRESSION") {
		t.Fatalf("assessment = %#v; published-caption regression must fail even when raw ASR metrics do not", assessment)
	}
}

func TestAssessQualificationRequiresExactLanguageCaseTotals(t *testing.T) {
	t.Run("ASR", func(t *testing.T) {
		report := validQualificationReport()
		report.Dataset.ASREnglishHoldoutCases = 19
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "INSUFFICIENT_ASR_HOLDOUT") {
			t.Fatalf("assessment = %#v; every ASR holdout case must have a language label", assessment)
		}
	})
	t.Run("end-to-end", func(t *testing.T) {
		report := validQualificationReport()
		report.Dataset.E2EEnglishToJapaneseCases = 19
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "INSUFFICIENT_E2E_HOLDOUT") {
			t.Fatalf("assessment = %#v; every E2E holdout case must have a direction", assessment)
		}
	})
}

func TestAssessQualificationRejectsFloatingModelRevisionAndBlocksMissingGatePin(t *testing.T) {
	t.Run("floating model revision", func(t *testing.T) {
		report := validQualificationReport()
		report.Candidate.ASR.ModelRevision = "main"
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "MODEL_PIN_INCOMPLETE") {
			t.Fatalf("assessment = %#v; model revisions must be immutable", assessment)
		}
	})
	t.Run("missing calibration hash", func(t *testing.T) {
		report := validQualificationReport()
		report.Candidate.Translation.GateCalibrationSHA256 = ""
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "MODEL_PIN_INCOMPLETE") {
			t.Fatalf("assessment = %#v; publication gate calibration must be pinned", assessment)
		}
	})
}

func TestAssessQualificationBlocksMissingDataOrRealMeetEvidence(t *testing.T) {
	t.Run("insufficient holdout", func(t *testing.T) {
		report := validQualificationReport()
		report.Dataset.MTHoldoutJapaneseToEnglish = 59
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "INSUFFICIENT_MT_HOLDOUT") {
			t.Fatalf("assessment = %#v; missing required holdout must be blocked", assessment)
		}
	})

	t.Run("no real Meet", func(t *testing.T) {
		report := validQualificationReport()
		report.Integration.GoogleMeetObserved = false
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "REAL_MEET_NOT_VERIFIED") {
			t.Fatalf("assessment = %#v; synthetic browser fixture must not qualify", assessment)
		}
	})
}

func TestAssessQualificationRejectsPerformanceAndQualityRegressions(t *testing.T) {
	t.Run("peak memory", func(t *testing.T) {
		report := validQualificationReport()
		report.Performance.InferencePeakGiB = qualificationFloat(10.01)
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusRejected || !hasQualificationFinding(assessment, "INFERENCE_PEAK_EXCEEDED") {
			t.Fatalf("assessment = %#v; memory limit breach must be rejected", assessment)
		}
	})

	t.Run("ASR quality", func(t *testing.T) {
		report := validQualificationReport()
		report.CandidateQuality.PublishedJapaneseCER = qualificationFloat(0.091)
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusRejected || !hasQualificationFinding(assessment, "ASR_QUALITY_REGRESSION") {
			t.Fatalf("assessment = %#v; >1 pp ASR regression must be rejected", assessment)
		}
	})

	t.Run("new critical translation failure", func(t *testing.T) {
		report := validQualificationReport()
		report.CandidateQuality.MTCriticalTranslationFailures = qualificationInt(1)
		report.CandidateQuality.MTCriticalTranslationFailureCaseIDs = []string{"case-new"}
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusRejected || !hasQualificationFinding(assessment, "CRITICAL_TRANSLATION_REGRESSION") {
			t.Fatalf("assessment = %#v; new critical failure must be rejected", assessment)
		}
	})

	t.Run("new silence publication", func(t *testing.T) {
		report := validQualificationReport()
		report.CandidateQuality.NonSpeechFalsePublications = qualificationInt(1)
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusRejected || !hasQualificationFinding(assessment, "NON_SPEECH_PUBLICATION_REGRESSION") {
			t.Fatalf("assessment = %#v; new non-speech publication must be rejected", assessment)
		}
	})
}

func TestAssessQualificationBlocksUnpinnedOrUnrestorableCandidates(t *testing.T) {
	t.Run("missing artifact hash", func(t *testing.T) {
		report := validQualificationReport()
		report.Candidate.Translation.ArtifactSHA256 = ""
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "MODEL_PIN_INCOMPLETE") {
			t.Fatalf("assessment = %#v; missing artifact hash must be blocked", assessment)
		}
	})

	t.Run("rollback not verified", func(t *testing.T) {
		report := validQualificationReport()
		report.Rollback.BaselineRestoredAndVerified = false
		assessment := AssessQualification(report)
		if assessment.Status != QualificationStatusBlocked || !hasQualificationFinding(assessment, "ROLLBACK_NOT_VERIFIED") {
			t.Fatalf("assessment = %#v; unverified recovery must be blocked", assessment)
		}
	})
}

func TestRunQualificationCheckEmitsMachineReadableStatus(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*QualificationReport)
		wantStatus QualificationStatus
		wantExit   int
	}{
		{name: "complete but caller-authored", wantStatus: QualificationStatusBlocked, wantExit: 2},
		{name: "blocked test double", mutate: func(report *QualificationReport) { report.TestDouble = qualificationBool(true) }, wantStatus: QualificationStatusBlocked, wantExit: 2},
		{name: "rejected latency", mutate: func(report *QualificationReport) {
			report.Performance.EndSpeechToTranslationP95Seconds = qualificationFloat(3.1)
		}, wantStatus: QualificationStatusRejected, wantExit: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			report := validQualificationReport()
			if test.mutate != nil {
				test.mutate(&report)
			}
			input, err := json.Marshal(report)
			if err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			assessment, err := runQualificationCheck(bytes.NewReader(input), &output)
			if err != nil {
				t.Fatalf("runQualificationCheck() error = %v", err)
			}
			if assessment.Status != test.wantStatus || qualificationExitCode(assessment.Status) != test.wantExit {
				t.Fatalf("assessment = %#v, exit = %d; want %s / %d", assessment, qualificationExitCode(assessment.Status), test.wantStatus, test.wantExit)
			}
			var printed QualificationAssessment
			if err := json.Unmarshal(output.Bytes(), &printed); err != nil {
				t.Fatalf("decode CLI report: %v", err)
			}
			if printed.Status != test.wantStatus {
				t.Fatalf("printed status = %q, want %q", printed.Status, test.wantStatus)
			}
		})
	}
}

func TestRunQualificationCheckRejectsUnknownAndTrailingJSON(t *testing.T) {
	for name, input := range map[string]string{
		"unknown fields":  `{"schemaVersion":1,"unreviewedOverride":true}`,
		"trailing object": `{"schemaVersion":1} {"schemaVersion":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := runQualificationCheck(strings.NewReader(input), &bytes.Buffer{}); err == nil {
				t.Fatal("runQualificationCheck() accepted malformed or unrecognized evidence")
			}
		})
	}
}

func TestRunQualificationCheckBlocksEmptyEvidenceReport(t *testing.T) {
	var output bytes.Buffer
	assessment, err := runQualificationCheck(strings.NewReader(`{}`), &output)
	if err != nil {
		t.Fatalf("runQualificationCheck() error = %v", err)
	}
	if assessment.Status != QualificationStatusBlocked || qualificationExitCode(assessment.Status) != 2 {
		t.Fatalf("assessment = %#v; empty evidence must be blocked", assessment)
	}
	if !bytes.Contains(output.Bytes(), []byte(`"status": "BLOCKED"`)) {
		t.Fatalf("output = %s; want BLOCKED machine-readable status", output.Bytes())
	}
}

func hasQualificationFinding(assessment QualificationAssessment, code string) bool {
	for _, finding := range assessment.Findings {
		if finding.Code == code {
			return true
		}
	}
	return false
}
