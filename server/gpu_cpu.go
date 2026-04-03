//go:build !cuda && !metal

package main

// CPU ビルド用 CGo リンクフラグ

/*
#cgo LDFLAGS: -lllama -lwhisper -lggml -lggml-base -lggml-cpu -lm -lstdc++
#cgo linux   LDFLAGS: -fopenmp
#cgo windows LDFLAGS: -static-libstdc++ -static-libgcc
*/
import "C"
