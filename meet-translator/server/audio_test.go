package main

import (
	"math"
	"testing"
)

func TestResampleTo16kPreservesInputWhenAlreadyAtTargetRate(t *testing.T) {
	input := []float32{0.25, -0.5, 0.75}
	got := resampleTo16k(input, whisperSampleRate)
	if len(got) != len(input) || &got[0] != &input[0] {
		t.Fatal("16 kHz input should be returned unchanged")
	}
}

func TestResampleTo16kPreservesDCAndExpectedDuration(t *testing.T) {
	input := make([]float32, 48000)
	for i := range input {
		input[i] = 0.5
	}

	got := resampleTo16k(input, 48000)
	if len(got) != 16000 {
		t.Fatalf("output length = %d, want 16000", len(got))
	}
	for i, sample := range got {
		if math.Abs(float64(sample-0.5)) > 0.005 {
			t.Fatalf("sample %d = %f, want DC level 0.5", i, sample)
		}
	}
}

func TestResampleTo16kKeepsPassbandAndRejectsAliasedTone(t *testing.T) {
	const rate = 48000
	passband := sineWave(rate, 1000, rate)
	stopband := sineWave(rate, 12000, rate)

	passbandOut := resampleTo16k(passband, rate)
	stopbandOut := resampleTo16k(stopband, rate)
	passbandRMS := rms(passbandOut)
	stopbandRMS := rms(stopbandOut)
	if passbandRMS < 0.65 {
		t.Fatalf("1 kHz passband RMS = %f, want > 0.65", passbandRMS)
	}
	if stopbandRMS > 0.02 {
		t.Fatalf("12 kHz aliased RMS = %f, want < 0.02", stopbandRMS)
	}
}

func TestResampleTo16kRoundsOutputLengthAndHandlesEmptyInput(t *testing.T) {
	if got := resampleTo16k(nil, 48000); len(got) != 0 {
		t.Fatalf("empty input produced %d samples", len(got))
	}
	if got := resampleTo16k([]float32{1, 1, 1, 1}, 48000); len(got) != 1 {
		t.Fatalf("output length = %d, want 1", len(got))
	}
}

func sineWave(sampleRate, frequency, count int) []float32 {
	samples := make([]float32, count)
	for i := range samples {
		samples[i] = float32(math.Sin(2 * math.Pi * float64(frequency*i) / float64(sampleRate)))
	}
	return samples
}

func rms(samples []float32) float64 {
	var sum float64
	for _, sample := range samples {
		sum += float64(sample * sample)
	}
	if len(samples) == 0 {
		return 0
	}
	return math.Sqrt(sum / float64(len(samples)))
}
