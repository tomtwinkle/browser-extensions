# 実装状況

更新日: 2026-09-30

対象: `meet-translator/`

作業開始時HEAD: `6ac37a149a0314ba1b989a1c1f66d5dedf35ff47` (`main`)

作業開始時作業ツリー: 既存の未コミット変更があった。内容を維持し、開始時HEADとともに追跡した。

## 固定した基準と段階

開始時のモデル名を品質合格とみなさず、M1 Max / 32 GB / 24-core GPUで、字幕共有・訂正・ローカルASR・ローカル翻訳を同時に使うことを最終条件とする。資源・遅延の数値基準は [`m1-max-performance.md`](m1-max-performance.md)、候補と復帰先は [`research/selection-lock.json`](research/selection-lock.json) に固定した。開始時HEADはソース復帰点であり、重みのhashや適格構成の復帰点ではない。

| 段階 | 状態 | 根拠・残件 |
| --- | --- | --- |
| S0 調査・基準確認 | DONE | 指示書、開始時HEAD・既存dirty差分、既存テスト、実推論経路を確認。仕様全文を `docs/implementation-spec.md` に保存し、R0〜R18と原因別追記を記録。 |
| S1 API・評価基盤・基準凍結 | IN_PROGRESS | 3評価track、音声hash/split検査、API認証/Origin/Host/body上限、FIR resampler、モデル別翻訳prompt fixture、圧縮モデルの公開benchmark screen、T15基本queue上限、M1 Max上の隔離EdgeブラウザーE2E、fail-closed M1 qualification report assessorを追加。Edge 154の修正版launcherとnative side panel判定はM1 Maxで13/13 PASS。違反を申告するreportは`REJECTED`、それ以外でもtrusted provenanceのないreportは`BLOCKED`で、report-only経路から`QUALIFIED`にはならない。評価scorer、信頼できる実行証跡collector/verifier、実測レポート作成器、モデル性能計測器、残りのT15制御は未完。 |
| S2 ASR・VAD・公開判定 | PARTIAL | native WhisperとWhisperXの詳細結果を保持し、Whisper scoreは診断表示だけに使用。mic/tabを別energy-VADで処理。待機/実行/話者batchを4件・10秒以内に数え、5秒超のqueue項目とbatchは推論前に破棄する。話者batch flush待機後にsession/generationを再確認し、停止後のincoming音声再保持を防ぐ。短いidle flushはone-shot timerを使用する。非音声・短発話の実音声評価、校正済みgate、全backendの同等segment metadataは未完。 |
| S3 字幕共有・訂正UI | PARTIAL | 公開字幕ページと非公開訂正ページ、明示承認、訂正/undo/sourceRevisionを実装。M1 Max上のEdge fixtureは`chrome.sidePanel.open` APIとmanifest permissionを確認し、訂正UIが通常タブとして作られていないことを検査して13/13 PASS。合成tab音声、private review、訂正/undo、明示承認とstop/restartも通過。現在の通常Edge profileで読み込まれている拡張は訂正UIを通常タブとして開いたため、そのprofileの拡張artifact/API状態は未照合。実Google Meet会議、実画面共有、配布拡張IDでのOrigin検査も未試験。 |
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
| T14 | PARTIAL | stop/restart、stream generation、mic非公開、終了sessionをsynthetic store testで確認。Edge実機fixtureでtabCaptureの開始、停止後のoverlay/session終了、再開、無音時送信なしを確認。mic権限の再許可と実Meetは未試験。 |
| T15 | PARTIAL | 待機・実行中・話者batch保持中の音声を最大4件/10秒に制限し、queue先頭とbatch flushで5秒超をSTALEとして破棄。停止中に話者変更flushが完了してもincoming音声を再保持しない。短いidle flushにchrome.alarmsを使わない。OVERLOAD/STALE件数と累積音声時間を非公開訂正UIに表示。翻訳dedupe/期限、評価telemetry、共通推論排他、適応負荷制御は未実装。 |
| T16 | PARTIAL | bearer token、loopback、Origin/Host、preflight、8 MiB拒否をGo testで確認。Edge 154から隔離loopback APIへ認証付きhealth/transcribe/translateが届くことをfixtureで確認。Originなしの拡張要求を実サーバーと同じBearer認証契約で処理。配布IDとGoサーバーbinaryの結合は未確認。 |
| T17 | PARTIAL | storageをtrusted contextに制限し、旧chat設定と通知の移行を追加。全設定/辞書/明示モデルの保存互換性は未監査。 |
| T18 | PARTIAL | 字幕/訂正画面はtextContentで描画し、Chat権限なし。Edge実機fixtureで悪意あるHTML風字幕が`#caption-list`内に要素を生成せず文字列表示されることを確認。QR表示・復号は未実装。 |
| T19 | PARTIAL | Offscreen Port再接続、session復元、重複開始拒否のsynthetic test。Chrome強制SW終了試験は未実施。 |
| T20 | PARTIAL | 一般ログと辞書feedbackから字幕本文/話者/会議URLを外した。全ログ経路のsecret checkerは未実装。 |
| T21 | NOT_STARTED | 全件保留や字幕消失を精度改善として扱わない評価器・negative fixtureは未完。 |
| T22 | NOT_STARTED | QR送受信のprotocol・画像・再送試験は未実装。 |
| M01 | BLOCKED | M1実機は確認済み。選択runtimeのarm64/Metal実使用、CPU fallbackなしをモデルと一緒に測っていない。 |
| M02 | PARTIAL | 通常経路はWhisper/翻訳モデル各1個を想定し、Service Workerの推論呼び出しを直列化。実ロード数・子プロセス・同時実行数は未計測。 |
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
- `docs/research/`: 一次情報・候補・調査log・圧縮benchmark screen・PROFILE_NOT_QUALIFIED lockを保存。現在79 sources / 10 candidates、全候補DEFERRED。公開screen PASSは3件だが、実機適格モデルは0件。
- Qualification assessor: trusted provenanceなしでJSON自己申告だけでは昇格できない。`testDouble`/`synthetic`の欠落をBLOCKEDにし、ASR-onlyは日本語/英語別、MT-onlyは翻訳方向別、公開字幕はE2E方向別に全caseの採点数を照合する。保留字幕を削除として計上し、全件/大量保留、baselineより少ない公開件数・方向別公開率・浮動runtime aliasを拒否する。違反を含むreportは`REJECTED`、他の要件を満たしてもprovenance verifierがないreportは`BLOCKED`で、現在のreport-only経路から`QUALIFIED`にはならない。
- `docs/decisions/`: hardware-only昇格禁止、モデル別prompt、ASR候補保持/host review、開始排他、audio queue、holdout適格性判断を記録。

## 検証記録

| 検証 | 結果 |
| --- | --- |
| `GOCACHE=/private/tmp/meet-translator-go-cache go test ./... -count=1` (`server/`, 2026-09-30再実行) | PASS。全3 Go package。Apple `xcrun_db` cache warningは出たが終了コード0。ASR/MT split coverage回帰testを含む。 |
| `node --test meet-translator/extension/tests/*.test.js` | PASS 73/73。今回追加したsettings helper、side panel、Meet host validation testsを含む。 |
| `node meet-translator/eval/device/run-browser-e2e.mjs` | 添付のEdge起動レポートは起動約0.19秒後のSIGABRT。親はNode、stackは`HIServices`のアプリ登録から`NSApplication`初期化中で、拡張・Meet・モデル処理前。Launch Services launcherの後続runは通過。今回、side panelの実API/permissionと「通常タブを生成しない」条件を追加し、M1 Max / Edge 154で13/13 PASS、`cleanupError:null`。通常sandboxでは`/bin/ps EPERM`により別の再試行がcheck前に停止し、一時profileを保持した。許可されたprocess listで当該isolated profileを使うEdgeが残っていないことを確認し、当該テストdirだけ削除後に再実行した。 |
| `GOCACHE=/private/tmp/meet-translator-go-cache go test -count=1 ./cmd/eval` (`server/`) | PASS。Qualification assessorのunit testsを含む。架空fixtureは評価ロジック専用で、実機結果ではない。 |
| `GOCACHE=/private/tmp/meet-translator-go-cache go test ./cmd/eval -count=1` (`server/`) | PASS。自己申告reportの昇格拒否、attestation欠落、ASR日英別/MT方向別の採点数、E2E方向別公開数、全件/大量/片方向保留、浮動runtime aliasを含む。 |
| `node --test meet-translator/eval/*.test.mjs meet-translator/eval/device/*.test.mjs` | PASS 21/21。評価trackの既存14件とEdge launcher test 7件を含む。 |
| `node --test meet-translator/eval/device/*.test.mjs` | PASS 7/7。PID再利用時にシグナルを送らないこと、終了未確認時のprofile保持を含む。 |
| `node eval/check-research.mjs --offline` | PASS。79 sources、10 candidates、10 DEFERRED、3 published benchmark screens、0 SELECTED、PROFILE_NOT_QUALIFIED。 |
| `node eval/check-contracts.mjs` | PASS。ASR 1 / MT 3 / E2E 1、audio asset 2件。全てsynthetic、推論なし、品質証拠なし。 |
| `go run ./cmd/eval --track ...` の3 manifest検査 (`server/`) | PASS。ASR 1 / MT 3 / E2E 1件。各manifestのaudio hash整合、`inferenceExecuted:false`、昇格可能件数0。 |
| GitHub Actions `Execute Test` model matrix (PR #74, run `36590879953`, 2026-09-29) | 既存PR triggerがremote runnersでASR/LLM weightをdownload/cacheしていたため実行をcancel。完了済みmodel smoke jobsと23個のActions cache (合計17,275,817,804 bytes) は残存。これは別機種上のsilent-audio/startup smokeで、M1品質・性能証拠ではない。以後PRでは自動実行せず、明示的なmanual dispatch opt-inに変更。詳細なcache IDと状態は[`handoff-2026-09-30.md`](handoff-2026-09-30.md)。 |

話者変更flush中の停止競合を再現する回帰testは、修正前にpending batchが残ることを確認し、修正後はbatchとqueue予約がすべて解放されることを確認した。Edge実機fixtureは実ブラウザーの拡張・side panel・tabCapture・ローカルHTTP APIを通過したが、モデル品質や実Google Meet動作の合格を示すものではない。

## 実測していない項目

重みはM1 Mac/workspaceにはダウンロード・commitしていない。ただし既存GitHub Actions `Execute Test` がPR #74上でremote runnerへ実モデル重みを取得・cacheし、一部をロードした。run `36590879953` の23個のActions cacheは現在も残っており、削除していない。今回のremote smokeはsilence input/startup確認で、候補比較ではなくM1/品質/性能証拠にもならない。以後のPRではmodel matrixを自動実行せず、workflow_dispatchで明示opt-inした場合に限る。人手確認済みの日英データがなく、ASR/MT品質、公開品質、確定遅延を測っていない。M1の機材情報とEdgeの合成音声経路は確認したが、モデルをロードしたM1性能やMetal推論は測っていない。実Google Meetの参加者音声、実画面共有、カメラ/マイク、配布拡張IDでの実会議は未試験。したがって現在のコード・候補はM1 Maxでのモデル合格構成を意味しない。

## 次に進める作業

1. T15の翻訳期限/dedupe、評価telemetry、共通推論排他、適応負荷制御をmodel-free test付きで実装する。
2. evaluation scorer、重要意味assertionと負例、資源・latency計測を追加する。
3. 許可済みモデルとreviewed日英データが揃った後に候補を一軸ずつ比較し、ASR-only、MT-only、E2EとM1統合を記録する。
4. 実Google Meetの参加者・画面共有・訂正UIをEdgeで確認してから、候補lockとロールバックを確定する。現在の合成DOM fixtureはこの確認を代替しない。

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

### Edge起動クラッシュの追跡

- 添付レポートはEdge 154.0.4258.37 / macOS 26.6.2で、起動から約0.19秒後に`SIGABRT`。親プロセスは`node`で、メインスレッドは`HIServices ___RegisterApplication` → `GetCurrentProcess` → AppKitの`NSApplication`初期化中に終了している。メモリ不足、Meet、拡張コード、字幕処理へ到達した証拠はない。
- これはブラウザー起動段階の失敗と分類する。親がNodeであることは子プロセスとして直接起動した経路と整合するが、レポートだけではEdgeまたはmacOS側の根本不具合を断定できない。
- 隔離ブラウザーハーネスは現在、`/usr/bin/open -n -g -a`のLaunch Services経由で起動する。修正後のM1 Max実行は13/13通過し、後続成功runのignored reportは`cleanupError:null`。失敗runは成功数へ算入していない。
- これは実Google Meet・マイク/カメラ・画面共有・モデル推論を含まない。S4/S6と`PROFILE_NOT_QUALIFIED`の判定は変わらない。
