//go:build !cuda && !metal

package main

// CPU ビルド用 CGo リンクフラグ
//
// Windows では -lstdc++ (→ libstdc++.dll.a) と -static-libstdc++ (→ libstdc++.a) を
// 同時に指定すると多重定義エラーになる。
// そのため OS 別に分離し、Windows は -lstdc++ を省略して
// -static-libstdc++ だけで C++ ランタイムを静的に組み込む。
// これによりビルド済みバイナリは MinGW ランタイム DLL への依存がゼロになる。

/*
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/llama.cpp/src
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/whisper.cpp/src
#cgo LDFLAGS: -L${SRCDIR}/vendor/build/vendor/llama.cpp/ggml/src

#cgo linux   LDFLAGS: -lllama -lwhisper -lggml -lggml-base -lggml-cpu -lm -lstdc++ -fopenmp
#cgo darwin  LDFLAGS: -lllama -lwhisper -lggml -lggml-base -lggml-cpu -lm -lstdc++ -framework Accelerate

#cgo windows LDFLAGS: -lllama -lwhisper -lggml -lggml-base -lggml-cpu -lm
#cgo windows LDFLAGS: -static-libgcc -static-libstdc++ -Wl,-Bstatic -lwinpthread -Wl,-Bdynamic
*/
import "C"
