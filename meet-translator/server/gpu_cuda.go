//go:build cuda

package main

// NVIDIA CUDA ビルド用 CGo リンクフラグ

/*
#cgo LDFLAGS: -lllama -lwhisper -lggml -lggml-base -lggml-cpu -lggml-cuda
#cgo LDFLAGS: -lm -lstdc++ -lcublas -lcublasLt -lcudart
#cgo linux LDFLAGS: -fopenmp
*/
import "C"
