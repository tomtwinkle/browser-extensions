package main

import (
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
)

type QualificationStatus string

const (
	QualificationStatusQualified QualificationStatus = "QUALIFIED"
	QualificationStatusBlocked   QualificationStatus = "BLOCKED"
	QualificationStatusRejected  QualificationStatus = "REJECTED"
)

type QualificationFinding struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
	Kind   string `json:"kind"`
}

type QualificationAssessment struct {
	Status   QualificationStatus    `json:"status"`
	Findings []QualificationFinding `json:"findings"`
}

type QualificationReport struct {
	SchemaVersion             int                      `json:"schemaVersion"`
	RunID                     string                   `json:"runId"`
	Mode                      string                   `json:"mode"`
	TestDouble                *bool                    `json:"testDouble"`
	ProfileID                 string                   `json:"profileId"`
	Hardware                  QualificationHardware    `json:"hardware"`
	Browser                   QualificationBrowser     `json:"browser"`
	Baseline                  QualificationBaseline    `json:"baseline"`
	Candidate                 QualificationCandidate   `json:"candidate"`
	Dataset                   QualificationDataset     `json:"dataset"`
	Integration               QualificationIntegration `json:"integration"`
	BaselineQuality           QualificationQuality     `json:"baselineQuality"`
	CandidateQuality          QualificationQuality     `json:"candidateQuality"`
	BaselineConditionsSHA256  string                   `json:"baselineConditionsSHA256"`
	CandidateConditionsSHA256 string                   `json:"candidateConditionsSHA256"`
	Performance               QualificationPerformance `json:"performance"`
	Rollback                  QualificationRollback    `json:"rollback"`
}

type QualificationHardware struct {
	Chip             string `json:"chip"`
	UnifiedMemoryGiB int    `json:"unifiedMemoryGiB"`
	GPUCores         int    `json:"gpuCores"`
	Architecture     string `json:"architecture"`
	OSVersion        string `json:"osVersion"`
}

type QualificationBrowser struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type QualificationBaseline struct {
	ASR         QualificationModelPin `json:"asr"`
	Translation QualificationModelPin `json:"translation"`
}

type QualificationCandidate struct {
	ASR                                QualificationModelPin `json:"asr"`
	Translation                        QualificationModelPin `json:"translation"`
	VAD                                QualificationVAD      `json:"vad"`
	WeightsAuthorized                  bool                  `json:"weightsAuthorized"`
	WeightTermsReviewed                bool                  `json:"weightTermsReviewed"`
	PublishedMTBenchmarkScreenPassed   bool                  `json:"publishedMTBenchmarkScreenPassed"`
	PublishedMTBenchmarkScreenID       string                `json:"publishedMTBenchmarkScreenId"`
	PublishedMTBenchmarkCandidateID    string                `json:"publishedMTBenchmarkCandidateId"`
	PublishedMTBenchmarkEvidenceSHA256 string                `json:"publishedMTBenchmarkEvidenceSHA256"`
	HeavyInferenceConcurrency          int                   `json:"heavyInferenceConcurrency"`
	LoadedASRModels                    int                   `json:"loadedASRModels"`
	LoadedTranslationModels            int                   `json:"loadedTranslationModels"`
	LocalInferenceOnly                 bool                  `json:"localInferenceOnly"`
	ExternalModelRequests              int                   `json:"externalModelRequests"`
	AdditionalRelay                    bool                  `json:"additionalRelay"`
}

type QualificationModelPin struct {
	CandidateID           string `json:"candidateId"`
	ModelRevision         string `json:"modelRevision"`
	ArtifactSHA256        string `json:"artifactSHA256"`
	RuntimeID             string `json:"runtimeId"`
	RuntimeRevision       string `json:"runtimeRevision"`
	Quantization          string `json:"quantization"`
	TemplateSHA256        string `json:"templateSHA256"`
	DecodeOptionsSHA256   string `json:"decodeOptionsSHA256"`
	GatePolicyID          string `json:"gatePolicyId"`
	GateCalibrationSHA256 string `json:"gateCalibrationSHA256"`
	Backend               string `json:"backend"`
	ExecutionVerified     bool   `json:"executionVerified"`
}

type QualificationVAD struct {
	Kind           string `json:"kind"`
	Version        string `json:"version"`
	ArtifactSHA256 string `json:"artifactSHA256,omitempty"`
}

type QualificationDataset struct {
	ASRDevelopmentManifestSHA256 string `json:"asrDevelopmentManifestSHA256"`
	ASRHoldoutManifestSHA256     string `json:"asrHoldoutManifestSHA256"`
	ASRHoldoutAudioSHA256        string `json:"asrHoldoutAudioSHA256"`
	MTDevelopmentManifestSHA256  string `json:"mtDevelopmentManifestSHA256"`
	MTHoldoutManifestSHA256      string `json:"mtHoldoutManifestSHA256"`
	E2EDevelopmentManifestSHA256 string `json:"e2eDevelopmentManifestSHA256"`
	E2EHoldoutManifestSHA256     string `json:"e2eHoldoutManifestSHA256"`
	E2EHoldoutAudioSHA256        string `json:"e2eHoldoutAudioSHA256"`
	Authorized                   bool   `json:"authorized"`
	LicenseReviewed              bool   `json:"licenseReviewed"`
	HumanReviewed                bool   `json:"humanReviewed"`
	MeetingAudioConsented        bool   `json:"meetingAudioConsented"`
	SplitIsolationVerified       bool   `json:"splitIsolationVerified"`
	Synthetic                    *bool  `json:"synthetic"`
	ASRHoldoutCases              int    `json:"asrHoldoutCases"`
	ASRJapaneseHoldoutCases      int    `json:"asrJapaneseHoldoutCases"`
	ASREnglishHoldoutCases       int    `json:"asrEnglishHoldoutCases"`
	MTHoldoutJapaneseToEnglish   int    `json:"mtHoldoutJapaneseToEnglish"`
	MTHoldoutEnglishToJapanese   int    `json:"mtHoldoutEnglishToJapanese"`
	MTCriticalJapaneseToEnglish  int    `json:"mtCriticalJapaneseToEnglish"`
	MTCriticalEnglishToJapanese  int    `json:"mtCriticalEnglishToJapanese"`
	E2EHoldoutCases              int    `json:"e2eHoldoutCases"`
	E2EJapaneseToEnglishCases    int    `json:"e2eJapaneseToEnglishCases"`
	E2EEnglishToJapaneseCases    int    `json:"e2eEnglishToJapaneseCases"`
	NoSpeechHoldoutCases         int    `json:"noSpeechHoldoutCases"`
	ShortNegationHoldoutCases    int    `json:"shortNegationHoldoutCases"`
	NumberHoldoutCases           int    `json:"numberHoldoutCases"`
}

type QualificationIntegration struct {
	GoogleMeetObserved                     bool `json:"googleMeetObserved"`
	ConsentedTestRoom                      bool `json:"consentedTestRoom"`
	ParticipantDevices                     int  `json:"participantDevices"`
	CaptionTabActuallyShared               bool `json:"captionTabActuallyShared"`
	PrivateCorrectionPanelOpen             bool `json:"privateCorrectionPanelOpen"`
	MicrophoneAndTabCaptureExercised       bool `json:"microphoneAndTabCaptureExercised"`
	CorrectionUndoAndGlossaryExercised     bool `json:"correctionUndoAndGlossaryExercised"`
	PrivateDraftNeverShared                bool `json:"privateDraftNeverShared"`
	PublicationApprovalFlowExercised       bool `json:"publicationApprovalFlowExercised"`
	PublicationRequiredExplicitApproval    bool `json:"publicationRequiredExplicitApproval"`
	MeetChatSideEffects                    int  `json:"meetChatSideEffects"`
	MediaRegressionComparedAndAcceptable   bool `json:"mediaRegressionComparedAndAcceptable"`
	ExtensionLifecycleStopAndRestartPassed bool `json:"extensionLifecycleStopAndRestartPassed"`
}

type QualificationQuality struct {
	ASRDatasetSHA256                     string                       `json:"asrDatasetSHA256"`
	MTDatasetSHA256                      string                       `json:"mtDatasetSHA256"`
	E2EDatasetSHA256                     string                       `json:"e2eDatasetSHA256"`
	ASRJapaneseCER                       *float64                     `json:"asrJapaneseCER"`
	ASREnglishWER                        *float64                     `json:"asrEnglishWER"`
	PublishedJapaneseCER                 *float64                     `json:"publishedJapaneseCER"`
	PublishedEnglishWER                  *float64                     `json:"publishedEnglishWER"`
	JapaneseToEnglishChrF2               *float64                     `json:"japaneseToEnglishChrF2"`
	EnglishToJapaneseChrF2               *float64                     `json:"englishToJapaneseChrF2"`
	ShortNegationRecall                  *float64                     `json:"shortNegationRecall"`
	NumberRecall                         *float64                     `json:"numberRecall"`
	NonSpeechFalsePublications           *int                         `json:"nonSpeechFalsePublications"`
	MTCriticalTranslationFailures        *int                         `json:"mtCriticalTranslationFailures"`
	MTCriticalTranslationFailureCaseIDs  []string                     `json:"mtCriticalTranslationFailureCaseIds"`
	E2ECriticalTranslationFailures       *int                         `json:"e2eCriticalTranslationFailures"`
	E2ECriticalTranslationFailureCaseIDs []string                     `json:"e2eCriticalTranslationFailureCaseIds"`
	MajorTranslationErrors               *int                         `json:"majorTranslationErrors"`
	TerminologyErrors                    *int                         `json:"terminologyErrors"`
	TranslationFailures                  *int                         `json:"translationFailures"`
	ASRScoredCases                       int                          `json:"asrScoredCases"`
	ASRJapaneseScoredCases               *int                         `json:"asrJapaneseScoredCases"`
	ASREnglishScoredCases                *int                         `json:"asrEnglishScoredCases"`
	MTScoredCases                        int                          `json:"mtScoredCases"`
	MTJapaneseToEnglishScoredCases       *int                         `json:"mtJapaneseToEnglishScoredCases"`
	MTEnglishToJapaneseScoredCases       *int                         `json:"mtEnglishToJapaneseScoredCases"`
	E2EScoredCases                       int                          `json:"e2eScoredCases"`
	PublishedScoredCases                 *int                         `json:"publishedScoredCases"`
	PublishedVisibleCases                *int                         `json:"publishedVisibleCases"`
	PublishedOmittedCases                *int                         `json:"publishedOmittedCases"`
	PublishedOmissionsCountedAsDeletions *bool                        `json:"publishedOmissionsCountedAsDeletions"`
	PublishedJapaneseToEnglishCoverage   QualificationCaptionCoverage `json:"publishedJapaneseToEnglishCoverage"`
	PublishedEnglishToJapaneseCoverage   QualificationCaptionCoverage `json:"publishedEnglishToJapaneseCoverage"`
	ManualCriticalReviewComplete         bool                         `json:"manualCriticalReviewComplete"`
}

type QualificationCaptionCoverage struct {
	ScoredCases  *int `json:"scoredCases"`
	VisibleCases *int `json:"visibleCases"`
	OmittedCases *int `json:"omittedCases"`
}

type QualificationPerformance struct {
	MeasuredMinutes                      *float64 `json:"measuredMinutes"`
	WarmupMinutes                        *float64 `json:"warmupMinutes"`
	InferenceSteadyP95GiB                *float64 `json:"inferenceSteadyP95GiB"`
	InferencePeakGiB                     *float64 `json:"inferencePeakGiB"`
	BrowserAddedMemoryMiB                *float64 `json:"browserAddedMemoryMiB"`
	ASRRealTimeFactorP95                 *float64 `json:"asrRealTimeFactorP95"`
	EndSpeechToSourceP95Seconds          *float64 `json:"endSpeechToSourceP95Seconds"`
	EndSpeechToTranslationP95Seconds     *float64 `json:"endSpeechToTranslationP95Seconds"`
	CorrectionInteractionP95Milliseconds *float64 `json:"correctionInteractionP95Milliseconds"`
	Crashes                              *int     `json:"crashes"`
	OOMs                                 *int     `json:"ooms"`
	OverloadAudioDrops                   *int     `json:"overloadAudioDrops"`
	QueueGrowthObserved                  *bool    `json:"queueGrowthObserved"`
	CriticalMemoryPressureObserved       *bool    `json:"criticalMemoryPressureObserved"`
	ACConnected                          *bool    `json:"acConnected"`
	LowPowerModeEnabled                  *bool    `json:"lowPowerModeEnabled"`
	AcceleratorExecutionVerified         *bool    `json:"acceleratorExecutionVerified"`
	ProcessGroupMeasurementComplete      *bool    `json:"processGroupMeasurementComplete"`
}

type QualificationRollback struct {
	BaselineConfigSHA256          string `json:"baselineConfigSHA256"`
	CandidateStoppedAndReleased   bool   `json:"candidateStoppedAndReleased"`
	BaselineRestoredAndVerified   bool   `json:"baselineRestoredAndVerified"`
	StaleCandidateResultsRejected bool   `json:"staleCandidateResultsRejected"`
}

// AssessQualification applies the M1 Max product gates. Missing evidence is
// BLOCKED; a measured product or quality failure is REJECTED. Caller-authored
// reports do not carry verified execution provenance and cannot qualify.
func AssessQualification(report QualificationReport) QualificationAssessment {
	return assessQualificationWithProvenance(report, nil)
}

func assessQualificationWithProvenance(report QualificationReport, provenance *verifiedQualificationProvenance) QualificationAssessment {
	assessment := QualificationAssessment{Status: QualificationStatusQualified, Findings: make([]QualificationFinding, 0)}
	seen := make(map[string]int)
	add := func(kind, code, detail string) {
		if index, ok := seen[code]; ok {
			existing := assessment.Findings[index]
			switch {
			case kind == "rejected" && existing.Kind != "rejected":
				assessment.Findings[index] = QualificationFinding{Code: code, Detail: detail, Kind: kind}
			case kind == existing.Kind && detail < existing.Detail:
				assessment.Findings[index] = QualificationFinding{Code: code, Detail: detail, Kind: kind}
			}
		} else {
			seen[code] = len(assessment.Findings)
			assessment.Findings = append(assessment.Findings, QualificationFinding{Code: code, Detail: detail, Kind: kind})
		}
		if kind == "rejected" {
			assessment.Status = QualificationStatusRejected
		} else if assessment.Status != QualificationStatusRejected {
			assessment.Status = QualificationStatusBlocked
		}
	}
	block := func(code, detail string) { add("blocked", code, detail) }
	reject := func(code, detail string) { add("rejected", code, detail) }

	if report.SchemaVersion != 1 || strings.TrimSpace(report.RunID) == "" || report.Mode != "m1-real-google-meet-integration" || report.ProfileID != "m1-max-balanced" {
		block("RUN_IDENTITY_INCOMPLETE", "A versioned m1-max-balanced real-integration run is required.")
	}
	if report.TestDouble == nil {
		block("TEST_DOUBLE_ATTESTATION_MISSING", "The report must explicitly identify whether test doubles were used.")
	} else if *report.TestDouble {
		block("TEST_DOUBLE_EVIDENCE", "A test double cannot qualify a product configuration.")
	}
	if report.Dataset.Synthetic == nil {
		block("SYNTHETIC_DATA_ATTESTATION_MISSING", "The report must explicitly identify whether synthetic evaluation data was used.")
	}
	if report.Hardware.Chip != "Apple M1 Max" || report.Hardware.UnifiedMemoryGiB != 32 || report.Hardware.GPUCores != 24 || report.Hardware.Architecture != "arm64" || strings.TrimSpace(report.Hardware.OSVersion) == "" {
		block("TARGET_HARDWARE_NOT_VERIFIED", "The measured hardware must be M1 Max, 32 GiB, 24 GPU cores, and arm64.")
	}
	if report.Browser.Name != "Microsoft Edge" || strings.TrimSpace(report.Browser.Version) == "" {
		block("EDGE_VERSION_NOT_VERIFIED", "The requested Edge browser and exact version must be recorded.")
	}
	validateModelPin := func(name string, pin QualificationModelPin) {
		if strings.TrimSpace(pin.CandidateID) == "" || strings.TrimSpace(pin.ModelRevision) == "" || isFloatingRevision(pin.ModelRevision) || !isSHA256(pin.ArtifactSHA256) || strings.TrimSpace(pin.RuntimeID) == "" || !isImmutableRuntimeRevision(pin.RuntimeRevision) || strings.TrimSpace(pin.Quantization) == "" || !isSHA256(pin.TemplateSHA256) || !isSHA256(pin.DecodeOptionsSHA256) || strings.TrimSpace(pin.GatePolicyID) == "" || !isSHA256(pin.GateCalibrationSHA256) || !isAcceleratorBackend(pin.Backend) {
			block("MODEL_PIN_INCOMPLETE", name+" model/runtime/template/options/gate pins are incomplete or floating.")
		}
		if !pin.ExecutionVerified {
			block("ACCELERATOR_EXECUTION_UNVERIFIED", name+" must prove the pinned accelerator path executed on this M1.")
		}
	}
	validateModelPin("baseline ASR", report.Baseline.ASR)
	validateModelPin("baseline translation", report.Baseline.Translation)
	validateModelPin("candidate ASR", report.Candidate.ASR)
	validateModelPin("candidate translation", report.Candidate.Translation)
	if !report.Candidate.WeightsAuthorized || !report.Candidate.WeightTermsReviewed {
		block("MODEL_AUTHORIZATION_INCOMPLETE", "Candidate weight use must be authorized and exact weight terms reviewed.")
	}
	if !report.Candidate.PublishedMTBenchmarkScreenPassed || strings.TrimSpace(report.Candidate.PublishedMTBenchmarkScreenID) == "" || report.Candidate.PublishedMTBenchmarkCandidateID != report.Candidate.Translation.CandidateID || !isSHA256(report.Candidate.PublishedMTBenchmarkEvidenceSHA256) {
		block("MT_BENCHMARK_SCREEN_INCOMPLETE", "The exact candidate translation model must have an identifiable passing published-benchmark screen.")
	}
	if report.Candidate.VAD.Kind != "energy" && report.Candidate.VAD.Kind != "neural" {
		block("VAD_NOT_PINNED", "Exactly one supported VAD implementation and version must be recorded.")
	} else if strings.TrimSpace(report.Candidate.VAD.Version) == "" || (report.Candidate.VAD.Kind == "neural" && !isSHA256(report.Candidate.VAD.ArtifactSHA256)) {
		block("VAD_NOT_PINNED", "The VAD version and, for neural VAD, artifact hash must be pinned.")
	}
	if report.Candidate.LoadedASRModels != 1 || report.Candidate.LoadedTranslationModels != 1 {
		if report.Candidate.LoadedASRModels > 1 || report.Candidate.LoadedTranslationModels > 1 {
			reject("MULTIPLE_MODELS_RESIDENT", "Normal operation must hold one ASR and one translation model.")
		} else {
			block("MODELS_NOT_LOADED", "The complete candidate pair must be loaded during the measured run.")
		}
	}
	if report.Candidate.HeavyInferenceConcurrency != 1 {
		if report.Candidate.HeavyInferenceConcurrency > 1 {
			reject("CONCURRENT_HEAVY_INFERENCE", "Heavy ASR and translation inference must be serialized.")
		} else {
			block("INFERENCE_NOT_EXERCISED", "The measured run must execute the ASR and translation path.")
		}
	}
	if !report.Candidate.LocalInferenceOnly && report.Candidate.LoadedASRModels == 1 && report.Candidate.LoadedTranslationModels == 1 && report.Candidate.HeavyInferenceConcurrency == 1 {
		reject("LOCAL_ONLY_CONSTRAINT_VIOLATED", "Inference must remain local without external model requests or an added relay.")
	} else if !report.Candidate.LocalInferenceOnly {
		block("LOCAL_ONLY_EVIDENCE_INCOMPLETE", "Local-only inference must be verified during a complete candidate run.")
	}
	if report.Candidate.ExternalModelRequests != 0 || report.Candidate.AdditionalRelay {
		reject("LOCAL_ONLY_CONSTRAINT_VIOLATED", "Inference must remain local without external model requests or an added relay.")
	}

	validateDataset(report, block)
	validateIntegration(report.Integration, block, reject)
	validateConditions(report, block)
	validateQuality(report, block, reject)
	validatePerformance(report.Performance, block, reject)
	validateRollback(report.Rollback, block)
	if provenance == nil || provenance.keyID == "" || provenance.runID != report.RunID || provenance.reportSemanticSHA256 != sha256JSON(report) {
		block("TRUSTED_PROVENANCE_UNAVAILABLE", "Caller-authored report fields are not verified executor evidence; qualification remains blocked until a trusted collector and evidence verifier exist.")
	}
	sort.Slice(assessment.Findings, func(i, j int) bool {
		return assessment.Findings[i].Code < assessment.Findings[j].Code
	})

	return assessment
}

func runQualificationCheck(input io.Reader, output io.Writer) (QualificationAssessment, error) {
	reportRaw, err := readLimited(input, maxQualificationReportBytes)
	if err != nil {
		return QualificationAssessment{}, fmt.Errorf("read qualification report: %w", err)
	}
	return runQualificationCheckWithAttestation(reportRaw, nil, nil, nil, productionTrustedQualificationKeys(), output)
}

func qualificationExitCode(status QualificationStatus) int {
	switch status {
	case QualificationStatusQualified:
		return 0
	case QualificationStatusRejected:
		return 1
	default:
		return 2
	}
}

func validateDataset(report QualificationReport, block func(string, string)) {
	dataset := report.Dataset
	manifestPairs := []struct {
		name        string
		development string
		holdout     string
	}{
		{"ASR", dataset.ASRDevelopmentManifestSHA256, dataset.ASRHoldoutManifestSHA256},
		{"MT", dataset.MTDevelopmentManifestSHA256, dataset.MTHoldoutManifestSHA256},
		{"end-to-end", dataset.E2EDevelopmentManifestSHA256, dataset.E2EHoldoutManifestSHA256},
	}
	for _, pair := range manifestPairs {
		if !isSHA256(pair.development) || !isSHA256(pair.holdout) || pair.development == pair.holdout {
			block("DATASET_HASHES_INCOMPLETE", pair.name+" must have separate pinned development and holdout manifest hashes.")
		}
	}
	if !isSHA256(dataset.ASRHoldoutAudioSHA256) || !isSHA256(dataset.E2EHoldoutAudioSHA256) {
		block("DATASET_HASHES_INCOMPLETE", "ASR and end-to-end holdout audio hashes are required.")
	}
	if !dataset.Authorized || !dataset.LicenseReviewed || !dataset.HumanReviewed || !dataset.MeetingAudioConsented || !dataset.SplitIsolationVerified {
		block("DATASET_REVIEW_INCOMPLETE", "Dataset use, license, human review, meeting consent, and split isolation must be verified.")
	}
	if dataset.Synthetic != nil && *dataset.Synthetic {
		block("SYNTHETIC_DATASET_EVIDENCE", "Synthetic fixtures cannot qualify real speech, translation, or publication quality.")
	}
	if dataset.ASRHoldoutCases <= 0 || dataset.ASRJapaneseHoldoutCases <= 0 || dataset.ASREnglishHoldoutCases <= 0 || dataset.ASRJapaneseHoldoutCases+dataset.ASREnglishHoldoutCases != dataset.ASRHoldoutCases {
		block("INSUFFICIENT_ASR_HOLDOUT", "Every human-reviewed ASR holdout case must be assigned to Japanese or English speech.")
	}
	if dataset.MTHoldoutJapaneseToEnglish < 60 || dataset.MTHoldoutEnglishToJapanese < 60 || dataset.MTCriticalJapaneseToEnglish < 20 || dataset.MTCriticalEnglishToJapanese < 20 {
		block("INSUFFICIENT_MT_HOLDOUT", "MT holdout needs at least 60 cases and 20 critical assertions in each direction.")
	}
	if dataset.E2EHoldoutCases <= 0 || dataset.E2EJapaneseToEnglishCases <= 0 || dataset.E2EEnglishToJapaneseCases <= 0 || dataset.E2EJapaneseToEnglishCases+dataset.E2EEnglishToJapaneseCases != dataset.E2EHoldoutCases {
		block("INSUFFICIENT_E2E_HOLDOUT", "Every reviewed end-to-end holdout case must be assigned to a translation direction.")
	}
	if dataset.NoSpeechHoldoutCases <= 0 || dataset.ShortNegationHoldoutCases <= 0 || dataset.NumberHoldoutCases <= 0 {
		block("REQUIRED_CASE_TAGS_MISSING", "Holdout must include silence, short-negation, and number cases.")
	}
}

func validateIntegration(integration QualificationIntegration, block, reject func(string, string)) {
	if !integration.GoogleMeetObserved || !integration.ConsentedTestRoom {
		block("REAL_MEET_NOT_VERIFIED", "A consented, real Google Meet session must be observed.")
	}
	if integration.ParticipantDevices < 4 {
		block("MEET_PARTICIPANTS_INSUFFICIENT", "The integration run must include four participant devices.")
	}
	if !integration.CaptionTabActuallyShared || !integration.PrivateCorrectionPanelOpen || !integration.MicrophoneAndTabCaptureExercised {
		block("MEET_CAPTURE_OR_SHARING_INCOMPLETE", "Real Meet sharing, the private correction panel, and both audio streams must be exercised.")
	}
	if !integration.CorrectionUndoAndGlossaryExercised || !integration.PrivateDraftNeverShared || !integration.ExtensionLifecycleStopAndRestartPassed {
		block("MEET_UI_LIFECYCLE_INCOMPLETE", "Correction, undo, glossary, private-draft, stop, and restart evidence is required.")
	}
	if !integration.MediaRegressionComparedAndAcceptable {
		block("MEET_MEDIA_COMPARISON_INCOMPLETE", "Meet audio/video must be compared with the extension-inactive condition.")
	}
	if !integration.PublicationApprovalFlowExercised {
		block("PUBLICATION_APPROVAL_NOT_VERIFIED", "The real integration run must exercise the explicit publication-approval flow.")
	} else if !integration.PublicationRequiredExplicitApproval {
		reject("UNAPPROVED_CAPTION_PUBLICATION", "A candidate must not be published without explicit approval.")
	}
	if integration.MeetChatSideEffects != 0 {
		reject("MEET_CHAT_SIDE_EFFECT", "The caption workflow must not modify Meet chat.")
	}
}

func validateConditions(report QualificationReport, block func(string, string)) {
	if !isSHA256(report.BaselineConditionsSHA256) || !isSHA256(report.CandidateConditionsSHA256) || report.BaselineConditionsSHA256 != report.CandidateConditionsSHA256 {
		block("COMPARISON_CONDITIONS_MISMATCH", "Baseline and candidate must use the same pinned comparison conditions.")
	}
}

func validateQuality(report QualificationReport, block, reject func(string, string)) {
	baseline := report.BaselineQuality
	candidate := report.CandidateQuality
	qualityEvidenceIncomplete := false
	if baseline.ASRDatasetSHA256 != report.Dataset.ASRHoldoutManifestSHA256 || baseline.MTDatasetSHA256 != report.Dataset.MTHoldoutManifestSHA256 || baseline.E2EDatasetSHA256 != report.Dataset.E2EHoldoutManifestSHA256 || candidate.ASRDatasetSHA256 != report.Dataset.ASRHoldoutManifestSHA256 || candidate.MTDatasetSHA256 != report.Dataset.MTHoldoutManifestSHA256 || candidate.E2EDatasetSHA256 != report.Dataset.E2EHoldoutManifestSHA256 {
		block("QUALITY_DATASET_MISMATCH", "Baseline and candidate scores must match the separately pinned ASR-only, MT-only, and end-to-end holdouts.")
		qualityEvidenceIncomplete = true
	}
	if !baseline.ManualCriticalReviewComplete || !candidate.ManualCriticalReviewComplete {
		block("MANUAL_QUALITY_REVIEW_INCOMPLETE", "Both baseline and candidate critical cases require completed human review.")
		qualityEvidenceIncomplete = true
	}
	expectedMT := report.Dataset.MTHoldoutJapaneseToEnglish + report.Dataset.MTHoldoutEnglishToJapanese
	for name, result := range map[string]QualificationQuality{"baseline": baseline, "candidate": candidate} {
		if !isSHA256(result.ASRDatasetSHA256) || result.ASRDatasetSHA256 != report.Dataset.ASRHoldoutManifestSHA256 || !isSHA256(result.MTDatasetSHA256) || result.MTDatasetSHA256 != report.Dataset.MTHoldoutManifestSHA256 || !isSHA256(result.E2EDatasetSHA256) || result.E2EDatasetSHA256 != report.Dataset.E2EHoldoutManifestSHA256 {
			block("QUALITY_DATASET_MISMATCH", name+" ASR-only, correct-source MT-only, and end-to-end scores must use their separately pinned holdout manifests.")
			qualityEvidenceIncomplete = true
		}
		asrCoveragePresent := result.ASRJapaneseScoredCases != nil && result.ASREnglishScoredCases != nil
		mtCoveragePresent := result.MTJapaneseToEnglishScoredCases != nil && result.MTEnglishToJapaneseScoredCases != nil
		if !asrCoveragePresent || !mtCoveragePresent || result.ASRScoredCases != report.Dataset.ASRHoldoutCases || result.MTScoredCases != expectedMT || result.E2EScoredCases != report.Dataset.E2EHoldoutCases {
			block("QUALITY_CASES_UNSCORED", name+" must score every declared holdout case in all three tracks and report each ASR language and MT direction.")
			qualityEvidenceIncomplete = true
		} else if *result.ASRJapaneseScoredCases != report.Dataset.ASRJapaneseHoldoutCases || *result.ASREnglishScoredCases != report.Dataset.ASREnglishHoldoutCases || *result.ASRJapaneseScoredCases+*result.ASREnglishScoredCases != result.ASRScoredCases || *result.MTJapaneseToEnglishScoredCases != report.Dataset.MTHoldoutJapaneseToEnglish || *result.MTEnglishToJapaneseScoredCases != report.Dataset.MTHoldoutEnglishToJapanese || *result.MTJapaneseToEnglishScoredCases+*result.MTEnglishToJapaneseScoredCases != result.MTScoredCases {
			block("QUALITY_CASES_UNSCORED", name+" per-language ASR and per-direction MT scored counts must match the pinned holdout manifest and aggregate totals.")
			qualityEvidenceIncomplete = true
		}
		if result.PublishedScoredCases == nil || result.PublishedVisibleCases == nil || result.PublishedOmittedCases == nil || result.PublishedOmissionsCountedAsDeletions == nil || result.PublishedJapaneseToEnglishCoverage.ScoredCases == nil || result.PublishedJapaneseToEnglishCoverage.VisibleCases == nil || result.PublishedJapaneseToEnglishCoverage.OmittedCases == nil || result.PublishedEnglishToJapaneseCoverage.ScoredCases == nil || result.PublishedEnglishToJapaneseCoverage.VisibleCases == nil || result.PublishedEnglishToJapaneseCoverage.OmittedCases == nil {
			block("PUBLISHED_CASES_UNSCORED", name+" must account for every end-to-end speech case and explicitly score withheld captions as omissions.")
			qualityEvidenceIncomplete = true
		} else {
			publishedScored := *result.PublishedScoredCases
			publishedVisible := *result.PublishedVisibleCases
			publishedOmitted := *result.PublishedOmittedCases
			jaToEn := result.PublishedJapaneseToEnglishCoverage
			enToJa := result.PublishedEnglishToJapaneseCoverage
			jaToEnValid := *jaToEn.ScoredCases == report.Dataset.E2EJapaneseToEnglishCases && *jaToEn.VisibleCases >= 0 && *jaToEn.OmittedCases >= 0 && *jaToEn.VisibleCases+*jaToEn.OmittedCases == *jaToEn.ScoredCases
			enToJaValid := *enToJa.ScoredCases == report.Dataset.E2EEnglishToJapaneseCases && *enToJa.VisibleCases >= 0 && *enToJa.OmittedCases >= 0 && *enToJa.VisibleCases+*enToJa.OmittedCases == *enToJa.ScoredCases
			directionScored := *jaToEn.ScoredCases + *enToJa.ScoredCases
			directionVisible := *jaToEn.VisibleCases + *enToJa.VisibleCases
			directionOmitted := *jaToEn.OmittedCases + *enToJa.OmittedCases
			if publishedScored != report.Dataset.E2EHoldoutCases || publishedScored != directionScored || publishedVisible < 0 || publishedVisible != directionVisible || publishedOmitted < 0 || publishedOmitted != directionOmitted || publishedVisible+publishedOmitted != publishedScored || !jaToEnValid || !enToJaValid || !*result.PublishedOmissionsCountedAsDeletions {
				block("PUBLISHED_CASES_UNSCORED", name+" published-caption metrics must cover all E2E speech cases, count withheld captions as deletions, and reconcile visible plus omitted cases.")
				qualityEvidenceIncomplete = true
			}
		}
		for metricName, metric := range map[string]*float64{
			"ASR-only Japanese CER":     result.ASRJapaneseCER,
			"ASR-only English WER":      result.ASREnglishWER,
			"published Japanese CER":    result.PublishedJapaneseCER,
			"published English WER":     result.PublishedEnglishWER,
			"Japanese-to-English chrF2": result.JapaneseToEnglishChrF2,
			"English-to-Japanese chrF2": result.EnglishToJapaneseChrF2,
			"short-negation recall":     result.ShortNegationRecall,
			"number recall":             result.NumberRecall,
		} {
			if metric == nil || math.IsNaN(*metric) || math.IsInf(*metric, 0) || *metric < 0 || *metric > 1 {
				block("QUALITY_METRICS_INCOMPLETE", name+" "+metricName+" is missing or outside [0,1].")
				qualityEvidenceIncomplete = true
			}
		}
		for metricName, metric := range map[string]*int{
			"non-speech false publications":     result.NonSpeechFalsePublications,
			"MT critical translation failures":  result.MTCriticalTranslationFailures,
			"E2E critical translation failures": result.E2ECriticalTranslationFailures,
			"major translation errors":          result.MajorTranslationErrors,
			"terminology errors":                result.TerminologyErrors,
			"translation failures":              result.TranslationFailures,
		} {
			if metric == nil || *metric < 0 {
				block("QUALITY_METRICS_INCOMPLETE", name+" "+metricName+" is missing or negative.")
				qualityEvidenceIncomplete = true
			}
		}
		criticalFailureSets := []struct {
			name  string
			count *int
			ids   []string
		}{
			{"MT", result.MTCriticalTranslationFailures, result.MTCriticalTranslationFailureCaseIDs},
			{"E2E", result.E2ECriticalTranslationFailures, result.E2ECriticalTranslationFailureCaseIDs},
		}
		for _, failures := range criticalFailureSets {
			if failures.count != nil && *failures.count != len(failures.ids) {
				block("QUALITY_METRICS_INCOMPLETE", name+" "+failures.name+" critical failure count must match distinct reviewed case IDs.")
				qualityEvidenceIncomplete = true
			}
			seenCriticalCases := make(map[string]struct{}, len(failures.ids))
			for _, caseID := range failures.ids {
				if strings.TrimSpace(caseID) == "" {
					block("QUALITY_METRICS_INCOMPLETE", name+" "+failures.name+" critical failure case IDs must be nonempty.")
					qualityEvidenceIncomplete = true
					continue
				}
				if _, exists := seenCriticalCases[caseID]; exists {
					block("QUALITY_METRICS_INCOMPLETE", name+" "+failures.name+" critical failure case IDs must be unique.")
					qualityEvidenceIncomplete = true
				}
				seenCriticalCases[caseID] = struct{}{}
			}
		}
	}
	if qualityEvidenceIncomplete || hasMissingQualityMetric(baseline) || hasMissingQualityMetric(candidate) {
		return
	}
	if *baseline.PublishedJapaneseToEnglishCoverage.VisibleCases == 0 || *baseline.PublishedEnglishToJapaneseCoverage.VisibleCases == 0 {
		block("BASELINE_PUBLICATION_COVERAGE_EMPTY", "The baseline publishes no speech captions, so it cannot establish a usable coverage reference.")
	}
	if *candidate.PublishedVisibleCases == 0 {
		reject("ALL_CAPTIONS_WITHHELD", "A candidate that withholds every speech caption cannot qualify, even if its subset metrics appear favorable.")
	} else if *candidate.PublishedVisibleCases < *baseline.PublishedVisibleCases || *candidate.PublishedJapaneseToEnglishCoverage.VisibleCases < *baseline.PublishedJapaneseToEnglishCoverage.VisibleCases || *candidate.PublishedEnglishToJapaneseCoverage.VisibleCases < *baseline.PublishedEnglishToJapaneseCoverage.VisibleCases {
		reject("PUBLICATION_COVERAGE_REGRESSION", "The candidate must not reduce the number of published speech captions relative to the baseline.")
	}
	if *candidate.PublishedJapaneseToEnglishCoverage.VisibleCases == 0 || *candidate.PublishedEnglishToJapaneseCoverage.VisibleCases == 0 {
		reject("DIRECTION_CAPTIONS_WITHHELD", "A candidate must publish speech captions in both translation directions.")
	}
	const onePercentagePoint = 0.01
	if *candidate.PublishedJapaneseCER-*baseline.PublishedJapaneseCER > onePercentagePoint+1e-12 || *candidate.PublishedEnglishWER-*baseline.PublishedEnglishWER > onePercentagePoint+1e-12 {
		reject("ASR_QUALITY_REGRESSION", "Published Japanese CER or English WER regressed by more than one percentage point.")
	}
	if *candidate.ShortNegationRecall < *baseline.ShortNegationRecall || *candidate.NumberRecall < *baseline.NumberRecall {
		reject("CRITICAL_ASR_RECALL_REGRESSION", "Short-negation and number recall must not regress.")
	}
	if *candidate.JapaneseToEnglishChrF2+onePercentagePoint+1e-12 < *baseline.JapaneseToEnglishChrF2 || *candidate.EnglishToJapaneseChrF2+onePercentagePoint+1e-12 < *baseline.EnglishToJapaneseChrF2 {
		reject("MT_QUALITY_REGRESSION", "chrF2 must not regress by more than one point in either direction.")
	}
	if *candidate.NonSpeechFalsePublications > *baseline.NonSpeechFalsePublications/2 {
		reject("NON_SPEECH_PUBLICATION_REGRESSION", "False non-speech publication count must be zero when baseline is zero, otherwise at most half.")
	}
	mtCriticalRegression := *candidate.MTCriticalTranslationFailures > *baseline.MTCriticalTranslationFailures || hasNewCriticalCase(baseline.MTCriticalTranslationFailureCaseIDs, candidate.MTCriticalTranslationFailureCaseIDs)
	e2eCriticalRegression := *candidate.E2ECriticalTranslationFailures > *baseline.E2ECriticalTranslationFailures || hasNewCriticalCase(baseline.E2ECriticalTranslationFailureCaseIDs, candidate.E2ECriticalTranslationFailureCaseIDs)
	if mtCriticalRegression || e2eCriticalRegression {
		reject("CRITICAL_TRANSLATION_REGRESSION", "Critical translation failures must not increase.")
	}
	if *candidate.MajorTranslationErrors > *baseline.MajorTranslationErrors || *candidate.TerminologyErrors > *baseline.TerminologyErrors || *candidate.TranslationFailures > *baseline.TranslationFailures {
		reject("GENERAL_TRANSLATION_REGRESSION", "Major errors, terminology errors, and failed translations must not increase.")
	}
}

func hasNewCriticalCase(baselineIDs, candidateIDs []string) bool {
	baselineCases := make(map[string]struct{}, len(baselineIDs))
	for _, caseID := range baselineIDs {
		baselineCases[caseID] = struct{}{}
	}
	for _, caseID := range candidateIDs {
		if _, existed := baselineCases[caseID]; !existed {
			return true
		}
	}
	return false
}

func hasMissingQualityMetric(result QualificationQuality) bool {
	return result.ASRJapaneseCER == nil || result.ASREnglishWER == nil || result.PublishedJapaneseCER == nil || result.PublishedEnglishWER == nil || result.JapaneseToEnglishChrF2 == nil || result.EnglishToJapaneseChrF2 == nil || result.ShortNegationRecall == nil || result.NumberRecall == nil || result.NonSpeechFalsePublications == nil || result.MTCriticalTranslationFailures == nil || result.E2ECriticalTranslationFailures == nil || result.MajorTranslationErrors == nil || result.TerminologyErrors == nil || result.TranslationFailures == nil
}

func validatePerformance(performance QualificationPerformance, block, reject func(string, string)) {
	floatMetrics := map[string]*float64{
		"measured minutes":           performance.MeasuredMinutes,
		"warmup minutes":             performance.WarmupMinutes,
		"steady p95 memory":          performance.InferenceSteadyP95GiB,
		"peak memory":                performance.InferencePeakGiB,
		"browser memory overhead":    performance.BrowserAddedMemoryMiB,
		"ASR RTF p95":                performance.ASRRealTimeFactorP95,
		"source-caption latency p95": performance.EndSpeechToSourceP95Seconds,
		"translation latency p95":    performance.EndSpeechToTranslationP95Seconds,
		"correction response p95":    performance.CorrectionInteractionP95Milliseconds,
	}
	missingMetric := false
	for name, metric := range floatMetrics {
		if metric == nil {
			missingMetric = true
		} else if math.IsNaN(*metric) || math.IsInf(*metric, 0) || *metric < 0 {
			block("PERFORMANCE_METRIC_INVALID", name+" is not a finite nonnegative measurement.")
		}
	}
	intMetrics := map[string]*int{
		"crashes":              performance.Crashes,
		"OOMs":                 performance.OOMs,
		"overload audio drops": performance.OverloadAudioDrops,
	}
	for name, metric := range intMetrics {
		if metric == nil {
			missingMetric = true
		} else if *metric < 0 {
			block("PERFORMANCE_METRIC_INVALID", name+" cannot be negative.")
		}
	}
	boolMetrics := map[string]*bool{
		"queue growth":              performance.QueueGrowthObserved,
		"critical memory pressure":  performance.CriticalMemoryPressureObserved,
		"AC state":                  performance.ACConnected,
		"low-power state":           performance.LowPowerModeEnabled,
		"accelerator execution":     performance.AcceleratorExecutionVerified,
		"process-group measurement": performance.ProcessGroupMeasurementComplete,
	}
	for _, metric := range boolMetrics {
		if metric == nil {
			missingMetric = true
		}
	}
	if missingMetric {
		block("PERFORMANCE_EVIDENCE_INCOMPLETE", "Every required M1 performance measurement must be present, including measured zero values.")
	}
	if performance.MeasuredMinutes != nil && *performance.MeasuredMinutes < 60 {
		block("SIXTY_MINUTE_RUN_INCOMPLETE", "The measured workload must run for at least 60 minutes after warmup.")
	}
	if performance.WarmupMinutes != nil && *performance.WarmupMinutes < 2 {
		block("WARMUP_INCOMPLETE", "The measured workload requires at least two minutes of warmup.")
	}
	if performance.InferenceSteadyP95GiB != nil && *performance.InferenceSteadyP95GiB > 8 {
		reject("INFERENCE_STEADY_MEMORY_EXCEEDED", "Steady-state inference process-group p95 exceeds 8 GiB.")
	}
	if performance.InferencePeakGiB != nil && *performance.InferencePeakGiB > 10 {
		reject("INFERENCE_PEAK_EXCEEDED", "Inference process-group peak exceeds 10 GiB.")
	}
	if performance.BrowserAddedMemoryMiB != nil && *performance.BrowserAddedMemoryMiB > 512 {
		reject("BROWSER_MEMORY_EXCEEDED", "Added browser UI memory exceeds the 512 MiB target.")
	}
	if performance.ASRRealTimeFactorP95 != nil && *performance.ASRRealTimeFactorP95 > 0.5 {
		reject("ASR_RTF_EXCEEDED", "ASR real-time-factor p95 exceeds 0.5.")
	}
	if performance.EndSpeechToSourceP95Seconds != nil && *performance.EndSpeechToSourceP95Seconds > 2 {
		reject("SOURCE_LATENCY_EXCEEDED", "End-of-speech to source-caption p95 exceeds two seconds.")
	}
	if performance.EndSpeechToTranslationP95Seconds != nil && *performance.EndSpeechToTranslationP95Seconds > 3 {
		reject("TRANSLATION_LATENCY_EXCEEDED", "End-of-speech to translated-caption p95 exceeds three seconds.")
	}
	if performance.CorrectionInteractionP95Milliseconds != nil && *performance.CorrectionInteractionP95Milliseconds > 100 {
		reject("CORRECTION_LATENCY_EXCEEDED", "Correction interaction p95 exceeds 100 ms.")
	}
	if performance.Crashes != nil && *performance.Crashes > 0 {
		reject("CRASH_OBSERVED", "The measured session crashed.")
	}
	if performance.OOMs != nil && *performance.OOMs > 0 {
		reject("OOM_OBSERVED", "The measured session had an out-of-memory event.")
	}
	if performance.OverloadAudioDrops != nil && *performance.OverloadAudioDrops > 0 {
		reject("OVERLOAD_AUDIO_LOSS", "Normal-load audio was dropped by overload handling.")
	}
	if performance.QueueGrowthObserved != nil && *performance.QueueGrowthObserved {
		reject("QUEUE_GROWTH_OBSERVED", "The work queue grew during the sustained run.")
	}
	if performance.CriticalMemoryPressureObserved != nil && *performance.CriticalMemoryPressureObserved {
		reject("CRITICAL_MEMORY_PRESSURE", "System critical memory pressure occurred during the run.")
	}
	if performance.ACConnected != nil && !*performance.ACConnected || performance.LowPowerModeEnabled != nil && *performance.LowPowerModeEnabled {
		block("POWER_CONDITION_INVALID", "The baseline run requires AC power with Low Power Mode disabled.")
	}
	if performance.AcceleratorExecutionVerified != nil && !*performance.AcceleratorExecutionVerified {
		block("ACCELERATOR_EXECUTION_UNVERIFIED", "The selected M1 accelerator path was not verified during inference.")
	}
	if performance.ProcessGroupMeasurementComplete != nil && !*performance.ProcessGroupMeasurementComplete {
		block("PROCESS_GROUP_MEASUREMENT_INCOMPLETE", "The process-group memory measurement is incomplete.")
	}
}

func validateRollback(rollback QualificationRollback, block func(string, string)) {
	if !isSHA256(rollback.BaselineConfigSHA256) || !rollback.CandidateStoppedAndReleased || !rollback.BaselineRestoredAndVerified || !rollback.StaleCandidateResultsRejected {
		block("ROLLBACK_NOT_VERIFIED", "The candidate must stop and release, the baseline must restore, and stale results must be rejected.")
	}
}

func isSHA256(value string) bool {
	return sha256Pattern.MatchString(value)
}

func isFloatingRevision(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "main", "master", "latest", "head", "current":
		return true
	default:
		return false
	}
}

func isImmutableRuntimeRevision(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}

func isAcceleratorBackend(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "metal", "coreml", "mlx":
		return true
	default:
		return false
	}
}
