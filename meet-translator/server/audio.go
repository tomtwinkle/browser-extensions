// audio.go – WAV パーサー & 16kHz リサンプラー
//
// 標準ライブラリのみで実装。
// 拡張機能が送ってくる WAV (PCM 16-bit, mono, 任意サンプルレート) を
// whisper.cpp が要求する float32 / mono / 16kHz に変換する。

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
)

const (
	whisperSampleRate       = 16000
	resampleFilterRadius    = 31
	resampleFilterWindowRad = math.Pi / resampleFilterRadius
)

type wavData struct {
	samples    []float32
	sampleRate uint32
	channels   uint16
}

// parseWAV は WAV バイト列を読み取り、float32 サンプルと基本情報を返す。
// PCM 16-bit (AudioFormat=1) のみサポート。
func parseWAV(r io.Reader) (*wavData, error) {
	// ---- RIFF チャンク ----
	var riffID [4]byte
	if _, err := io.ReadFull(r, riffID[:]); err != nil {
		return nil, errors.New("WAV: failed to read RIFF header")
	}
	if string(riffID[:]) != "RIFF" {
		return nil, fmt.Errorf("WAV: invalid RIFF signature (got: % x)", riffID[:])
	}
	var chunkSize uint32
	if err := binary.Read(r, binary.LittleEndian, &chunkSize); err != nil {
		return nil, err
	}
	var waveID [4]byte
	if _, err := io.ReadFull(r, waveID[:]); err != nil {
		return nil, err
	}
	if string(waveID[:]) != "WAVE" {
		return nil, errors.New("WAV: invalid WAVE signature")
	}

	var (
		audioFormat uint16
		numChannels uint16
		sampleRate  uint32
		bitsPerSamp uint16
	)

	// ---- サブチャンク探索 ----
	for {
		var subID [4]byte
		if _, err := io.ReadFull(r, subID[:]); err != nil {
			if errors.Is(err, io.EOF) {
				return nil, errors.New("WAV: data chunk not found")
			}
			return nil, err
		}
		var subSize uint32
		if err := binary.Read(r, binary.LittleEndian, &subSize); err != nil {
			return nil, err
		}

		switch string(subID[:]) {
		case "fmt ":
			if err := binary.Read(r, binary.LittleEndian, &audioFormat); err != nil {
				return nil, err
			}
			if audioFormat != 1 {
				return nil, errors.New("WAV: only PCM format is supported")
			}
			if err := binary.Read(r, binary.LittleEndian, &numChannels); err != nil {
				return nil, err
			}
			if numChannels == 0 {
				return nil, errors.New("WAV: channel count must be greater than zero")
			}
			if err := binary.Read(r, binary.LittleEndian, &sampleRate); err != nil {
				return nil, err
			}
			// byteRate + blockAlign をスキップ
			var skip [6]byte
			if _, err := io.ReadFull(r, skip[:]); err != nil {
				return nil, err
			}
			if err := binary.Read(r, binary.LittleEndian, &bitsPerSamp); err != nil {
				return nil, err
			}
			// fmt チャンクの残りをスキップ（拡張フィールド等）
			extra := int(subSize) - 16
			if extra > 0 {
				if _, err := io.CopyN(io.Discard, r, int64(extra)); err != nil {
					return nil, err
				}
			}

		case "data":
			if sampleRate == 0 {
				return nil, errors.New("WAV: data chunk appeared before fmt chunk")
			}
			if bitsPerSamp != 16 {
				return nil, errors.New("WAV: only 16-bit PCM is supported")
			}
			numSamples := int(subSize) / 2
			pcm16 := make([]int16, numSamples)
			if err := binary.Read(r, binary.LittleEndian, pcm16); err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
				return nil, err
			}
			// ステレオ→モノラル（L+R 平均）、int16→float32
			samples := make([]float32, numSamples/int(numChannels))
			if numChannels == 1 {
				for i, s := range pcm16 {
					samples[i] = float32(s) / 32768.0
				}
			} else {
				for i := range samples {
					var sum float32
					for ch := 0; ch < int(numChannels); ch++ {
						sum += float32(pcm16[i*int(numChannels)+ch])
					}
					samples[i] = sum / float32(numChannels) / 32768.0
				}
			}
			return &wavData{samples: samples, sampleRate: sampleRate, channels: numChannels}, nil

		default:
			// 未知のチャンクはスキップ
			if _, err := io.CopyN(io.Discard, r, int64(subSize)); err != nil {
				return nil, err
			}
		}
	}
}

// resampleTo16k は窓付きsinc FIRフィルターでfloat32サンプル列を
// 16kHzにリサンプリングする。ダウンサンプリング時はナイキスト周波数より
// 手前でローパスし、折り返し成分が音声帯域へ混入するのを抑える。
func resampleTo16k(samples []float32, srcRate uint32) []float32 {
	if srcRate == whisperSampleRate {
		return samples
	}
	if srcRate == 0 || len(samples) == 0 {
		return nil
	}
	ratio := float64(srcRate) / float64(whisperSampleRate)
	outLen := int(math.Round(float64(len(samples)) / ratio))
	if outLen == 0 {
		return nil
	}
	out := make([]float32, outLen)
	cutoff := 0.45 / math.Max(1, ratio)
	for i := range out {
		pos := float64(i) * ratio
		center := int(math.Floor(pos))
		start := max(0, center-resampleFilterRadius)
		end := min(len(samples)-1, center+resampleFilterRadius)
		var weightedSum, weightSum float64
		for sampleIndex := start; sampleIndex <= end; sampleIndex++ {
			distance := float64(sampleIndex) - pos
			window := 0.54 + 0.46*math.Cos(resampleFilterWindowRad*distance)
			weight := 2 * cutoff * sinc(2*cutoff*distance) * window
			weightedSum += float64(samples[sampleIndex]) * weight
			weightSum += weight
		}
		if math.Abs(weightSum) > 1e-12 {
			out[i] = float32(weightedSum / weightSum)
		}
	}
	return out
}

func sinc(value float64) float64 {
	if math.Abs(value) < 1e-12 {
		return 1
	}
	return math.Sin(math.Pi*value) / (math.Pi * value)
}
