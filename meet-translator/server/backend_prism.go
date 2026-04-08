//go:build prism

package main

// backendIsPrism は PrismML ビルド (Q1_0_g128 対応) かどうかを示す。
// PrismML ビルド (make prism) では true。
// このビルドは bonsai-8b など Q1_0_g128 量子化モデルをサポートするが、
// 代わりに gemma4 アーキテクチャはサポートしない。
const backendIsPrism = true
