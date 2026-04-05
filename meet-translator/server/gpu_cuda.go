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

// gpuAvailable は CUDA GPU が利用可能であることを示す。
func gpuAvailable() bool { return true }
