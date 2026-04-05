// server_config.go – 設定ファイルの永続化
//
// 初回起動時に --whisper-model / --llama-model 等を指定すると
// OS 標準のコンフィグディレクトリに config.json として保存される。
// 次回以降はフラグなしで起動しても前回の設定が自動的に読み込まれる。
//
// 保存先:
//   Linux   : $XDG_CONFIG_HOME/meet-translator/config.json
//             (未設定時: ~/.config/meet-translator/config.json)
//   macOS   : ~/Library/Application Support/meet-translator/config.json
//   Windows : %APPDATA%\meet-translator\config.json
//   上書き  : --config フラグ または MEET_TRANSLATOR_CONFIG 環境変数
//
// 優先度 (高→低):
//   CLI フラグ > config ファイル > 環境変数 > デフォルト値

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

// persistedConfig は config.json に書き出す設定。
// omitempty で未設定フィールドは保存しない。
type persistedConfig struct {
	Port             string `json:"port,omitempty"`
	WhisperModel     string `json:"whisper_model,omitempty"`
	LlamaModel       string `json:"llama_model,omitempty"`
	LlamaGPULayers   *int   `json:"llama_gpu_layers,omitempty"`
	WhisperGPULayers *int   `json:"whisper_gpu_layers,omitempty"`
	ModelCacheDir    string `json:"model_cache_dir,omitempty"`
}

// configDir はプラットフォーム標準のコンフィグディレクトリを返す。
func configDir() string {
	var base string
	switch runtime.GOOS {
	case "windows":
		base = os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Roaming")
		}
	case "darwin":
		base = filepath.Join(os.Getenv("HOME"), "Library", "Application Support")
	default: // linux / other
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			base = xdg
		} else {
			base = filepath.Join(os.Getenv("HOME"), ".config")
		}
	}
	return filepath.Join(base, "meet-translator")
}

// configFilePath は config.json のフルパスを返す。
// MEET_TRANSLATOR_CONFIG 環境変数で上書き可能。
func configFilePath() string {
	if p := os.Getenv("MEET_TRANSLATOR_CONFIG"); p != "" {
		return p
	}
	return filepath.Join(configDir(), "config.json")
}

// loadConfigFile は config.json を読み込む。
// ファイルが存在しない場合はゼロ値の persistedConfig を返す (エラーなし)。
func loadConfigFile() (persistedConfig, error) {
	data, err := os.ReadFile(configFilePath())
	if os.IsNotExist(err) {
		return persistedConfig{}, nil
	}
	if err != nil {
		return persistedConfig{}, err
	}
	var cfg persistedConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return persistedConfig{}, err
	}
	return cfg, nil
}

// saveConfigFile は cfg を config.json に書き出す。
func saveConfigFile(cfg persistedConfig) error {
	path := configFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o640)
}

// configFileExists は config.json が存在するかどうかを返す。
func configFileExists() bool {
	_, err := os.Stat(configFilePath())
	return err == nil
}
