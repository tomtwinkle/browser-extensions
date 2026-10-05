# 実装状況

更新日: 2026-10-05

対象: `meet-translator/`

作業開始時HEAD: `6ac37a149a0314ba1b989a1c1f66d5dedf35ff47` (`main`)

作業開始時作業ツリー: 既存の未コミット変更があった。内容を維持し、開始時HEADとともに追跡した。

### 継続作業チェックポイント (2026-09-30)

- 継続開始時HEAD: `296bd08c7cae71a57050e8af4638d63cc7852d64` (`feat/meet-translator-local-evaluation`)。開始時点で変更済み19 tracked files、未追跡4 files、staged changesなし。既存差分を破棄・置換していない。
- C1: 仕様済みの翻訳queue上限8件、待機3秒超・有声終端から8秒超の失効を実装し、ADR 0013へ記録。訂正翻訳は字幕record取得直後にpending枠を確保してserial audio laneを待ち、翻訳完了まで次のASRを止める。audio lane内callback backlogも別途8件に制限し、期限切れjobのcallbackはlane到達時に推論せず破棄する。期限切れ項目は新規admission前にも枠を解放する。原文を保って訳だけfailedにする。private訂正UIは音声・翻訳の累積総数/秒数と最新区分を分け、混在した失敗理由を誤って単一理由の件数として表示しない。
- Server single-flight key fingerprints the exact context-history snapshot used to build each prompt. C2 adds a server-wide capacity-one lane shared by ASR, translation, and raw LLM generation; a canceled waiter leaves before native inference, while an active synchronous native call retains the permit until it returns. Deadline ordering, durable telemetry, and adaptive load controls remain incomplete.
- 今回のR23一次資料調査は`NO_MATERIAL_CHANGE`。10候補はすべて`DEFERRED`、選定モデルなし、`PROFILE_NOT_QUALIFIED`を維持。
- Edgeは別の実会議で参加者がいる状態だったため、この継続中にA/Bを実行していない。Edge、Meet、拡張、mediaの状態は操作しておらず、会議識別情報を記録しない。


### 継続作業チェックポイント (R23/C2, 2026-09-30)

- 継続開始時HEAD: `575c1c8485e6ec64b11a41f1896d9604c08ce810` (`feat/meet-translator-local-evaluation`)。開始時worktreeはclean。新規変更を追加し、既存差分の破棄・置換はしていない。
- C2: `/transcribe`、`/transcribe-and-translate`、`/translate`、raw LLM generationを共通容量1 inference gateで包み、ネイティブ演算の同期呼出しが戻るまでpermitを保持する。モデル切替/LLM所有権用の別permitも待機中cancelに対応させた。context cancelは実行中のnative処理を打ち切らず、後続処理・字幕履歴更新・HTTP responseを抑制する。
- C2 regressionは20件のASR + 20件のMTを実handler経路へ同時投入して最大同時推論数1と全要求完了を確認。timeout、待機cancel、実行中cancel、error release、session境界、shutdown barrier、モデル所有権待機cancel、キャンセル済みownerによるcontext history汚染を含む。focused Go testとfocused `-race` testはPASS。詳細はADR 0014。
- レビュー対応で、4つのproduction inference entrypointすべてを共有lane blockerと衝突させるtestと、translation callback panic後のflight cleanup/retry testを追加した。panic recoveryを実装したが、この修正後のGo testは未実行: `go test`のbuild temp作成が`No space left on device`で失敗し、確認時の作業disk空きは約287 MiBだった。既存cache/user dataは削除していない。既存の20 ASR + 20 MT PASSはこの追加差分より前の実行結果である。
- T15 deadline順dispatch (ASR終話+2秒、MT終話+3秒、同一deadlineはASR優先)、永続evaluation telemetry、C3 adaptive load controlは未実装。今回のqueue-wait/execution時間はverbose診断のみで、計測器・資格証拠ではない。
- 通常EdgeのA/Bは再実行していない。現在のUI一覧だけでは折りたたみ/隠しtabを含めMeet利用有無を安全確認できなかったため、Edgeの通常profile、Meet、拡張、mediaには触れていない。A/BはBLOCKED/NOT RUN。
- 新候補重みや評価データは取得・実行していない。モデル品質、M1 Metal、memory、確定遅延、60分負荷、実Meet字幕共有は未測定。`PROFILE_NOT_QUALIFIED`を維持。

### 継続作業チェックポイント (R24/C2 review fixes, 2026-10-05)

- 再開時HEAD: `575c1c8485e6ec64b11a41f1896d9604c08ce810` (`feat/meet-translator-local-evaluation`)。再開時点でtracked changesと未追跡のC2実装・ADR/testがあった。staged changeなし。どの既存差分も破棄・置換していない。
- C2 review fixes: inference gateを通る全production entrypoint (`/transcribe`、`/translate`、`/transcribe-and-translate`、raw LLM generation)を各blockerと競合させるtest、およびtranslation callback panic後のflight解放・再試行testを追加。callback panicはgeneric errorに変換し、flightを削除してwaiterを完了させる。panic由来の入力本文やstackをログに残さない。
- 独立subagent reviewは当初2件を指摘した。raw generation callback panicがinference boundaryを越えて伝播する点と、R23旧test記録が後続追加testと混同し得る点を修正した後、再レビューでactionable finding 0件を確認した。
- 初回focused testは新設test内の戻り値受け取りミスでcompile errorとなった。testを修正し、許可された`/private/tmp`配下にGo temp/cacheを置いて再実行したところfocused C2/panic testsはPASS。macOS `xcrun`が保護された既定tmpへcacheを作れない警告は残ったが、各Go test processはexit 0で完了した。
- 2026-10-05にserver全3 packageの`go test ./... -count=1`と`go test -race ./... -count=1`をPASS。詳細な実行条件は「検証記録」に追記した。
- 2026-10-05のEdge/Meet UI操作はmacOS Computer Use権限が拒否されたため未実施。Edge・Meet・拡張・mediaには触れていない。A/Bは`BLOCKED/NOT RUN`。過去のM1 Max/Edge 154 isolated fixture 13/13 PASSはsynthetic audio/API doubleの範囲に限り、このblockerや実Meet試験を代替しない。
- R24調査は`NO_MATERIAL_CHANGE`。新たにQwen Audio報告等を一次情報へ記録したが、候補registryは10件・全件`DEFERRED`、0件`SELECTED`、3つの公開benchmark screen PASSを維持。`PROFILE_NOT_QUALIFIED`のまま。
- 重み・評価データは取得・利用していない。実ASR/MT品質、M1 accelerator実使用、process memory、確定遅延、60分モデル負荷、実Meet字幕共有は未測定。T15 deadline順dispatch、C3 durable telemetry/adaptive load control、trusted run provenanceと合格計測器は未完了。

## 固定した数値基準

以下は仕様から転記した要求値で、実測結果ではない。ASR-onlyの独立合否閾値、翻訳停止後のメモリ解放時間・量、Meetのメディア劣化許容値は仕様で数値化されていないため、推測で補わず未定義として残す。

| 対象 | 閾値・単位 | 比較演算子 | 測定区間・母数 | 根拠 |
| --- | --- | --- | --- | --- |
| ASR 日本語 | NFC後CER。製品プロファイルでは公開字幕CERがbaselineより悪化しても最大1.0 percentage point。ASR-only固有の合否閾値は未定義。 | candidate CER - baseline CER <= 1.0 pp。短い否定/数字の再現率はbaseline以上。 | 全日本語音声case。公開字幕評価では正解非空の未公開をdeletion計上。 | implementation-spec.md §8.3–8.4 |
| ASR 英語 | NFC/casefold後WER。製品プロファイルでは公開字幕WERがbaselineより悪化しても最大1.0 pp。ASR-only固有の合否閾値は未定義。 | candidate WER - baseline WER <= 1.0 pp。短い否定/数字の再現率はbaseline以上。 | 全英語音声case。正解非空の未公開をdeletion計上。 | implementation-spec.md §8.3–8.4 |
| MT 日→英 | chrF2を補助指標としbaselineからの低下は最大1.0 point。新しい重大誤訳は0件。 | baseline chrF2 - candidate chrF2 <= 1.0 point。critical assertion違反は昇格不可。 | 人手確認済みMT-only。最終holdoutは日英合計120件以上、各方向60件以上、各方向critical assertion 20件以上。 | implementation-spec.md §8.5 |
| MT 英→日 | 日→英と同じchrF2/重大誤訳条件を独立適用。 | 同上。方向間平均で悪化を隠さない。 | 同上、英→日方向を個別集計。 | implementation-spec.md §8.5 |
| E2E 日→英 | 全発話caseを公開字幕で採点し、未公開はdeletion。公開coverageはbaseline未満にしない。翻訳公開p95は終話後3秒以下。 | 各方向でbaseline以上。遅延p95 <= 3秒。全件保留は不合格。 | 日→英の全E2E speech case。ASR、翻訳、公開決定、描画まで。 | implementation-spec.md §2.4, §8.3–8.5; eval/README.md |
| E2E 英→日 | E2E日→英と同じ条件を逆方向に独立適用。 | 各方向でbaseline以上。遅延p95 <= 3秒。全件保留は不合格。 | 英→日の全E2E speech case。 | 同上 |
| 重要意味エラー | 否定反転、数値/単位誤り、主体変更、捏造などの新しい重大誤り0件。baselineに非音声誤公開があれば半減、baselineが0なら0を維持。 | 新規重大誤りは1件でも昇格不可。非音声誤公開 <= baselineの1/2（baseline 0なら0）。 | 重要caseの人手確認と非音声負例を別々に集計。 | implementation-spec.md §8.4–8.5 |
| 原文確定遅延 | 終話から原文公開までp95 <= 2秒。 | <= | 注記された実際の終話から公開まで。発話開始から初表示も別記録。 | implementation-spec.md §2.4; m1-max-performance.md |
| 翻訳確定遅延 | 終話から翻訳公開までp95 <= 3秒。 | <= | 終話から確定訳公開まで。queue、ASR、翻訳、描画を分離。 | 同上 |
| 推論process-group memory | 定常p95 <= 8 GiB、model load/stopを含むpeak <= 10 GiB。 | <= | 2分warm-up後の60分。Go server/子process/workerを合算し、可能ならphys_footprint、RSS、memory pressure、swap差分を記録。 | implementation-spec.md §2.4; m1-max-performance.md |
| 停止後memory解放 | 解放時間・量の独立した数値閾値は未定義。load/stopを含む10 GiB peak条件は適用。 | 未定義。値を記録し推測合格にしない。 | stop前後のprocess-group footprint/RSSとモデル参照解消を記録。 | implementation-spec.md §2.4, §2.5 |
| 拡張UI追加memory | Meetのみbaselineとの差分512 MiB以下を目標。 | <= (target) | 制御したChrome比較。共有processの二重計上を避け、分離不能時は推定と明記。 | implementation-spec.md §2.4; m1-max-performance.md |
| 音声queue | 最大4件、累積音声長10,000ms。未開始音声の終話後5,000ms超でSTALE。 | 件数/累積長は上限以下。staleは経過時間 > 5,000ms。 | 10秒は滞留時間でなく、処理待ち・実行中・話者batch予約を含む累積音声長。 | implementation-spec.md §2.5; ADR 0006 |
| 翻訳queue | 未開始最大8件。同一session/stream/generation/segmentでは最新sourceRevisionのみ。enqueue後3,000ms超、またはVAD終話時刻後8,000ms超でTRANSLATION_STALE。 | 厳密な >。境界ちょうどは受理可能。原文保持、訳failed。 | pending item。8秒用のVAD wall-clock時刻は一時メタデータで、字幕session-relative endMsとは別。 | implementation-spec.md §2.5; ADR 0013 |
| 適応負荷制御 | queue wait > 2,000msが3回連続で実験/診断停止。停止後10秒経過し、直近3回(1秒間隔)すべて > 2,000msなら新規翻訳を一時停止。再開条件はmemory pressure normalが30秒連続かつASR wait < 500ms、その後ユーザー操作。 | すべて厳密な超過。 | 1秒間隔計測。既定で実験処理は無効。現在の実装は未完。 | implementation-spec.md §2.5 |
| 60分/メディア結合試験 | 2分warm-up後60分測定。通常有声音率50%、10分ごとに2分80%。host込み4参加端末、720p目標。crash/OOM/無制限queue/通常負荷のOVERLOAD音声欠落は0。 | 違反0件。Meetの品質差は拡張なしbaselineと比較。解像度・差分許容の独立数値は未定義。 | 5分ごとに訂正/undo/用語登録。lifecycleは別試験。 | implementation-spec.md §9; m1-max-performance.md |

## 固定した基準と段階

開始時のモデル名を品質合格とみなさず、M1 Max / 32 GB / 24-core GPUで、字幕共有・訂正・ローカルASR・ローカル翻訳を同時に使うことを最終条件とする。資源・遅延の数値基準は [`m1-max-performance.md`](m1-max-performance.md)、候補と復帰先は [`research/selection-lock.json`](research/selection-lock.json) に固定した。開始時HEADはソース復帰点であり、重みのhashや適格構成の復帰点ではない。

| 段階 | 状態 | 根拠・残件 |
| --- | --- | --- |
| S0 調査・基準確認 | DONE | 指示書、開始時HEAD・既存dirty差分、既存テスト、実推論経路を確認。仕様全文を `docs/implementation-spec.md` に保存し、R0〜R23と原因別追記を記録。 |
| S1 API・評価基盤・基準凍結 | IN_PROGRESS | 3評価track、音声hash/split検査、API認証/Origin/Host/body上限、FIR resampler、モデル別翻訳prompt fixture、圧縮モデルの公開benchmark screen、T15音声queue、server-side translation in-flight dedupe、extension側8件translation scheduler/3秒・音声終端+8秒期限、M1 Max上の隔離EdgeブラウザーE2E、fail-closed M1 qualification report assessorを追加。Edge 154のnative side panel判定はM1 Maxで13/13 PASS。違反を申告するreportは`REJECTED`、それ以外でもtrusted provenanceのないreportは`BLOCKED`で、report-only経路から`QUALIFIED`にはならない。評価scorer、信頼できる実行証跡collector/verifier、実測レポート作成器、モデル性能計測器、C2以降の残りT15制御は未完。 |
| S2 ASR・VAD・公開判定 | PARTIAL | native WhisperとWhisperXの詳細結果を保持し、Whisper scoreは診断表示だけに使用。mic/tabを別energy-VADで処理。待機/実行/話者batchを4件・10秒以内に数え、5秒超のqueue項目とbatchは推論前に破棄する。話者batch flush待機後にsession/generationを再確認し、停止後のincoming音声再保持を防ぐ。短いidle flushはone-shot timerを使用する。非音声・短発話の実音声評価、校正済みgate、全backendの同等segment metadataは未完。 |
| S3 字幕共有・訂正UI | PARTIAL | 公開字幕ページと非公開訂正ページ、明示承認、訂正/undo/sourceRevisionを実装。M1 Max上のEdge fixtureはnative side panel、合成tab音声、private review、訂正/undo、明示承認、stop/restartを13/13 PASS。通常Edgeで読み込まれていた拡張は古く、Chat権限が残った版だった。ソースのunpacked extensionを再読込した後は、Meetタブから訂正UIがEdgeのnative side panelに開き、通常タブfallbackは発生しなかった。実Meetにはカメラ/マイクを切って単独参加し、Meet UIの開始/退出まで確認したが、参加者音声・拡張字幕・画面共有の結合は未確認。 |
| S4 候補比較・M1統合資格 | BLOCKED | M1 Maxの実機はあるが、許可済みの重みと人手確認済み日英dev/holdoutがない。ASR-only/MT-only/E2Eのモデル出力、品質、メモリ、確定遅延、60分結合試験は未実施。 |
| S5 QR PoC | NOT_STARTED | 通常の字幕・訂正機能の完了後に行う独立実験。 |
| S6 最終研究・選定lock | BLOCKED | 10候補はすべてDEFERRED。公開数値screen通過は3構成だが、選定モデル、実行hash、holdout結果、M1計測、復帰試験がないため `PROFILE_NOT_QUALIFIED` を維持。 |

## 要件トラッカー

| ID | 状態 | 証拠・残件 |
| --- | --- | --- |
| T01 | PARTIAL | Google Chatの権限・投稿経路を削除し、旧設定移行を追加。実ブラウザーで開始/訂正/停止中のchat副作用ゼロは未確認。 |
| T02 | PARTIAL | 100件の新着でも訂正中の値、選択範囲、対象IDを保つsynthetic UI test。Edge実ブラウザーfixtureでも合成音声の新着中にdraft値・選択範囲・対象segmentが維持されることを確認。実Meet DOMは未確認。 |
| T03 | PARTIAL | IME変換中Enterが保存を呼ばないsynthetic UI test。実IME/browser試験は未確認。 |
| T04 | PARTIAL | 公開storeは原文とpending/failed訳を別状態で保持し、訳失敗で原文を消さない。実Meet/画面共有の結合は未確認。 |
| T05 | PARTIAL | session/generation/revisionの旧イベント拒否をstore/UI testで確認。Chromeの非同期競合は未確認。 |
| T06 | PARTIAL | 訂正で旧訳を無効化し、undoで新sourceRevisionを作るstore test。辞書revisionを含む会議試験は未実施。 |
| T07 | DONE | public projectionは承認済み原文・同revisionの訳など許可項目だけを出し、ASR raw text、診断、設定、辞書を除外。unit testあり。 |
| T08 | PARTIAL | FIRのDC、通過帯域、alias rejection、長さ、同率変換のcontract test。chunk不変性と係数再利用の計測は未実装。 |
| T09 | PARTIAL | WAV解析、音声body 8 MiB制限、API拒否のtestあり。不正・切断・非有限値の全境界を網羅したとはいえない。 |
| T10 | PARTIAL | ASR promptはbackend種別を分離し、翻訳はHy-MT2/Qwen系のprompt builderとfixtureあり。全設定・辞書versionの組み合わせ検査は未完。 |
| T11 | PARTIAL | Whisper閾値境界/スコア未取得/他backendへ閾値を流用しない診断testあり。数値は校正前で、自動公開gateではない。 |
| T12 | PARTIAL | synthetic 341 ms voiced fixtureがdurationだけで捨てられないことを確認。自然な短い否定・数字、無音/雑音誤検出は未評価。 |
| T13 | PARTIAL | native WhisperとWhisperXは構造化segmentを返し、得られないscoreはnull。SenseVoiceなど他adapterのsegment/timing契約が揃っていない。 |
| T14 | PARTIAL | stop/restart、stream generation、mic非公開、終了sessionをsynthetic store testで確認。Edge実機fixtureでtabCaptureの開始、停止後のoverlay/session終了、再開、無音時送信なしを確認。通常Edgeの実Meetではカメラ/マイクをオフにした単独参加・退出のみ確認。実マイク入力・参加者音声は未試験。 |
| T15 | PARTIAL | 音声queue上限4件/累積10秒、5秒超STALEと非公開drop statusを実装。`/translate`の同一prompt identity single-flight、20要求→推論/context追加1回、失敗後retry、waiter cancelを検査。extension未開始翻訳は8件上限、sourceRevision置換、厳密な3,000ms/8,000ms stale境界を確認。C2共通inference laneはASR/MT/raw LLMの同時実行を1以下に保ち、20 `/transcribe` + 20 `/translate` の同時handler test、timeout/cancel/error/session/shutdown testを追加。native演算中のcancelはpermitを早期解放せず、待機ownerのcancelは履歴へ結果を追加しない。deadline順dispatch、C3永続telemetry/adaptive load controlは未実装。|
| T16 | PARTIAL | bearer token、loopback、Origin/Host、preflight、8 MiB拒否をGo testで確認。Edge 154から隔離loopback APIへ認証付きhealth/transcribe/translateが届くことをfixtureで確認。Originなしの拡張要求を実サーバーと同じBearer認証契約で処理。配布IDとGoサーバーbinaryの結合は未確認。 |
| T17 | PARTIAL | storageをtrusted contextに制限し、旧chat設定と通知の移行を追加。全設定/辞書/明示モデルの保存互換性は未監査。 |
| T18 | PARTIAL | 字幕/訂正画面はtextContentで描画し、Chat権限なし。Edge実機fixtureで悪意あるHTML風字幕が`#caption-list`内に要素を生成せず文字列表示されることを確認。QR表示・復号は未実装。 |
| T19 | PARTIAL | Offscreen Port再接続、session復元、重複開始拒否のsynthetic test。Chrome強制SW終了試験は未実施。 |
| T20 | PARTIAL | 一般ログと辞書feedbackから字幕本文/話者/会議URLを外した。全ログ経路のsecret checkerは未実装。 |
| T21 | NOT_STARTED | 全件保留や字幕消失を精度改善として扱わない評価器・negative fixtureは未完。 |
| T22 | NOT_STARTED | QR送受信のprotocol・画像・再送試験は未実装。 |
| M01 | BLOCKED | M1実機は確認済み。選択runtimeのarm64/Metal実使用、CPU fallbackなしをモデルと一緒に測っていない。 |
| M02 | PARTIAL | 通常経路はASR/翻訳モデル各1個を想定。`modelMu`とcancellable LLM-operation permitがLLMモデル状態を保護し、server-wide capacity-one inference laneがASR/MT/raw generationを直列化する。model-free handler regressionでmax(active inference)=1を確認。実ロード数・子process・backendのasync GPU work完了契約・Metal実使用は未実測。|
| M03 | DONE | RAM/GPU容量から大型モデルへ自動昇格するtier tableを削除し、起動help/testを更新。 |
| M04 | PARTIAL | 8 MiB API上限、caption storage 4 MiB、履歴/出力の一部上限あり。音声・翻訳queue、全履歴、runtime memoryの実測は未完。 |
| M05 | BLOCKED | M1 60分の負荷・memory・遅延・Meet結合計測なし。 |
| M06 | BLOCKED | 人手確認済みholdoutと実モデル出力がなく、品質閾値を判定できない。 |
| M07 | PARTIAL | 実験用処理を通常経路に追加していない。任意Python backend等を含む実行時resident model/processの確認は未完。 |
| M08 | NOT_STARTED | memory pressure検知、安全停止、モデル解放・ユーザー操作による再開を実装していない。 |
| MT01 | PARTIAL | ASR-only・正解原文MT-only・E2E manifestと検査器を分離。モデル出力adapter/scorerは未完で、現fixtureはsyntheticのみ。 |
| MT02 | BLOCKED | 翻訳prompt fixtureはあるが、選定済みartifactのtemplate/tokenizer/EOS/thinking/text-only出力がない。 |
| MT03 | BLOCKED | 日英の人手確認済みquality cases、重要意味assertions、SacreBLEU固定版の評価なし。 |
| MT04 | NOT_STARTED | scorerがgoldを通し、捏造・反転・全件保留などを落とすnegative fixtureは未実装。 |
| R01 | DONE | R0/R4/R5/R6/R7/R8/R9/R10および原因別追記について確認日、一次情報、候補screen、差分、制約をresearch logに記録。 |
| R02 | PARTIAL | 候補の言語/利用条件/runtime/テンプレート/quantizationと6圧縮方式を整理。公開数値は候補枠のscreenにだけ使い、未確認の重みhashとM1互換性はDEFERREDに保持。 |
| R03 | DONE | offline checkerは出典付き数値、圧縮スコア維持率の再計算、compact翻訳の同一benchmark/metric/referenceによる両方向比較、hash・runtime・template・M1証拠を検査。 |
| R04 | BLOCKED | 一軸変更比較と実機結合runがない。 |
| R05 | BLOCKED | consent済み開発/holdout dataがない。 |
| R06 | PARTIAL | WhisperのscoreだけをWhisper向け診断へ使用。Qwen/Nemotron等の固有スコアと校正gateは未作成。 |
| R07 | BLOCKED | PROFILE_NOT_QUALIFIEDのlockとソース復帰点はあるが、qualified artifact/hash/runtime/template/evaluation lockはない。 |
| R08 | DONE | 会議中の検索、モデル自動更新、追加runtime起動を入れていない。 |
| R09 | DONE | 重み・データ・実機推論がない候補はDEFERRED/BLOCKEDのまま。 |
| R10 | PARTIAL | research/fixture integrity checkerのpositive/negative testsあり。budget/secret漏洩・製品公開gateなど未対応contractが残る。 |
| R11 | BLOCKED | 採用モデルの切替/停止/復帰runなし。 |
| R12 | PARTIAL | M1性能記録と手動試験計画を追加。M1 Max上のEdge実ブラウザーfixtureとEdge process-tree RSSは記録したがモデル推論を含まず、モデル品質・遅延・resident memoryの計測値はない。 |

## 変更した領域

- `extension/`: mic/tab別energy-VAD、session/generation検査、host-only訂正UI、字幕用public/private channel、承認・訂正・undo・translation revision管理、字幕ページを追加。
- `server/`: loopback API認証と上限、FIRリサンプル、構造化ASR結果、Whisper固有診断、Whisper候補文を保持する固定source patch、Python音声入力のin-memory処理を追加。
- `eval/` と `server/cmd/eval/`: ASR-only、正しい原文MT-only、E2Eを分離し、synthetic fixture・local WAV hash・track/split検査を追加。モデル推論は実行しない。
- `docs/research/`: 一次情報・候補・調査log・圧縮benchmark screen・PROFILE_NOT_QUALIFIED lockを保存。現在90 sources / 10 candidates、全候補DEFERRED。公開screen PASSは3件だが、実機適格モデルは0件。R20でARK-ASRの蒸留版とQwen3-ASR MLX量子化版の公開数値を確認したが、該当する日本語スコアがないため候補枠へ登録せずDEFERREDにした。R21では外部資料の数値・テンプレート・実行経路・適用限界をhandoff本文にも要約し、R22では実験段階のANEForge経路とMLX共有メモリの限界を追記し、R23ではCAT-Translate 3.3Bの両方向スコア (37.51/34.80 BLEU) がTranslateGemma 4B参照値 (29.41/26.76) を超えることを記録した。翻訳候補枠は既に3件使っているため追加候補として登録せず、次ラウンド待ちのDEFERRED leadにした。
- Qualification assessor: trusted provenanceなしでJSON自己申告だけでは昇格できない。`testDouble`/`synthetic`の欠落をBLOCKEDにし、ASR-onlyは日本語/英語別、MT-onlyは翻訳方向別、公開字幕はE2E方向別に全caseの採点数を照合する。保留字幕を削除として計上し、全件/大量保留、baselineより少ない公開件数・方向別公開率・浮動runtime aliasを拒否する。違反を含むreportは`REJECTED`、他の要件を満たしてもprovenance verifierがないreportは`BLOCKED`で、現在のreport-only経路から`QUALIFIED`にはならない。
- `docs/decisions/`: hardware-only昇格禁止、モデル別prompt、ASR候補保持/host review、開始排他、audio queue、holdout適格性判断を記録。

## 検証記録

| 検証 | 結果 |
| --- | --- |
| `GOCACHE=/private/tmp/meet-translator-go-cache go test ./... -count=1` (`server/`, 2026-09-30) | PASS。全3 Go package。C2共通推論レーンの20 ASR + 20 MT同時handler test、single-flight owner cancellation/survivor、最後のwaiterによる共有context cancel、model wait cancellationとshutdown barrierを含む。Apple linker duplicate-library warningは出たが終了コード0。 |
| `GOCACHE=/private/tmp/meet-translator-go-cache go test -race ./... -count=1` (`server/`, 2026-09-30) | PASS。全3 Go packageでrace reportなし。ASR/MT共通gate、translation flightの待機cancelと生存waiter、history side effect、shutdownを含む。 |
| `GOCACHE=/private/tmp/meet-translator-go-cache go test . -run '^TestTranslationFlightPanicCompletesFlightAndAllowsRetry$' -count=1` (`server/`, 2026-09-30) | NOT RUN。Go buildはCGo一時objectの作成時に`No space left on device`で終了し、test binaryは起動しなかった。確認時のdisk空きは約287 MiB。 |
| `go test . -run 'Test(InferenceGate|TranslationFlightPanic)' -count=1` (`server/`, 2026-10-05、`TMPDIR`/`GOTMPDIR`/`GOCACHE`を`/private/tmp`下へ指定) | PASS。C2共有lane、production entrypoint blocker、queue/execution timing、timeout/cancel/error permit release、panic後のtranslation flight cleanup/retryを確認。macOS `xcrun`既定cacheへの書込拒否警告あり、終了コード0。 |
| `go test . -run '^TestInferenceGatePanicReturnsGenericErrorAndReleasesPermit$' -count=1` (`server/`, 2026-10-05、temp/cacheは`/private/tmp`下) | PASS。panic本文をgeneric errorへ変換し、次の推論へpermitが戻ることを確認。 |
| `go test ./... -count=1` (`server/`, 2026-10-05、temp/cacheは`/private/tmp`下) | PASS。server / benchmark / evalの全3 Go package。`xcrun`既定cacheへの書込拒否とduplicate-library warningはあったが終了コード0。 |
| `go test -race ./... -count=1` (`server/`, 2026-10-05、temp/cacheは`/private/tmp`下) | PASS。3 package、race reportなし。`xcrun`既定cacheへの書込拒否とduplicate-library warningはあったが終了コード0。 |
| `node --test extension/tests/*.test.js` (`meet-translator/`, 2026-10-05) | PASS 86/86。 |
| `node --test eval/*.test.mjs eval/device/*.test.mjs` (`meet-translator/`, 2026-10-05) | PASS 21/21。 |
| `node eval/check-research.mjs --offline` (`meet-translator/`, 2026-10-05) | PASS。94 sources、10 candidates (全件DEFERRED)、published benchmark screens 3、0 SELECTED、`PROFILE_NOT_QUALIFIED`。 |
| `node eval/check-contracts.mjs` (`meet-translator/`, 2026-10-05) | PASS。ASR 1 / MT 3 / E2E 1 fixturesはすべてsynthetic、推論なし、品質証拠なし、product status `not-evaluated`。 |
| `node --test meet-translator/extension/tests/*.test.js` | PASS 86/86. C1 fake-clock deadlines, 8-item translation/callback bounds, stale-slot release, correction admission and serial-lane holding through MT completion, revision replacement, source retention, expiry-reason UI, mixed audio/translation drop status, and private-status regressions are included. |
| `node --test --test-name-pattern='correction translations reserve bounded queue capacity|private panel reports a failed translation without claiming' meet-translator/extension/tests/background.test.js meet-translator/extension/tests/sidepanel.test.js` | PASS 2/2。訂正queue期限切れを原文revision変更と区別し、失敗表示で原文更新を誤報しないことを確認。 |
| `node --test meet-translator/extension/tests/offscreen-vad.test.js meet-translator/extension/tests/background-caption-bridge.test.js meet-translator/extension/tests/sidepanel.test.js` | PASS 16/16。VAD終端時刻、private-only status、原文保持UI、音声・翻訳で混在した破棄理由と合計数の表示を含む。 |
| `node meet-translator/eval/device/run-browser-e2e.mjs` (2026-09-30 01:19 UTC) | M1 Max / Edge 154で13/13 PASS。extension side panel、合成tab音声、訂正/undo、承認、stop/restart、認証付きloopback APIを確認。`cleanupError:null`、無効認証0。RSSはEdge/fixture合計の目安1907→1504 MiBであり、モデル資源値ではない。Metal・実推論・品質・実Google Meet音声は未計測。 |
| `GOCACHE=/private/tmp/meet-translator-go-cache go test -count=1 ./cmd/eval` (`server/`) | PASS。Qualification assessorのunit testsを含む。架空fixtureは評価ロジック専用で、実機結果ではない。 |
| `GOCACHE=/private/tmp/meet-translator-go-cache go test ./cmd/eval -count=1` (`server/`) | PASS。自己申告reportの昇格拒否、attestation欠落、ASR日英別/MT方向別の採点数、E2E方向別公開数、全件/大量/片方向保留、浮動runtime aliasを含む。 |
| `node --test meet-translator/eval/*.test.mjs meet-translator/eval/device/*.test.mjs` | PASS 21/21。評価trackの既存14件とEdge launcher test 7件を含む。 |
| `node --test meet-translator/eval/device/*.test.mjs` | PASS 7/7。PID再利用時にシグナルを送らないこと、終了未確認時のprofile保持を含む。 |
| `node eval/check-research.mjs --offline` (`meet-translator/`, 2026-09-30) | PASS。90 sources、10 candidates、10 DEFERRED、現在登録済みpublished benchmark screen PASS 3件、0 SELECTED、PROFILE_NOT_QUALIFIED。CAT-Translate 3.3Bの数値passは枠満杯のため別途DEFERRED leadに記録し、候補registryは増やしていない。 |
| `node eval/check-contracts.mjs` | PASS。ASR 1 / MT 3 / E2E 1、audio asset 2件。全てsynthetic、推論なし、品質証拠なし。 |
| `go run ./cmd/eval --track ...` の3 manifest検査 (`server/`) | PASS。ASR 1 / MT 3 / E2E 1件。各manifestのaudio hash整合、`inferenceExecuted:false`、昇格可能件数0。 |
| GitHub Actions `Execute Test` model matrix (PR #74, run `36590879953`, 2026-09-29) | 既存PR triggerがremote runnersでASR/LLM weightをdownload/cacheしていたため実行をcancel。旧run直後のsnapshotには23個のActions cache (17,275,817,804 bytes) が記録された。最新API照会では27件 (11,170,461,892 bytes) であり、現況はhandoffの時刻付き一覧を参照。これは別機種上のsilent-audio/startup smokeで、M1品質・性能証拠ではない。以後PRでは自動実行せず、明示的なmanual dispatch opt-inに変更。詳細なcache IDと状態は[`handoff-2026-09-30.md`](handoff-2026-09-30.md)。 |
| GitHub Actions PR follow-up at `eca680b` (2026-09-29) | Build Check、Execute Testの4 platform builds、Test/Extension Tests、SHA Pinning全てPASS。Execute Testのweight-using `execute` matrixは`skipped`で、今回新しいmodel downloadなし。 |

話者変更flush中の停止競合を再現する回帰testは、修正前にpending batchが残ることを確認し、修正後はbatchとqueue予約がすべて解放されることを確認した。翻訳flightの20要求・失敗後retry・waiter cancelはmodel-free Go testで確認した。Edge fixtureは実Edge拡張・side panel・tabCapture・ローカルHTTP APIを通過したが、モデル品質や実Meet音声/画面共有の合格を示すものではない。

C1の境界test、訂正queue予約・stale処理、UI経路は上表のmodel-free testで確認した。Go suiteとtranslation single-flight race testを再実行し、history snapshot差分を加えたhandler regressionも通過した。隔離Edge fixtureと実Meetは再実行していない。Edgeは既に別の実会議で使われていたため、通常profileやMeetへの操作は行わなかった。

## 実測していない項目

重みはM1 Mac/workspaceにはダウンロード・commitしていない。ただし既存GitHub Actions `Execute Test` がPR #74上でremote runnerへ実モデル重みを取得・cacheし、一部をロードした。旧run直後に記録した23個/17,275,817,804-byte snapshotは履歴である。2026-09-29 16:33 UTCの最新API照会は27件/11,170,461,892 bytes (14 build系、13 model/runtime系) だった。どのcacheも削除していない。今回のremote smokeはsilence input/startup確認で、候補比較ではなくM1/品質/性能証拠にもならない。以後のPRではmodel matrixを自動実行せず、workflow_dispatchで明示opt-inした場合に限る。人手確認済みの日英データがなく、ASR/MT品質、公開品質、確定遅延を測っていない。M1の機材情報とEdgeの合成音声経路は確認したが、モデルをロードしたM1性能やMetal推論は測っていない。実Meetへは単独参加してUIの起動/退出を見たが、参加者音声、拡張字幕出力、実画面共有、実マイク入力を試していない。したがって現在のコード・候補はM1 Maxでのモデル合格構成を意味しない。

## 次に進める作業

1. A/Bを実施する。開始条件はEdgeが別会議に使われていないこと。最初に許可済みtest roomが単独利用できることを確認し、A-01〜A-10をcase別に記録する。共有する場合は字幕専用ページだけを対象にする。
2. A/Bが環境都合で続けて実施できない場合は、C2共通推論排他をmodel-free API doubleで実装する。実推論境界でASR 20件とMT 20件を同時投入し、`max(active_inference)=1`と正常終了・例外・timeout・待機cancel・実行中cancel・session切替を検査する。native演算が戻るまでlockを解放しない。
3. C3のevaluation telemetry/適応負荷制御、Dのscorerと意味assertion、Eのtrusted provenance、Fの資源測定器を順に追加する。
4. 許可済みモデルとreviewed日英データが揃った後に候補を一軸ずつ比較し、ASR-only、MT-only、E2EとM1統合を記録する。品質確認なしで候補を昇格しない。

## M1 Max Edge 実機fixture記録 (2026-09-29)

- 実行対象: Apple M1 Max (`MacBookPro18,4`)、32 GB、24-core GPU、arm64、macOS 26.6.2、Microsoft Edge 154.0.4258.37。
- 条件: 新規一時Edge profile、loopback HTTPS Meet-host fixture、440 Hz synthetic tab tone、deterministic local API double。`eval/device/README.md`に分離条件を記録。
- 結果: 起動クラッシュ後の初回修正版runは13/13 PASSだったが、native side panel判定は単にCDP page targetの存在を見ており、tab fallbackも合格にできる欠陥があった。R15で判定を修正した最新run (2026-09-29 11:31 UTC) は13/13 PASS、`cleanupError:null`。実`chrome.sidePanel.open` APIとmanifest permissionを確認し、`chrome.tabs.query`にsidepanel URLが現れないことも検査。settings UI保存、Bearer認証API、実`tabCapture`経路、4件のWAV transcription request、private draftとselection保持、訂正・再翻訳・undo、明示承認、hostile HTMLの安全描画、無音抑止、stop/restartも確認。
- リソース記録: 最新runのEdge process-tree RSSはテスト前1641 MiB、終了直前1150 MiB。これはEdgeとテストページの合計概算であり、ASR/翻訳モデルをロードしていないため、製品の推論memory/performance値ではない。Metal情報はこのrunのレポートではnull。
- 再現レポート: ignored file `eval/private-data/device-browser-e2e.json`。音声/字幕/生成結果はGitに追加しない。
- 判定: launcher修正の静的再レビューは完了。隔離Edge fixtureは安全なcleanup経路で再実行し、13/13 PASS、`cleanupError:null`。S4/S6はBLOCKEDのまま。モデル品質、model/runtime/template/gate、実Meet、共有、60分負荷の合格証拠はないため、`PROFILE_NOT_QUALIFIED`を維持。

### Edge native side panel 判定の補正 (2026-09-29)

- 再確認で、旧browser fixtureは`chrome-extension://.../sidepanel.html`のCDP targetだけを見ており、通常タブfallbackもnative side panelとして誤ってPASSにできることが分かった。通常のEdge profileでは実際に訂正UIが通常タブとして表示されていた。
- fixtureにEdge側の`chrome.sidePanel.open`実在、manifest permission、sidepanel URLの通常tab不在を要求する条件を追加。M1 Max / Edge 154の新しい隔離profileで13/13 PASSし、当該判定を通過。ユーザーの通常profileで読み込み済みの拡張artifact/API状態は再読み込み・変更しておらず、別途未確認。
- これもモデル品質や実会議の合格証拠ではない。S4/S6と`PROFILE_NOT_QUALIFIED`は維持。

### 通常Edge profileでの再確認 (2026-09-30)

- 先の確認は当時の通常profileで読み込まれていた古いextension artifactを対象にしていた。その後、ユーザーの指示に基づいて `edge://extensions/` からworkspaceのunpacked extensionを再読込した。
- 再読込後、Meetタブから訂正履歴UIを開くとEdgeのnative side panelに表示され、通常タブfallbackは作られなかった。古いartifactに残っていた`https://chat.google.com/*`権限も現行manifestに置き換わった。popup上のローカルserver接続は引き続きdisconnectedであり、実推論は未試験。
- ユーザーが許可した実Meet試験室へ単独参加した。参加前にonだったcamera/micをoffにし、他参加者なしでjoin/leaveした。Meet側のtranscription開始UIは表示されたが、音声・字幕を入力/保存しておらず、拡張ASR/翻訳・共有の合格には数えない。

### Edge起動クラッシュの追跡

- 添付レポートはEdge 154.0.4258.37 / macOS 26.6.2で、起動から約0.19秒後に`SIGABRT`。親プロセスは`node`で、メインスレッドは`HIServices ___RegisterApplication` → `GetCurrentProcess` → AppKitの`NSApplication`初期化中に終了している。メモリ不足、Meet、拡張コード、字幕処理へ到達した証拠はない。
- これはブラウザー起動段階の失敗と分類する。親がNodeであることは子プロセスとして直接起動した経路と整合するが、レポートだけではEdgeまたはmacOS側の根本不具合を断定できない。
- 隔離ブラウザーハーネスは現在、`/usr/bin/open -n -g -a`のLaunch Services経由で起動する。修正後のM1 Max実行は13/13通過し、後続成功runのignored reportは`cleanupError:null`。失敗runは成功数へ算入していない。
- これは実Google Meet・マイク/カメラ・画面共有・モデル推論を含まない。S4/S6と`PROFILE_NOT_QUALIFIED`の判定は変わらない。
