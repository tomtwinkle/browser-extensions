//go:build !cuda && !metal

package main

// CPU ビルド用 CGo リンクフラグ

/*
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/llama.cpp/src -L${SRCDIR}/vendor/build/vendor/whisper.cpp/src -L${SRCDIR}/vendor/build/vendor/llama.cpp/ggml/src
#cgo LDFLAGS: -lllama -lwhisper -lggml -lggml-base -lggml-cpu -lm -lstdc++
#cgo linux   LDFLAGS: -fopenmp
#cgo darwin  LDFLAGS: -framework Accelerate
#cgo windows LDFLAGS: -static-libgcc -static-libstdc++ -Wl,-Bstatic -lwinpthread -Wl,-Bdynamic
*/
import "C"
