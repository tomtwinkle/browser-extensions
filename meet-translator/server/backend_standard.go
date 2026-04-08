//go:build !prism

package main

// backendIsPrism は PrismML ビルド (Q1_0_g128 対応) かどうかを示す。
// 標準ビルド (公式 ggml-org/llama.cpp) では false。
const backendIsPrism = false
