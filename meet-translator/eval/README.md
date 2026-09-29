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
node --test meet-translator/eval/*.test.mjs
```

`check-contracts` reports fixture-level schema and hash checks only; product acceptance is recorded separately in `docs/implementation-status.md`. A green fixture check does not imply that the caption UI, local API, publication gate, or model has passed its contract.
