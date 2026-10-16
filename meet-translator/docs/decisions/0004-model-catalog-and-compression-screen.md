# ADR 0004: prune visible model choices and screen compact variants

- Status: Accepted
- Date: 2026-09-29
- Scope: `meet-translator/server/model_manager.go`, research records, model documentation

## Context

The M1 Max profile allows one local ASR model, one translator, one small VAD,
and at most 10 GiB peak memory for the complete inference process group. Model
names and releases can change; the active profile must be qualified by measured
quality, memory, latency, runtime, and Meet integration rather than by release
date or parameter labels.

The prior catalog exposed superseded Whisper sizes, older Qwen generations,
duplicate Hy-MT2 aliases, and translators whose sizes or runtime contracts had
not been shown to fit the profile. New saved settings still need to resolve
without silent changes.

## Decision

Hide superseded, duplicate, unsupported, and out-of-band model identifiers from
the selectable catalog. Keep existing explicit identifiers resolvable with a
compatibility warning. Retain Qwen3.5 0.8B only as the existing reproduction
baseline; do not present it as a current experimental recommendation.

Require a primary-source numeric screen before a compact translation model can
consume an experimental comparison slot:

- For exact compressed variants, require a comparable parent result, at least
  95% retention on a primary translation metric, and at least 90% on each
  reported secondary translation-specific metric.
- For compact non-compression translation models, require named benchmark
  results in both Japanese→English and English→Japanese directions.
- MoE capacity checks use all stored parameters and the complete inference
  process budget, not active parameters alone.
- A published screen pass admits a model to local research comparison only; it
  does not qualify or select a runtime configuration.

The current public screen admits Hy-MT2 1.8B Q4_K_M as a quantized candidate
and CAT-Translate 0.8B and 1.4B as compact bilingual comparators. CAT-Translate
is not classified as a compression method. Qwen3.8-27B-FP8 stays deferred
because it exceeds the process budget and its official card lacks numeric
Japanese-English translation evidence. Other method families stay deferred or
screened out unless matching numeric Japanese-English evidence appears.

## Consequences

The candidate registry now records compression method, source-linked numeric
evidence, screen decision, and rationale. Offline checks reject unsupported
passes, one-direction compact translation passes, and compressed results below
the declared retention floors. Model documentation no longer recommends the
old sizes, duplicate aliases, or oversized models.

No model weights, terms, runtime, template, inference gate, or published
caption gate were promoted. All candidate records remain `DEFERRED`, the model
selection lock remains `PROFILE_NOT_QUALIFIED`, and the baseline source recovery
point remains `6ac37a149a0314ba1b989a1c1f66d5dedf35ff47`.

## Evidence and limitations

The numerical screen is based on author-published benchmarks, not this
application's meeting corpus. It does not establish tokenizer/EOS behavior,
artifact license compatibility, M1 memory or latency, Metal execution, Meet
sharing, or the final caption publication criteria. These are required before
any candidate can be selected.
