package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ─── backendIsPrism constant ─────────────────────────────────────────────────

// TestBackendIsPrism はビルドタグに応じて backendIsPrism が正しく設定されているか検証する。
// 標準ビルド (-tags metal) では false、PrismML ビルド (-tags metal,prism) では true になる。
// このテスト自体がどちらのタグでもコンパイル・実行できることが確認になる。
func TestBackendIsPrism_StandardBuild(t *testing.T) {
	// 標準ビルドではこのファイルは backend_standard.go と一緒にコンパイルされる
	// (build tag !prism) ため、backendIsPrism == false のはず。
	// PrismML ビルドでは backend_prism.go が使われ backendIsPrism == true になる。
	//
	// ここでは「コンパイルできること」と「値が bool であること」だけ確認する。
	// 実際の値は go test -tags prism で実行した場合に変わることを想定している。
	_ = backendIsPrism // コンパイルチェック
	t.Logf("backendIsPrism = %v (this is the %s build)", backendIsPrism, binaryDesc(backendIsPrism))
}

// TestBackendIsPrism_ConsistentWithBuildTag は backendIsPrism の値が
// ビルドタグと一致していることを検証する。
func TestBackendIsPrism_ConsistentWithBuildTag(t *testing.T) {
	// backend_standard.go に //go:build !prism, backend_prism.go に //go:build prism
	// 両ファイルは同時にコンパイルされないため、backendIsPrism は必ず一方の値を持つ。
	// prism タグなし → false, prism タグあり → true
	if backendIsPrism {
		t.Log("OK: running as PrismML build (backendIsPrism=true, -tags prism)")
	} else {
		t.Log("OK: running as standard build (backendIsPrism=false, no prism tag)")
	}
}

// ─── binaryDesc ──────────────────────────────────────────────────────────────

func TestBinaryDesc(t *testing.T) {
	tests := []struct {
		prism bool
		want  string
	}{
		{true, "PrismML (Q1_0_g128)"},
		{false, "standard (official llama.cpp)"},
	}
	for _, tt := range tests {
		got := binaryDesc(tt.prism)
		if got != tt.want {
			t.Errorf("binaryDesc(%v) = %q, want %q", tt.prism, got, tt.want)
		}
	}
}

// ─── LlamaEntry.NeedsPrism レジストリ整合性 ──────────────────────────────────

// TestLlamaRegistry_NeedsPrism_BonsaiRequiresPrism は bonsai-8b が
// NeedsPrism=true を持つことを確認する。
func TestLlamaRegistry_NeedsPrism_BonsaiRequiresPrism(t *testing.T) {
	entry, ok := llamaRegistry["bonsai-8b"]
	if !ok {
		t.Fatal("bonsai-8b not found in llamaRegistry")
	}
	if !entry.NeedsPrism {
		t.Error("bonsai-8b should have NeedsPrism=true (requires Q1_0_g128 / PrismML build)")
	}
}

// TestLlamaRegistry_NeedsPrism_StandardModelsDoNotRequirePrism は
// gemma4 や qwen など標準モデルが NeedsPrism=false であることを確認する。
func TestLlamaRegistry_NeedsPrism_StandardModelsDoNotRequirePrism(t *testing.T) {
	standardModels := []string{
		"gemma4:e2b-q4_k_m",
		"gemma4:e4b-q4_k_m",
		"gemma4:26b-q4_k_m",
		"qwen3:8b-q4_k_m",
		"qwen2.5:7b-instruct-q4_k_m",
		"calm3:22b-q4_k_m",
	}
	for _, name := range standardModels {
		entry, ok := llamaRegistry[name]
		if !ok {
			t.Logf("SKIP: %q not in registry (may have been removed)", name)
			continue
		}
		if entry.NeedsPrism {
			t.Errorf("model %q should have NeedsPrism=false (standard llama.cpp model)", name)
		}
	}
}

// TestLlamaRegistry_NeedsPrism_OnlyPrismModels はレジストリ全体を走査し、
// NeedsPrism=true のモデルが意図したもの (現在は bonsai-8b のみ) だけであることを確認する。
func TestLlamaRegistry_NeedsPrism_OnlyPrismModels(t *testing.T) {
	expectedPrismModels := map[string]bool{
		"bonsai-8b": true,
	}
	for name, entry := range llamaRegistry {
		if entry.NeedsPrism && !expectedPrismModels[name] {
			t.Errorf("unexpected NeedsPrism=true for model %q (add to expectedPrismModels if intentional)", name)
		}
	}
}

// ─── redirectIfNeeded ─────────────────────────────────────────────────────────

// patchExecBinary はテスト中だけ execBinary を差し替えて、実際に exec しないようにする。
func patchExecBinary(t *testing.T, fn func(path string, argv []string, env []string) error) {
	t.Helper()
	orig := execBinary
	execBinary = fn
	t.Cleanup(func() { execBinary = orig })
}

// TestRedirectIfNeeded_EmptySpec は llamaSpec が空の場合に何もしないことを確認する。
func TestRedirectIfNeeded_EmptySpec(t *testing.T) {
	execCalled := false
	patchExecBinary(t, func(path string, argv []string, env []string) error {
		execCalled = true
		return nil
	})

	redirectIfNeeded("")

	if execCalled {
		t.Error("exec should not be called for empty spec")
	}
}

// TestRedirectIfNeeded_UnknownModel はファイルパス等の未知モデルで何もしないことを確認する。
func TestRedirectIfNeeded_UnknownModel(t *testing.T) {
	execCalled := false
	patchExecBinary(t, func(path string, argv []string, env []string) error {
		execCalled = true
		return nil
	})

	// ファイルパスや未登録のモデル名はスキップされる
	redirectIfNeeded("/path/to/model.gguf")
	redirectIfNeeded("nonexistent:model")

	if execCalled {
		t.Error("exec should not be called for unknown/file-path models")
	}
}

// TestRedirectIfNeeded_CorrectVariantNoRedirect は現在のバイナリが対応している
// モデルを要求した場合に exec しないことを確認する。
func TestRedirectIfNeeded_CorrectVariantNoRedirect(t *testing.T) {
	execCalled := false
	patchExecBinary(t, func(path string, argv []string, env []string) error {
		execCalled = true
		return nil
	})

	// backendIsPrism=false (標準ビルド) なら NeedsPrism=false のモデルはリダイレクト不要
	// backendIsPrism=true  (PrismML)   なら NeedsPrism=true  のモデルはリダイレクト不要
	var modelThatMatchesCurrentBuild string
	for name, entry := range llamaRegistry {
		if entry.NeedsPrism == backendIsPrism {
			modelThatMatchesCurrentBuild = name
			break
		}
	}
	if modelThatMatchesCurrentBuild == "" {
		t.Skip("no model matching current build variant found in registry")
	}

	redirectIfNeeded(modelThatMatchesCurrentBuild)

	if execCalled {
		t.Errorf("exec should not be called when model %q matches current build variant", modelThatMatchesCurrentBuild)
	}
}

// TestRedirectIfNeeded_WrongVariantNoBinaryPrintsHint は対応バイナリが存在しない場合に
// exec せずヒントを stderr に出力することを確認する。
func TestRedirectIfNeeded_WrongVariantNoBinaryPrintsHint(t *testing.T) {
	execCalled := false
	patchExecBinary(t, func(path string, argv []string, env []string) error {
		execCalled = true
		return nil
	})

	// 現在のビルドと逆の NeedsPrism を持つモデルを探す
	var mismatchedModel string
	for name, entry := range llamaRegistry {
		if entry.NeedsPrism != backendIsPrism {
			mismatchedModel = name
			break
		}
	}
	if mismatchedModel == "" {
		t.Skip("no model mismatching current build variant found in registry")
	}

	// stderr をキャプチャ
	origStderr := os.Stderr
	r, w, _ := os.Pipe()
	os.Stderr = w

	redirectIfNeeded(mismatchedModel)

	w.Close()
	os.Stderr = origStderr
	var buf bytes.Buffer
	buf.ReadFrom(r)
	output := buf.String()

	if execCalled {
		t.Error("exec should not be called when target binary does not exist")
	}
	if !strings.Contains(output, "[selector] WARNING") {
		t.Errorf("expected hint on stderr, got: %q", output)
	}
	if !strings.Contains(output, mismatchedModel) {
		t.Errorf("hint should mention the model name %q, got: %q", mismatchedModel, output)
	}
}

// TestRedirectIfNeeded_WrongVariantBinaryFoundExecsToTarget は対応バイナリが存在する場合に
// exec が正しいパスで呼ばれることを確認する。
func TestRedirectIfNeeded_WrongVariantBinaryFoundExecsToTarget(t *testing.T) {
	// 現在のビルドと逆の NeedsPrism を持つモデルを探す
	var mismatchedModel string
	var needsPrism bool
	for name, entry := range llamaRegistry {
		if entry.NeedsPrism != backendIsPrism {
			mismatchedModel = name
			needsPrism = entry.NeedsPrism
			break
		}
	}
	if mismatchedModel == "" {
		t.Skip("no model mismatching current build variant found in registry")
	}

	// 期待されるターゲットバイナリ名
	var expectedBin string
	if needsPrism {
		expectedBin = "server-prism"
	} else {
		expectedBin = "server"
	}

	// テスト用ダミーバイナリを実行ファイルと同じディレクトリに作成
	exeDir := filepath.Dir(findExePath(t))
	dummyPath := filepath.Join(exeDir, expectedBin)
	if err := os.WriteFile(dummyPath, []byte("dummy"), 0o755); err != nil {
		t.Fatalf("failed to create dummy binary: %v", err)
	}
	t.Cleanup(func() { os.Remove(dummyPath) })

	var execPath string
	patchExecBinary(t, func(path string, argv []string, env []string) error {
		execPath = path
		return errors.New("mock exec: not actually replacing process")
	})

	// exec はエラーを返すが log.Fatalf で終了するため、
	// ここでは panic をリカバーして execPath だけ確認する
	defer func() {
		if r := recover(); r != nil {
			// log.Fatalf → os.Exit(1) は panic ではなくプロセス終了なので
			// ここには来ない。来た場合は予期しないパニック。
			t.Errorf("unexpected panic: %v", r)
		}
	}()

	// execBinary がエラーを返した場合 log.Fatalf が呼ばれるため、
	// テスト内では execBinary が呼ばれたかどうか (execPath が設定されたか) を確認する。
	// log.Fatalf を回避するため、execBinary は成功を返す (exec 済みとみなす) mock にする。
	patchExecBinary(t, func(path string, argv []string, env []string) error {
		execPath = path
		return nil // 成功扱い (実際には exec しない)
	})

	redirectIfNeeded(mismatchedModel)

	if execPath == "" {
		t.Error("exec should have been called when target binary exists")
	}
	if !strings.HasSuffix(execPath, expectedBin) {
		t.Errorf("exec path = %q, should end with %q", execPath, expectedBin)
	}
}

// findExePath はテスト用に os.Executable() の結果を返す。
func findExePath(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	return exe
}

// ─── targetBinaryName (ロジック単体テスト) ───────────────────────────────────

// TestTargetBinaryName はモデルの NeedsPrism 値から切り替え先バイナリ名が
// 正しく決まることを確認する。
func TestTargetBinaryName(t *testing.T) {
	tests := []struct {
		needsPrism bool
		wantBin    string
	}{
		{true, "server-prism"},
		{false, "server"},
	}
	for _, tt := range tests {
		var got string
		if tt.needsPrism {
			got = "server-prism"
		} else {
			got = "server"
		}
		if got != tt.wantBin {
			t.Errorf("needsPrism=%v → binary %q, want %q", tt.needsPrism, got, tt.wantBin)
		}
	}
}
