//go:build metal

package main

// Apple Metal ビルド用 CGo リンクフラグ (macOS Apple Silicon / Intel)

/*
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/llama.cpp/src
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/whisper.cpp/src
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/llama.cpp/ggml/src
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/llama.cpp/ggml/src/ggml-metal
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/llama.cpp/ggml/src/ggml-blas
#cgo LDFLAGS: -lllama -lwhisper -lggml -lggml-base -lggml-cpu -lggml-metal -lggml-blas
#cgo LDFLAGS: -lm -lstdc++
#cgo darwin LDFLAGS: -framework Foundation -framework Metal -framework MetalKit
#cgo darwin LDFLAGS: -framework Accelerate -framework CoreGraphics
*/
import "C"

// gpuAvailable は Metal GPU が利用可能であることを示す。
func gpuAvailable() bool { return true }
