package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
)

const (
	measurementRecordSchemaVersion = 1
	measurementSampleTargetMillis  = int64(1_000)
	measurementSampleMinGapMillis  = int64(900)
	measurementSampleMaxGapMillis  = int64(1_500)
	maximumMeasurementRunIDBytes   = 128
	minimumMeasurementWarmupMillis = int64(120_000)
	minimumMeasuredDurationMillis  = int64(3_600_000)
	bytesPerGiB                    = uint64(1024 * 1024 * 1024)
)

type MeasurementProcessIdentity struct {
	PID               int   `json:"pid"`
	StartedAtUnixNano int64 `json:"startedAtUnixNano"`
}

type MeasurementHardware struct {
	Chip             string `json:"chip"`
	UnifiedMemoryGiB int    `json:"unifiedMemoryGiB"`
	GPUCores         int    `json:"gpuCores"`
	Architecture     string `json:"architecture"`
	OSVersion        string `json:"osVersion"`
}

type MeasurementBrowser struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// MeasurementRunRecord is a strict raw observation contract. It contains no
// captions, prompts, audio, or model output text. A record alone is never
// trusted product evidence; it must later be bound by an approved collector.
type MeasurementRunRecord struct {
	SchemaVersion                int                        `json:"schemaVersion"`
	RunID                        string                     `json:"runId"`
	TestDouble                   *bool                      `json:"testDouble"`
	Synthetic                    *bool                      `json:"synthetic"`
	Hardware                     MeasurementHardware        `json:"hardware"`
	Browser                      MeasurementBrowser         `json:"browser"`
	RootProcess                  MeasurementProcessIdentity `json:"rootProcess"`
	SampleIntervalMillis         int64                      `json:"sampleIntervalMillis"`
	WarmupDurationMillis         int64                      `json:"warmupDurationMillis"`
	MeasuredDurationMillis       int64                      `json:"measuredDurationMillis"`
	ModelReleaseObserved         bool                       `json:"modelReleaseObserved"`
	ACConnected                  *bool                      `json:"acConnected"`
	LowPowerModeEnabled          *bool                      `json:"lowPowerModeEnabled"`
	AcceleratorExecutionVerified *bool                      `json:"acceleratorExecutionVerified"`
	Samples                      []MeasurementSample        `json:"samples"`
}

type MeasurementSample struct {
	ElapsedMillis             int64                `json:"elapsedMillis"`
	ProcessMembershipComplete bool                 `json:"processMembershipComplete"`
	MemoryPressure            *string              `json:"memoryPressure"`
	SwapUsedBytes             *uint64              `json:"swapUsedBytes"`
	Processes                 []MeasurementProcess `json:"processes"`
}

type MeasurementProcess struct {
	PID                int     `json:"pid"`
	ParentPID          int     `json:"parentPid"`
	StartedAtUnixNano  int64   `json:"startedAtUnixNano"`
	RSSBytes           uint64  `json:"rssBytes"`
	PhysFootprintBytes *uint64 `json:"physFootprintBytes"`
}

type MeasurementFinding struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

type MeasurementAssessment struct {
	Mode                           string               `json:"mode"`
	RunID                          string               `json:"runId"`
	ProductStatus                  string               `json:"productStatus"`
	QualificationEvidence          bool                 `json:"qualificationEvidence"`
	QualityEvidence                bool                 `json:"qualityEvidence"`
	TestDouble                     *bool                `json:"testDouble"`
	Synthetic                      *bool                `json:"synthetic"`
	SampleCount                    int                  `json:"sampleCount"`
	WarmupSampleCount              int                  `json:"warmupSampleCount"`
	MeasuredSampleCount            int                  `json:"measuredSampleCount"`
	StopSampleCount                int                  `json:"stopSampleCount"`
	ProcessGroupMembershipComplete bool                 `json:"processGroupMembershipComplete"`
	RSSSteadyP95GiB                *float64             `json:"rssSteadyP95GiB"`
	RSSPeakGiB                     *float64             `json:"rssPeakGiB"`
	PhysFootprintSteadyP95GiB      *float64             `json:"physFootprintSteadyP95GiB"`
	PhysFootprintPeakGiB           *float64             `json:"physFootprintPeakGiB"`
	CriticalMemoryPressureObserved *bool                `json:"criticalMemoryPressureObserved"`
	SwapDeltaBytes                 *int64               `json:"swapDeltaBytes"`
	Findings                       []MeasurementFinding `json:"findings"`
}

// AnalyzeMeasurementRun validates sample integrity and reports process-group
// RSS/phys_footprint aggregates. It deliberately reports no product or quality
// evidence, even if a caller-authored record contains plausible M1 values.
func AnalyzeMeasurementRun(record MeasurementRunRecord) (MeasurementAssessment, error) {
	if err := validateMeasurementRun(record); err != nil {
		return MeasurementAssessment{}, err
	}

	assessment := MeasurementAssessment{
		Mode:                  "measurement-record-check-untrusted",
		RunID:                 record.RunID,
		ProductStatus:         "not-evaluated",
		QualificationEvidence: false,
		QualityEvidence:       false,
		TestDouble:            record.TestDouble,
		Synthetic:             record.Synthetic,
		SampleCount:           len(record.Samples),
		Findings:              make([]MeasurementFinding, 0),
	}
	find := func(code, detail string) {
		assessment.Findings = append(assessment.Findings, MeasurementFinding{Code: code, Detail: detail})
	}
	find("TRUSTED_COLLECTOR_UNAVAILABLE", "A local measurement record is caller-editable and is not trusted execution evidence.")
	if record.TestDouble == nil {
		find("TEST_DOUBLE_ATTESTATION_MISSING", "The record must explicitly identify whether a test double was used.")
	} else if *record.TestDouble {
		find("TEST_DOUBLE_EVIDENCE", "A test-double measurement cannot qualify a product configuration.")
	}
	if record.Synthetic == nil {
		find("SYNTHETIC_DATA_ATTESTATION_MISSING", "The record must explicitly identify whether synthetic data was used.")
	} else if *record.Synthetic {
		find("SYNTHETIC_DATA_EVIDENCE", "Synthetic data cannot qualify product quality or integration.")
	}
	if record.Hardware.Chip != "Apple M1 Max" || record.Hardware.UnifiedMemoryGiB != 32 || record.Hardware.GPUCores != 24 || record.Hardware.Architecture != "arm64" || record.Hardware.OSVersion == "" {
		find("TARGET_HARDWARE_NOT_VERIFIED", "The record does not identify the required M1 Max, 32 GiB, 24-core GPU arm64 target.")
	}
	if record.Browser.Name != "Microsoft Edge" || record.Browser.Version == "" {
		find("EDGE_VERSION_NOT_VERIFIED", "The record does not identify the Microsoft Edge version.")
	}
	if record.ACConnected == nil || !*record.ACConnected || record.LowPowerModeEnabled == nil || *record.LowPowerModeEnabled {
		find("POWER_CONDITION_INVALID", "The required baseline condition is AC power with Low Power Mode disabled.")
	}
	if record.AcceleratorExecutionVerified == nil || !*record.AcceleratorExecutionVerified {
		find("ACCELERATOR_EXECUTION_UNVERIFIED", "The selected accelerator execution path was not verified.")
	}
	if !record.ModelReleaseObserved {
		find("MODEL_RELEASE_UNVERIFIED", "The record does not observe model/process release after the run.")
	}
	if record.WarmupDurationMillis < minimumMeasurementWarmupMillis || record.MeasuredDurationMillis < minimumMeasuredDurationMillis {
		find("MEASUREMENT_DURATION_INCOMPLETE", "Qualification requires at least two minutes of warmup and 60 minutes of measurement.")
	}

	allMembershipComplete := true
	allFootprintsAvailable := true
	allPressuresAvailable := true
	measurementEnd := record.WarmupDurationMillis + record.MeasuredDurationMillis
	for _, sample := range record.Samples {
		if sample.ElapsedMillis > 0 && sample.ElapsedMillis <= record.WarmupDurationMillis {
			assessment.WarmupSampleCount++
		} else if sample.ElapsedMillis > record.WarmupDurationMillis && sample.ElapsedMillis <= measurementEnd {
			assessment.MeasuredSampleCount++
		} else if sample.ElapsedMillis > measurementEnd {
			assessment.StopSampleCount++
		}
		if !sample.ProcessMembershipComplete {
			allMembershipComplete = false
		}
		if sample.MemoryPressure == nil {
			allPressuresAvailable = false
		}
		for _, process := range sample.Processes {
			if process.PhysFootprintBytes == nil {
				allFootprintsAvailable = false
			}
		}
	}
	assessment.ProcessGroupMembershipComplete = allMembershipComplete
	if !allMembershipComplete {
		find("PROCESS_GROUP_MEMBERSHIP_INCOMPLETE", "At least one sample does not contain a complete process group.")
	}
	if !allFootprintsAvailable {
		find("PHYS_FOOTPRINT_UNAVAILABLE", "phys_footprint is missing from at least one process sample; it is not inferred from RSS.")
	}
	if !allPressuresAvailable {
		find("MEMORY_PRESSURE_UNAVAILABLE", "At least one memory-pressure observation is unavailable.")
	}

	rssAll := make([]float64, 0, len(record.Samples))
	rssMeasured := make([]float64, 0, len(record.Samples))
	footprintAll := make([]float64, 0, len(record.Samples))
	footprintMeasured := make([]float64, 0, len(record.Samples))
	criticalObserved := false
	for _, sample := range record.Samples {
		rssBytes, err := processGroupBytes(sample, false)
		if err != nil {
			return MeasurementAssessment{}, err
		}
		rssGiB := float64(rssBytes) / float64(bytesPerGiB)
		rssAll = append(rssAll, rssGiB)
		if sample.ElapsedMillis > record.WarmupDurationMillis && sample.ElapsedMillis <= measurementEnd {
			rssMeasured = append(rssMeasured, rssGiB)
		}
		if allFootprintsAvailable {
			footprintBytes, err := processGroupBytes(sample, true)
			if err != nil {
				return MeasurementAssessment{}, err
			}
			footprintGiB := float64(footprintBytes) / float64(bytesPerGiB)
			footprintAll = append(footprintAll, footprintGiB)
			if sample.ElapsedMillis > record.WarmupDurationMillis && sample.ElapsedMillis <= measurementEnd {
				footprintMeasured = append(footprintMeasured, footprintGiB)
			}
		}
		if allPressuresAvailable && *sample.MemoryPressure == "critical" {
			criticalObserved = true
		}
	}
	if allMembershipComplete {
		assessment.RSSPeakGiB = measurementFloatPointer(maximum(rssAll))
		assessment.RSSSteadyP95GiB = measurementFloatPointer(nearestRankPercentile(rssMeasured, 0.95))
		if allFootprintsAvailable {
			assessment.PhysFootprintPeakGiB = measurementFloatPointer(maximum(footprintAll))
			assessment.PhysFootprintSteadyP95GiB = measurementFloatPointer(nearestRankPercentile(footprintMeasured, 0.95))
		}
	}
	if allPressuresAvailable {
		assessment.CriticalMemoryPressureObserved = boolPointer(criticalObserved)
	}
	if firstSwap, lastSwap := record.Samples[0].SwapUsedBytes, record.Samples[len(record.Samples)-1].SwapUsedBytes; firstSwap != nil && lastSwap != nil {
		if delta, ok := signedByteDelta(*firstSwap, *lastSwap); ok {
			assessment.SwapDeltaBytes = &delta
		}
	}

	if len(rssMeasured) == 0 {
		return MeasurementAssessment{}, errors.New("measurement interval contains no steady-state samples")
	}
	sort.Slice(assessment.Findings, func(i, j int) bool { return assessment.Findings[i].Code < assessment.Findings[j].Code })
	return assessment, nil
}

func validateMeasurementRun(record MeasurementRunRecord) error {
	if record.SchemaVersion != measurementRecordSchemaVersion || !validMeasurementRunID(record.RunID) {
		return errors.New("measurement record schema or run identity is invalid")
	}
	if record.SampleIntervalMillis != measurementSampleTargetMillis {
		return errors.New("measurement sample interval must be pinned to 1000 milliseconds")
	}
	if record.WarmupDurationMillis < 0 || record.MeasuredDurationMillis < 0 || record.MeasuredDurationMillis > math.MaxInt64-record.WarmupDurationMillis {
		return errors.New("measurement interval durations are invalid")
	}
	if record.RootProcess.PID <= 0 || record.RootProcess.StartedAtUnixNano <= 0 {
		return errors.New("measurement root process identity is invalid")
	}
	if len(record.Samples) == 0 {
		return errors.New("measurement record has no samples")
	}
	if record.Samples[0].ElapsedMillis != 0 {
		return errors.New("measurement samples must begin at elapsed time zero")
	}
	measurementEnd := record.WarmupDurationMillis + record.MeasuredDurationMillis
	var warmupSamples, measuredSamples, stopSamples int
	for index, sample := range record.Samples {
		if sample.ElapsedMillis < 0 {
			return errors.New("measurement sample elapsed time cannot be negative")
		}
		if index > 0 {
			gap := sample.ElapsedMillis - record.Samples[index-1].ElapsedMillis
			if gap < measurementSampleMinGapMillis || gap > measurementSampleMaxGapMillis {
				return fmt.Errorf("measurement sample gap %dms is outside the 900–1500ms window", gap)
			}
		}
		if sample.ElapsedMillis > 0 && sample.ElapsedMillis <= record.WarmupDurationMillis {
			warmupSamples++
		} else if sample.ElapsedMillis > record.WarmupDurationMillis && sample.ElapsedMillis <= measurementEnd {
			measuredSamples++
		} else if sample.ElapsedMillis > measurementEnd {
			stopSamples++
		}
		if err := validateMeasurementProcessSample(record.RootProcess, sample); err != nil {
			return fmt.Errorf("measurement sample at %dms: %w", sample.ElapsedMillis, err)
		}
		if sample.MemoryPressure != nil && *sample.MemoryPressure != "normal" && *sample.MemoryPressure != "warning" && *sample.MemoryPressure != "critical" {
			return fmt.Errorf("measurement sample at %dms has an invalid memory-pressure value", sample.ElapsedMillis)
		}
	}
	if warmupSamples == 0 || measuredSamples == 0 || stopSamples == 0 {
		return errors.New("measurement record must include warmup, measured, and post-measurement stop samples")
	}
	return nil
}

func validMeasurementRunID(runID string) bool {
	if len(runID) == 0 || len(runID) > maximumMeasurementRunIDBytes {
		return false
	}
	for index, value := range []byte(runID) {
		isLetter := value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z'
		isDigit := value >= '0' && value <= '9'
		if index == 0 {
			if !isLetter && !isDigit {
				return false
			}
			continue
		}
		if !isLetter && !isDigit && value != '.' && value != '_' && value != ':' && value != '-' {
			return false
		}
	}
	return true
}

func validateMeasurementProcessSample(root MeasurementProcessIdentity, sample MeasurementSample) error {
	if len(sample.Processes) == 0 {
		return errors.New("process sample is empty")
	}
	byPID := make(map[int]MeasurementProcess, len(sample.Processes))
	for _, process := range sample.Processes {
		if process.PID <= 0 || process.StartedAtUnixNano <= 0 || process.RSSBytes == 0 {
			return errors.New("process identity or RSS is invalid")
		}
		if process.PhysFootprintBytes != nil && *process.PhysFootprintBytes == 0 {
			return errors.New("phys_footprint must be positive when present")
		}
		if _, exists := byPID[process.PID]; exists {
			return fmt.Errorf("duplicate process ID %d in one sample", process.PID)
		}
		byPID[process.PID] = process
	}
	rootProcess, exists := byPID[root.PID]
	if !exists || rootProcess.StartedAtUnixNano != root.StartedAtUnixNano {
		return errors.New("root process identity is missing or changed")
	}
	if !sample.ProcessMembershipComplete {
		return nil
	}
	for _, process := range sample.Processes {
		if process.PID == root.PID {
			continue
		}
		visited := make(map[int]struct{})
		current := process
		for current.PID != root.PID {
			if _, duplicate := visited[current.PID]; duplicate {
				return errors.New("process parent chain contains a cycle")
			}
			visited[current.PID] = struct{}{}
			parent, ok := byPID[current.ParentPID]
			if !ok {
				return fmt.Errorf("process %d has parent %d outside the complete process group", current.PID, current.ParentPID)
			}
			if current.StartedAtUnixNano < parent.StartedAtUnixNano {
				return fmt.Errorf("process %d started before parent %d", current.PID, parent.PID)
			}
			current = parent
		}
	}
	return nil
}

func processGroupBytes(sample MeasurementSample, usePhysFootprint bool) (uint64, error) {
	var total uint64
	for _, process := range sample.Processes {
		value := process.RSSBytes
		if usePhysFootprint {
			if process.PhysFootprintBytes == nil {
				return 0, errors.New("phys_footprint disappeared during aggregation")
			}
			value = *process.PhysFootprintBytes
		}
		if math.MaxUint64-total < value {
			return 0, errors.New("process-group memory sum overflows uint64")
		}
		total += value
	}
	return total, nil
}

func nearestRankPercentile(values []float64, percentile float64) float64 {
	ordered := append([]float64(nil), values...)
	sort.Float64s(ordered)
	rank := int(math.Ceil(percentile * float64(len(ordered))))
	if rank < 1 {
		rank = 1
	}
	return ordered[rank-1]
}

func maximum(values []float64) float64 {
	max := values[0]
	for _, value := range values[1:] {
		if value > max {
			max = value
		}
	}
	return max
}

func signedByteDelta(start, end uint64) (int64, bool) {
	if start > math.MaxInt64 || end > math.MaxInt64 {
		return 0, false
	}
	return int64(end) - int64(start), true
}

func measurementFloatPointer(value float64) *float64 { return &value }
func boolPointer(value bool) *bool                   { return &value }

func hasMeasurementFinding(assessment MeasurementAssessment, code string) bool {
	for _, finding := range assessment.Findings {
		if finding.Code == code {
			return true
		}
	}
	return false
}

func runMeasurementCheck(recordRaw []byte, output io.Writer) (MeasurementAssessment, error) {
	if len(recordRaw) == 0 || len(recordRaw) > maxQualificationEvidenceBytes {
		return MeasurementAssessment{}, errors.New("measurement record size is invalid")
	}
	var record MeasurementRunRecord
	if err := decodeStrictJSON(recordRaw, &record); err != nil {
		return MeasurementAssessment{}, fmt.Errorf("decode measurement record: %w", err)
	}
	assessment, err := AnalyzeMeasurementRun(record)
	if err != nil {
		return MeasurementAssessment{}, err
	}
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(assessment); err != nil {
		return MeasurementAssessment{}, fmt.Errorf("write measurement assessment: %w", err)
	}
	return assessment, nil
}
