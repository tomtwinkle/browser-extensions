// model_options.go – モデル別オプション定義
//
// リクエスト毎に指定できるモデル固有の設定。
// llama_options フォームフィールドに JSON 文字列として渡す。
// 例: {"thinking":false}

package main

import "encoding/json"

// ModelOptions はリクエスト毎に指定できるモデル固有の設定。
type ModelOptions struct {
	// Thinking は /no_think を正式サポートするQwen3モデルの設定。
	// Qwen3.5ではAPI側のenable_thinkingを渡せないため、このオプションを使わない。
	Thinking bool `json:"thinking"`
}

// parseModelOptions は JSON 文字列を ModelOptions にパースする。
// 空文字または無効な JSON の場合はモデル名に基づくデフォルト値を返す。
func parseModelOptions(raw, modelName string) ModelOptions {
	defaults := defaultModelOptions(modelName)
	if raw == "" {
		return defaults
	}
	var opts ModelOptions
	if err := json.Unmarshal([]byte(raw), &opts); err != nil {
		return defaults
	}
	return opts
}

// defaultModelOptions はモデル名に基づくデフォルトオプションを返す。
func defaultModelOptions(modelName string) ModelOptions {
	if hasThinkingSupport(modelName) {
		return ModelOptions{Thinking: true}
	}
	return ModelOptions{}
}
