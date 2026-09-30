# Evaluation harness

The tracks are intentionally separate:

- `asr-only/`: fixed audio to reference transcript.
- `translation/`: human-reviewed source text to one or more reference translations.
- `e2e/`: fixed audio through ASR, translation, and the public-output decision.

The JSONL files currently contain synthetic contract fixtures only. The 100 ms silence WAV checks local path/hash handling and is not a speech-quality example. There is no authorized human-reviewed development/holdout speech corpus, so no real ASR, translation, publication-quality, or M1 model comparison has been run.

Validate each track's schema, split isolation, and local asset hash from the server module directory:

```sh
cd meet-translator/server
go run ./cmd/eval --track asr-only --manifest ../eval/asr/contract.jsonl --project-root ..
go run ./cmd/eval --track mt-only --manifest ../eval/translation/contract.jsonl --project-root ..
go run ./cmd/eval --track end-to-end --manifest ../eval/e2e/contract.jsonl --project-root ..
```

The report says `inferenceExecuted: false` by design. Manifest validation is not model evaluation and does not produce a qualification result. Model output adapters, reproducible scoring, SacreBLEU version/signature, M1 measurements, and final holdout procedure remain implementation work. Put consented local evaluation data only under ignored `eval/private-data/`; never add audio, transcripts, or generated results to Git.

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

The Go evaluator can assess a separately recorded M1 integration report:

```sh
cd meet-translator/server
go run ./cmd/eval --qualification-report ../eval/private-data/m1-qualification.json
```

This mode validates one strict JSON report and returns `REJECTED` (exit 1 for a reported product or quality failure) or `BLOCKED` (exit 2 when evidence is absent, inconsistent, or untrusted). It cannot currently return `QUALIFIED`: the repository has no trusted evidence collector or provenance verifier, so caller-authored report fields cannot establish that a run actually occurred. Do not treat hashes or booleans written into JSON as proof of execution. The report path above is an example only; no qualified-run report currently exists. Never construct a report from the unit-test fixture or synthetic Edge run and treat it as device evidence. Keep genuine local reports under ignored `eval/private-data/` and do not commit meeting audio or transcript contents.

The gate requires explicit `testDouble` and `dataset.synthetic` attestations; exact pinned model/runtime/template/options/publication-gate data (runtime revisions must be full immutable commit/content hashes); an identifiable passing published MT benchmark screen; case-level critical-translation review; real Meet and sharing attestations; measured M1 memory/latency/power/accelerator evidence; and verified rollback. Scored-case coverage must match the pinned split per Japanese/English ASR language, MT translation direction, and E2E publication direction. Published-caption metrics must score every E2E speech case, count withheld captions as deletions, reconcile visible and omitted case counts, and show no lower candidate coverage than baseline in total or either direction. All-hold is rejected even if subset metrics claim improvement. A trusted collector, provenance verifier, output adapters, and scorer remain unimplemented; the report validator cannot replace them.
