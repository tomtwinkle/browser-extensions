//go:build metal

package main

// Apple Metal ビルド用 CGo リンクフラグ (macOS Apple Silicon / Intel)

/*
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/llama.cpp/src -L${SRCDIR}/vendor/build/vendor/whisper.cpp/src -L${SRCDIR}/vendor/build/vendor/llama.cpp/ggml/src
#cgo LDFLAGS: -lllama -lwhisper -lggml -lggml-base -lggml-cpu -lggml-metal -lggml-blas
#cgo LDFLAGS: -lm -lstdc++
#cgo darwin LDFLAGS: -framework Foundation -framework Metal -framework MetalKit
#cgo darwin LDFLAGS: -framework Accelerate -framework CoreGraphics
*/
import "C"
