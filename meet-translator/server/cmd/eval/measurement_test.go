package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAnalyzeMeasurementRunSeparatesSteadyP95FromFullRunPeak(t *testing.T) {
	assessment, err := AnalyzeMeasurementRun(validMeasurementRun())
	if err != nil {
		t.Fatalf("AnalyzeMeasurementRun() error = %v", err)
	}
	if assessment.RSSSteadyP95GiB == nil || *assessment.RSSSteadyP95GiB != 4 {
		t.Fatalf("RSS steady p95 = %v, want 4 GiB from measured samples only", assessment.RSSSteadyP95GiB)
	}
	if assessment.RSSPeakGiB == nil || *assessment.RSSPeakGiB != 12 {
		t.Fatalf("RSS peak = %v, want 12 GiB including load/stop samples", assessment.RSSPeakGiB)
	}
	if assessment.PhysFootprintSteadyP95GiB == nil || *assessment.PhysFootprintSteadyP95GiB != 2 {
		t.Fatalf("phys_footprint steady p95 = %v, want 2 GiB", assessment.PhysFootprintSteadyP95GiB)
	}
	if assessment.PhysFootprintPeakGiB == nil || *assessment.PhysFootprintPeakGiB != 6 {
		t.Fatalf("phys_footprint peak = %v, want 6 GiB including load/stop samples", assessment.PhysFootprintPeakGiB)
	}
	if assessment.QualificationEvidence || assessment.QualityEvidence || assessment.ProductStatus != "not-evaluated" {
		t.Fatalf("model-free record became product evidence: %#v", assessment)
	}
	if assessment.WarmupSampleCount != 2 || assessment.MeasuredSampleCount != 2 || assessment.StopSampleCount != 1 {
		t.Fatalf("sample counts = warmup:%d measured:%d stop:%d, want 2/2/1", assessment.WarmupSampleCount, assessment.MeasuredSampleCount, assessment.StopSampleCount)
	}
	if !hasMeasurementFinding(assessment, "TRUSTED_COLLECTOR_UNAVAILABLE") {
		t.Fatalf("measurement report did not retain its trust blocker: %#v", assessment)
	}
}

func TestAnalyzeMeasurementRunRejectsMissingSamplesAndInvalidIntervals(t *testing.T) {
	empty := validMeasurementRun()
	empty.Samples = nil
	if _, err := AnalyzeMeasurementRun(empty); err == nil {
		t.Fatal("missing samples were accepted")
	}

	gap := validMeasurementRun()
	gap.Samples[2].ElapsedMillis = gap.Samples[1].ElapsedMillis + 2_000
	if _, err := AnalyzeMeasurementRun(gap); err == nil {
		t.Fatal("an invalid sample interval was accepted")
	}
}

func TestAnalyzeMeasurementRunRequiresCompleteProcessMembership(t *testing.T) {
	record := validMeasurementRun()
	record.Samples[3].ProcessMembershipComplete = false
	assessment, err := AnalyzeMeasurementRun(record)
	if err != nil {
		t.Fatalf("AnalyzeMeasurementRun() error = %v", err)
	}
	if assessment.ProcessGroupMembershipComplete {
		t.Fatal("incomplete process membership was reported complete")
	}
	if assessment.RSSSteadyP95GiB != nil || assessment.RSSPeakGiB != nil || assessment.PhysFootprintSteadyP95GiB != nil || assessment.PhysFootprintPeakGiB != nil {
		t.Fatalf("partial process group was silently aggregated: %#v", assessment)
	}
	if !hasMeasurementFinding(assessment, "PROCESS_GROUP_MEMBERSHIP_INCOMPLETE") {
		t.Fatalf("missing process-group blocker: %#v", assessment)
	}
}

func TestAnalyzeMeasurementRunRejectsUnsafeRunID(t *testing.T) {
	for _, runID := range []string{"with\nnewline", "contains space", "path/segment", strings.Repeat("a", 129)} {
		t.Run(runID, func(t *testing.T) {
			record := validMeasurementRun()
			record.RunID = runID
			if _, err := AnalyzeMeasurementRun(record); err == nil {
				t.Fatal("unsafe or oversized run ID was accepted")
			}
		})
	}
}

func TestAnalyzeMeasurementRunRejectsInvalidProcessMembership(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*MeasurementRunRecord)
	}{
		{
			name: "duplicate pid",
			mutate: func(record *MeasurementRunRecord) {
				record.Samples[3].Processes = append(record.Samples[3].Processes, record.Samples[3].Processes[1])
			},
		},
		{
			name: "orphan process",
			mutate: func(record *MeasurementRunRecord) {
				record.Samples[3].Processes[1].ParentPID = 999
			},
		},
		{
			name: "changed root identity",
			mutate: func(record *MeasurementRunRecord) {
				record.Samples[3].Processes[0].StartedAtUnixNano++
			},
		},
		{
			name: "direct child predates root",
			mutate: func(record *MeasurementRunRecord) {
				record.Samples[3].Processes[1].StartedAtUnixNano = 999
			},
		},
		{
			name: "nested child predates parent",
			mutate: func(record *MeasurementRunRecord) {
				record.Samples[3].Processes = append(record.Samples[3].Processes, MeasurementProcess{
					PID: 102, ParentPID: 101, StartedAtUnixNano: 1_500,
					RSSBytes: 1, PhysFootprintBytes: measurementUint64(1),
				})
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record := validMeasurementRun()
			test.mutate(&record)
			if _, err := AnalyzeMeasurementRun(record); err == nil {
				t.Fatal("invalid process membership was accepted")
			}
		})
	}
}

func TestAnalyzeMeasurementRunKeepsUnavailableMetricsNull(t *testing.T) {
	record := validMeasurementRun()
	record.Samples[3].Processes[1].PhysFootprintBytes = nil
	record.Samples[3].MemoryPressure = nil
	assessment, err := AnalyzeMeasurementRun(record)
	if err != nil {
		t.Fatalf("AnalyzeMeasurementRun() error = %v", err)
	}
	if assessment.RSSSteadyP95GiB == nil || assessment.PhysFootprintSteadyP95GiB != nil || assessment.PhysFootprintPeakGiB != nil {
		t.Fatalf("missing phys_footprint was inferred or RSS was lost: %#v", assessment)
	}
	if assessment.CriticalMemoryPressureObserved != nil {
		t.Fatalf("missing pressure sample was turned into %t", *assessment.CriticalMemoryPressureObserved)
	}
	if !hasMeasurementFinding(assessment, "PHYS_FOOTPRINT_UNAVAILABLE") || !hasMeasurementFinding(assessment, "MEMORY_PRESSURE_UNAVAILABLE") {
		t.Fatalf("missing resource observations were not made explicit: %#v", assessment)
	}
}

func TestAnalyzeMeasurementRunRejectsTestDoubleAndSyntheticRecords(t *testing.T) {
	t.Run("test double", func(t *testing.T) {
		record := validMeasurementRun()
		record.TestDouble = measurementBool(true)
		record.Synthetic = measurementBool(false)
		assessment, err := AnalyzeMeasurementRun(record)
		if err != nil {
			t.Fatal(err)
		}
		if !hasMeasurementFinding(assessment, "TEST_DOUBLE_EVIDENCE") || assessment.QualificationEvidence {
			t.Fatalf("test double was promoted: %#v", assessment)
		}
	})

	t.Run("synthetic data", func(t *testing.T) {
		record := validMeasurementRun()
		record.TestDouble = measurementBool(false)
		record.Synthetic = measurementBool(true)
		assessment, err := AnalyzeMeasurementRun(record)
		if err != nil {
			t.Fatal(err)
		}
		if !hasMeasurementFinding(assessment, "SYNTHETIC_DATA_EVIDENCE") || assessment.QualificationEvidence {
			t.Fatalf("synthetic data was promoted: %#v", assessment)
		}
	})
}

func TestAnalyzeMeasurementRunBlocksShortDurationAndUnverifiedAccelerator(t *testing.T) {
	record := validMeasurementRun()
	record.Hardware.Chip = "Different Mac"
	record.AcceleratorExecutionVerified = nil
	assessment, err := AnalyzeMeasurementRun(record)
	if err != nil {
		t.Fatalf("AnalyzeMeasurementRun() error = %v", err)
	}
	for _, code := range []string{"MEASUREMENT_DURATION_INCOMPLETE", "TARGET_HARDWARE_NOT_VERIFIED", "ACCELERATOR_EXECUTION_UNVERIFIED"} {
		if !hasMeasurementFinding(assessment, code) {
			t.Errorf("missing blocker %s in %#v", code, assessment.Findings)
		}
	}
	if assessment.QualificationEvidence {
		t.Fatal("untrusted or incomplete measurements became qualification evidence")
	}
}

func TestRunMeasurementCheckStrictlyParsesAndLabelsOutputUntrusted(t *testing.T) {
	encoded, err := json.Marshal(validMeasurementRun())
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	assessment, err := runMeasurementCheck(encoded, &output)
	if err != nil {
		t.Fatalf("runMeasurementCheck() error = %v", err)
	}
	if assessment.QualificationEvidence || assessment.QualityEvidence || !strings.Contains(output.String(), `"productStatus": "not-evaluated"`) {
		t.Fatalf("measurement check output claimed product evidence: %#v, %s", assessment, output.String())
	}
	unknownField := strings.Replace(string(encoded), `"runId":`, `"captionText":"must-not-be-retained","runId":`, 1)
	if _, err := runMeasurementCheck([]byte(unknownField), &strings.Builder{}); err == nil {
		t.Fatal("unknown measurement content field was accepted")
	}
}

func validMeasurementRun() MeasurementRunRecord {
	root := MeasurementProcessIdentity{PID: 100, StartedAtUnixNano: 1_000}
	record := MeasurementRunRecord{
		SchemaVersion: 1,
		RunID:         "model-free-measurement-fixture",
		TestDouble:    measurementBool(true),
		Synthetic:     measurementBool(true),
		Hardware: MeasurementHardware{
			Chip: "Apple M1 Max", UnifiedMemoryGiB: 32, GPUCores: 24,
			Architecture: "arm64", OSVersion: "fixture-os",
		},
		Browser:                      MeasurementBrowser{Name: "Microsoft Edge", Version: "fixture-edge"},
		RootProcess:                  root,
		SampleIntervalMillis:         1_000,
		WarmupDurationMillis:         2_000,
		MeasuredDurationMillis:       2_000,
		ModelReleaseObserved:         true,
		ACConnected:                  measurementBool(true),
		LowPowerModeEnabled:          measurementBool(false),
		AcceleratorExecutionVerified: measurementBool(true),
	}
	for index, sample := range []struct {
		elapsed  int64
		totalGiB uint64
	}{
		{elapsed: 0, totalGiB: 12},
		{elapsed: 1_000, totalGiB: 1},
		{elapsed: 2_000, totalGiB: 1},
		{elapsed: 3_000, totalGiB: 2},
		{elapsed: 4_000, totalGiB: 4},
		{elapsed: 5_000, totalGiB: 12},
	} {
		totalBytes := sample.totalGiB * 1024 * 1024 * 1024
		rootRSS := totalBytes / 2
		childRSS := totalBytes - rootRSS
		totalFootprint := totalBytes / 2
		rootFootprint := totalFootprint / 2
		childFootprint := totalFootprint - rootFootprint
		record.Samples = append(record.Samples, MeasurementSample{
			ElapsedMillis: sample.elapsed, ProcessMembershipComplete: true,
			MemoryPressure: measurementString("normal"), SwapUsedBytes: measurementUint64(uint64(index * 10)),
			Processes: []MeasurementProcess{
				{PID: 100, ParentPID: 1, StartedAtUnixNano: 1_000, RSSBytes: rootRSS, PhysFootprintBytes: measurementUint64(rootFootprint)},
				{PID: 101, ParentPID: 100, StartedAtUnixNano: 2_000, RSSBytes: childRSS, PhysFootprintBytes: measurementUint64(childFootprint)},
			},
		})
	}
	return record
}

func measurementBool(value bool) *bool       { return &value }
func measurementString(value string) *string { return &value }
func measurementUint64(value uint64) *uint64 { return &value }
