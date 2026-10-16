# Evaluation harness

The tracks are intentionally separate:

- `asr-only/`: fixed audio to reference transcript.
- `translation/`: human-reviewed source text to one or more reference translations.
- `e2e/`: fixed audio through ASR, translation, and the public-output decision.

The JSONL files currently contain synthetic contract fixtures only. The 100 ms silence WAV checks local path/hash handling and is not a speech-quality example. There is no authorized human-reviewed development/holdout speech corpus, so no real ASR, translation, publication-quality, or M1 model comparison has been run.

Validate each track's schema, split isolation, and local asset hash from the server module directory:

```sh
cd meet-translator/server
go run -mod=mod ./cmd/eval --track asr-only --manifest ../eval/asr/contract.jsonl --project-root ..
go run -mod=mod ./cmd/eval --track mt-only --manifest ../eval/translation/contract.jsonl --project-root ..
go run -mod=mod ./cmd/eval --track end-to-end --manifest ../eval/e2e/contract.jsonl --project-root ..
```

The report says `inferenceExecuted: false` by design. Manifest validation alone is not model evaluation and does not produce a qualification result.

### Score model outputs offline

Score one split at a time after an authorized local inference run:

```sh
cd meet-translator/server
go run -mod=mod ./cmd/eval --track mt-only \
  --manifest ../eval/translation/contract.jsonl \
  --score-outputs ../eval/private-data/mt-outputs.jsonl \
  --score-split contract --project-root ..
```

Output rows are keyed by the exact `caseId` and `split`. ASR rows contain `asrText`; MT rows contain `translationText`; E2E rows contain `asrText`, `translationText`, `published`, and the human-reviewed `criticalAssertions` results. The scorer rejects missing, duplicate, unknown, or cross-split outputs. It reports Japanese NFC CER and English NFC/casefold WER separately, MT chrF2 by direction with the SacreBLEU v2.6.0 signature, E2E public-caption scores with withheld or blank translations counted as deletions, publication coverage by direction, critical-assertion failures, and non-speech false outputs. Input SHA-256 values identify the exact manifest and output files. Raw transcripts, source text, translations, and assertion text are omitted from the report.

The output mode is always `score-only-untrusted`, `qualityEvidence=false`, and `productStatus=not-evaluated`. It is a Go implementation of the pinned chrF2 behavior, not a Python SacreBLEU invocation, and cannot qualify a candidate. Synthetic contract fixtures validate metric behavior only. Put consented local evaluation data and output JSONL only under ignored `eval/private-data/`; never add audio, transcripts, or generated results to Git.

Run the model-free integrity checks from the repository root:

```sh
node meet-translator/eval/check-contracts.mjs
node meet-translator/eval/check-research.mjs --offline
node --test meet-translator/eval/*.test.mjs meet-translator/eval/device/*.test.mjs
```

`check-contracts` reports fixture-level schema and hash checks only; product acceptance is recorded separately in `docs/implementation-status.md`. A green fixture check does not imply that the caption UI, local API, publication gate, or model has passed its contract.

## Physical-device browser integration

On the specified M1 Max, the Edge browser fixture can be run separately:

```sh
node meet-translator/eval/device/run-browser-e2e.mjs
```

It uses an isolated Edge profile, a synthetic Meet-hosted page and tone, and a deterministic local API test double. See [`device/README.md`](device/README.md) for scope and exact limitations. A passing browser fixture verifies the extension integration path only; it is not a model-quality or profile-qualification result.

## M1 qualification report gate

The Go evaluator can assess a separately recorded M1 integration report. A
detached attestation must bind the report and the exact output and measurement
artifact bytes:

```sh
cd meet-translator/server
go run -mod=mod ./cmd/eval \
  --qualification-report ../eval/private-data/m1-qualification.json \
  --qualification-attestation ../eval/private-data/m1-qualification.dsse.json \
  --qualification-outputs ../eval/private-data/m1-outputs.jsonl \
  --qualification-measurements ../eval/private-data/m1-measurements.json
```

The assessor returns `REJECTED` (exit 1 for a reported product or quality failure) or `BLOCKED` (exit 2 when evidence is absent, inconsistent, or untrusted). Detached DSSE/Ed25519 verification binds exact report, output, and measurement bytes, but the compiled production trust-key registry is empty and there is no independently approved executor or trusted collector. Consequently the current CLI cannot return `QUALIFIED`; caller-authored fields, local signatures, hashes, or booleans do not prove that a device run occurred. The paths above are examples only. Never construct a report from a unit-test fixture or synthetic Edge run and treat it as device evidence. Keep any genuine local records under ignored `eval/private-data/` and do not commit meeting audio or transcript contents.

### Validate an untrusted process-group measurement record

```sh
cd meet-translator/server
go run -mod=mod ./cmd/eval --measurement-record ../eval/private-data/process-measurements.json
```

This mode strictly validates and summarizes a content-free record with target
hardware/browser metadata, one-second samples, root/process identities,
membership completeness, RSS, optional `phys_footprint`, memory pressure,
swap, warmup and measured durations, and model-release/accelerator observations.
It separates steady-state p95 from a load/stop-inclusive peak and preserves
unknown values as `null`. Sample counts exclude the time-zero baseline. The
record and its summary are caller-editable, always set
`qualificationEvidence=false`, `qualityEvidence=false`, and
`productStatus=not-evaluated`, and are not a live collector or product
qualification result.

The gate requires explicit `testDouble` and `dataset.synthetic` attestations; exact pinned model/runtime/template/options/publication-gate data (runtime revisions must be full immutable commit/content hashes); an identifiable passing published MT benchmark screen; case-level critical-translation review; real Meet and sharing attestations; measured M1 memory/latency/power/accelerator evidence; and verified rollback. Scored-case coverage must match the pinned split per Japanese/English ASR language, MT translation direction, and E2E publication direction. Published-caption metrics must score every E2E speech case, count withheld captions as deletions, reconcile visible and omitted case counts, and show no lower candidate coverage than baseline in total or either direction. All-hold is rejected even if subset metrics claim improvement. The score-only scorer, detached-signature verifier mechanics, report assessor, and untrusted measurement-record analyzer are separate components; none is a trusted collector or a replacement for actual M1, reviewed-data, and Meet evidence.
