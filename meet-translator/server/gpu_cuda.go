//go:build cuda

package main

// NVIDIA CUDA ビルド用 CGo リンクフラグ

/*
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/llama.cpp/src -L${SRCDIR}/vendor/build/vendor/whisper.cpp/src -L${SRCDIR}/vendor/build/vendor/llama.cpp/ggml/src
#cgo LDFLAGS: -lllama -lwhisper -lggml -lggml-base -lggml-cpu -lggml-cuda
#cgo LDFLAGS: -lm -lstdc++ -lcublas -lcublasLt -lcudart
#cgo linux LDFLAGS: -fopenmp
*/
import "C"
