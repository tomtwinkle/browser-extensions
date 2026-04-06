// dataset.go — LLM 翻訳ベンチマーク用テストケース
//
// Google Meet での英語⇔日本語会議翻訳ユースケースを想定。
// EN→JA / JA→EN の双方向で各 20 件、計 40 件を収録している。

package main

// BenchCase はベンチマークの単一テストケース。
type BenchCase struct {
	ID        string
	Input     string
	Source    string // 翻訳元言語コード (例: "en")
	Target    string // 翻訳先言語コード (例: "ja")
	Reference string // 参照翻訳 (品質評価の正解)
	Category  string // "greeting" | "technical" | "action" | "question" | "complex"
}

// enToJaDataset は英語→日本語テストケース群。
var enToJaDataset = []BenchCase{
	// ── グリーティング / 日常会話 ─────────────────────────────────────────
	{
		ID:        "ej-g01",
		Input:     "Let's get started.",
		Source:    "en",
		Target:    "ja",
		Reference: "始めましょう。",
		Category:  "greeting",
	},
	{
		ID:        "ej-g02",
		Input:     "Can everyone hear me?",
		Source:    "en",
		Target:    "ja",
		Reference: "みなさん聞こえますか？",
		Category:  "greeting",
	},
	{
		ID:        "ej-g03",
		Input:     "I'll share my screen now.",
		Source:    "en",
		Target:    "ja",
		Reference: "今から画面を共有します。",
		Category:  "greeting",
	},
	{
		ID:        "ej-g04",
		Input:     "Let me know if you have any questions.",
		Source:    "en",
		Target:    "ja",
		Reference: "ご質問があればお知らせください。",
		Category:  "greeting",
	},
	// ── 技術用語 ─────────────────────────────────────────────────────────
	{
		ID:        "ej-t01",
		Input:     "Please review the pull request.",
		Source:    "en",
		Target:    "ja",
		Reference: "プルリクエストをレビューしてください。",
		Category:  "technical",
	},
	{
		ID:        "ej-t02",
		Input:     "We need to fix this bug before the deployment.",
		Source:    "en",
		Target:    "ja",
		Reference: "デプロイ前にこのバグを修正する必要があります。",
		Category:  "technical",
	},
	{
		ID:        "ej-t03",
		Input:     "The API endpoint is returning a 500 error.",
		Source:    "en",
		Target:    "ja",
		Reference: "APIエンドポイントが500エラーを返しています。",
		Category:  "technical",
	},
	{
		ID:        "ej-t04",
		Input:     "We should refactor the authentication module.",
		Source:    "en",
		Target:    "ja",
		Reference: "認証モジュールをリファクタリングすべきです。",
		Category:  "technical",
	},
	{
		ID:        "ej-t05",
		Input:     "The CI pipeline failed on the last commit.",
		Source:    "en",
		Target:    "ja",
		Reference: "最後のコミットでCIパイプラインが失敗しました。",
		Category:  "technical",
	},
	{
		ID:        "ej-t06",
		Input:     "Please merge after the code review is done.",
		Source:    "en",
		Target:    "ja",
		Reference: "コードレビューが終わったらマージしてください。",
		Category:  "technical",
	},
	// ── アクション / 依頼 ─────────────────────────────────────────────────
	{
		ID:        "ej-a01",
		Input:     "Can you write the test cases?",
		Source:    "en",
		Target:    "ja",
		Reference: "テストケースを書いてもらえますか？",
		Category:  "action",
	},
	{
		ID:        "ej-a02",
		Input:     "We need to update the documentation.",
		Source:    "en",
		Target:    "ja",
		Reference: "ドキュメントを更新する必要があります。",
		Category:  "action",
	},
	{
		ID:        "ej-a03",
		Input:     "Please push your changes to the feature branch.",
		Source:    "en",
		Target:    "ja",
		Reference: "変更をフィーチャーブランチにプッシュしてください。",
		Category:  "action",
	},
	{
		ID:        "ej-a04",
		Input:     "Let's schedule a follow-up meeting for next week.",
		Source:    "en",
		Target:    "ja",
		Reference: "来週フォローアップミーティングをスケジュールしましょう。",
		Category:  "action",
	},
	// ── 質問 ─────────────────────────────────────────────────────────────
	{
		ID:        "ej-q01",
		Input:     "What is the estimated time of completion?",
		Source:    "en",
		Target:    "ja",
		Reference: "完了予定時間はいつですか？",
		Category:  "question",
	},
	{
		ID:        "ej-q02",
		Input:     "Who is responsible for this task?",
		Source:    "en",
		Target:    "ja",
		Reference: "このタスクの担当者は誰ですか？",
		Category:  "question",
	},
	{
		ID:        "ej-q03",
		Input:     "Have you tested this on the production environment?",
		Source:    "en",
		Target:    "ja",
		Reference: "本番環境でテストしましたか？",
		Category:  "question",
	},
	{
		ID:        "ej-q04",
		Input:     "Is the database migration reversible?",
		Source:    "en",
		Target:    "ja",
		Reference: "データベースマイグレーションは元に戻せますか？",
		Category:  "question",
	},
	// ── 複合文 ───────────────────────────────────────────────────────────
	{
		ID:        "ej-c01",
		Input:     "The sprint ends on Friday and we have three tasks remaining.",
		Source:    "en",
		Target:    "ja",
		Reference: "スプリントは金曜日に終わります。残りタスクは3つです。",
		Category:  "complex",
	},
	{
		ID:        "ej-c02",
		Input:     "We should deploy on Tuesday after running all integration tests.",
		Source:    "en",
		Target:    "ja",
		Reference: "統合テストをすべて実行した後、火曜日にデプロイすべきです。",
		Category:  "complex",
	},
}

// jaToEnDataset は日本語→英語テストケース群。
// EN→JA の対訳を逆にしたものを基本としつつ、自然な日本語表現を使用している。
var jaToEnDataset = []BenchCase{
	// ── グリーティング / 日常会話 ─────────────────────────────────────────
	{
		ID:        "je-g01",
		Input:     "始めましょう。",
		Source:    "ja",
		Target:    "en",
		Reference: "Let's get started.",
		Category:  "greeting",
	},
	{
		ID:        "je-g02",
		Input:     "みなさん聞こえますか？",
		Source:    "ja",
		Target:    "en",
		Reference: "Can everyone hear me?",
		Category:  "greeting",
	},
	{
		ID:        "je-g03",
		Input:     "今から画面を共有します。",
		Source:    "ja",
		Target:    "en",
		Reference: "I'll share my screen now.",
		Category:  "greeting",
	},
	{
		ID:        "je-g04",
		Input:     "ご質問があればお知らせください。",
		Source:    "ja",
		Target:    "en",
		Reference: "Let me know if you have any questions.",
		Category:  "greeting",
	},
	// ── 技術用語 ─────────────────────────────────────────────────────────
	{
		ID:        "je-t01",
		Input:     "プルリクエストをレビューしてください。",
		Source:    "ja",
		Target:    "en",
		Reference: "Please review the pull request.",
		Category:  "technical",
	},
	{
		ID:        "je-t02",
		Input:     "デプロイ前にこのバグを修正する必要があります。",
		Source:    "ja",
		Target:    "en",
		Reference: "We need to fix this bug before the deployment.",
		Category:  "technical",
	},
	{
		ID:        "je-t03",
		Input:     "APIエンドポイントが500エラーを返しています。",
		Source:    "ja",
		Target:    "en",
		Reference: "The API endpoint is returning a 500 error.",
		Category:  "technical",
	},
	{
		ID:        "je-t04",
		Input:     "認証モジュールをリファクタリングすべきです。",
		Source:    "ja",
		Target:    "en",
		Reference: "We should refactor the authentication module.",
		Category:  "technical",
	},
	{
		ID:        "je-t05",
		Input:     "最後のコミットでCIパイプラインが失敗しました。",
		Source:    "ja",
		Target:    "en",
		Reference: "The CI pipeline failed on the last commit.",
		Category:  "technical",
	},
	{
		ID:        "je-t06",
		Input:     "コードレビューが終わったらマージしてください。",
		Source:    "ja",
		Target:    "en",
		Reference: "Please merge after the code review is done.",
		Category:  "technical",
	},
	// ── アクション / 依頼 ─────────────────────────────────────────────────
	{
		ID:        "je-a01",
		Input:     "テストケースを書いてもらえますか？",
		Source:    "ja",
		Target:    "en",
		Reference: "Can you write the test cases?",
		Category:  "action",
	},
	{
		ID:        "je-a02",
		Input:     "ドキュメントを更新する必要があります。",
		Source:    "ja",
		Target:    "en",
		Reference: "We need to update the documentation.",
		Category:  "action",
	},
	{
		ID:        "je-a03",
		Input:     "変更をフィーチャーブランチにプッシュしてください。",
		Source:    "ja",
		Target:    "en",
		Reference: "Please push your changes to the feature branch.",
		Category:  "action",
	},
	{
		ID:        "je-a04",
		Input:     "来週フォローアップミーティングをスケジュールしましょう。",
		Source:    "ja",
		Target:    "en",
		Reference: "Let's schedule a follow-up meeting for next week.",
		Category:  "action",
	},
	// ── 質問 ─────────────────────────────────────────────────────────────
	{
		ID:        "je-q01",
		Input:     "完了予定時間はいつですか？",
		Source:    "ja",
		Target:    "en",
		Reference: "What is the estimated time of completion?",
		Category:  "question",
	},
	{
		ID:        "je-q02",
		Input:     "このタスクの担当者は誰ですか？",
		Source:    "ja",
		Target:    "en",
		Reference: "Who is responsible for this task?",
		Category:  "question",
	},
	{
		ID:        "je-q03",
		Input:     "本番環境でテストしましたか？",
		Source:    "ja",
		Target:    "en",
		Reference: "Have you tested this on the production environment?",
		Category:  "question",
	},
	{
		ID:        "je-q04",
		Input:     "データベースマイグレーションは元に戻せますか？",
		Source:    "ja",
		Target:    "en",
		Reference: "Is the database migration reversible?",
		Category:  "question",
	},
	// ── 複合文 ───────────────────────────────────────────────────────────
	{
		ID:        "je-c01",
		Input:     "スプリントは金曜日に終わります。残りタスクは3つです。",
		Source:    "ja",
		Target:    "en",
		Reference: "The sprint ends on Friday and we have three tasks remaining.",
		Category:  "complex",
	},
	{
		ID:        "je-c02",
		Input:     "統合テストをすべて実行した後、火曜日にデプロイすべきです。",
		Source:    "ja",
		Target:    "en",
		Reference: "We should deploy on Tuesday after running all integration tests.",
		Category:  "complex",
	},
}

// meetingDataset は EN→JA と JA→EN を合わせた全テストケース (計 40 件)。
var meetingDataset = append(enToJaDataset, jaToEnDataset...)
