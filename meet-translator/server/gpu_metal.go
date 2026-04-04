//go:build metal

package main

// Apple Metal ビルド用 CGo リンクフラグ (macOS Apple Silicon / Intel)

/*
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/src -L${SRCDIR}/vendor/build/ggml/src -L${SRCDIR}/vendor/build/ggml/src/ggml-metal -L${SRCDIR}/vendor/build/ggml/src/ggml-blas
#cgo LDFLAGS: -lllama -lwhisper -lggml -lggml-base -lggml-cpu -lggml-metal -lggml-blas
#cgo LDFLAGS: -lm -lstdc++
#cgo darwin LDFLAGS: -framework Foundation -framework Metal -framework MetalKit
#cgo darwin LDFLAGS: -framework Accelerate -framework CoreGraphics
*/
import "C"
