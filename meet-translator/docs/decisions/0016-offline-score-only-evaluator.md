# ADR 0016: add a reproducible offline score-only evaluator

- Status: Accepted
- Date: 2026-10-07
- Scope: `server/cmd/eval`, Go module metadata, evaluation documentation
- Requirement: `docs/implementation-spec.md` §§8.3–8.7, 13, 16

## Context

The repository had track manifests but no scorer for local ASR/translation
outputs. Evaluation needs to keep Japanese and English ASR, both MT directions,
and both end-to-end directions separate. Held or blank public translations must
count as deletions, and aggregate quality must not improve by silently dropping
cases or withholding captions. No reviewed development/holdout corpus or
authorized model weights are available, so this change must not claim product
quality.

## Decision

- Add a JSONL score-only path that joins one manifest split to output records by
  exact case ID and split, rejecting missing, duplicate, unknown, wrong-track,
  and cross-split rows.
- Use NFC code-point CER for Japanese, NFC plus Unicode case-fold WER for
  English, and direction-specific chrF2 ported from SacreBLEU v2.6.0. Record
  the chrF2 settings/signature, reference count, case totals, and input hashes.
- Score every E2E speech case using public output. A withheld or blank
  translation is an empty public hypothesis; a blank translation is not a
  published-caption coverage success. Compare total and directional coverage
  against the same manifest/split baseline and reject all-hold output.
- Keep negative critical-assertion case IDs and counts, and non-speech false
  output counts, without copying source, transcript, translation, or assertion
  text into the report.
- Label every output `score-only-untrusted`, `qualityEvidence=false`, and
  `productStatus=not-evaluated`. This scorer does not modify product quality
  thresholds or the qualification gate.
- Pin `golang.org/x/text` v0.28.0, whose module declares Go 1.23.0, for NFC and
  Unicode case folding. Keep Go commands in module mode without replacing the
  repository's native C++ vendor tree.

## Consequences

Offline synthetic tests can now verify metric arithmetic, Unicode behavior,
case coverage, and publication accounting. The Go implementation follows the
pinned chrF2 source semantics and does not invoke the SacreBLEU Python package.
The evaluator can read private data locally, but its report is never trusted
execution evidence. Only authorized local inference outputs and human-reviewed
data could provide meaningful quality results, and neither was run here.

## Evidence

The 2026-10-07 source review pinned SacreBLEU v2.6.0's chrF implementation at
commit `2277caccfc7b956671a6a09f1646f62250034157`. Its defaults are character
order 6, word order 0, beta 2, mixed case, whitespace excluded, and
effective-order scoring. For multiple references, the implementation chooses
the best-scoring reference per segment and aggregates those statistics.
Go `x/text` v0.28.0 separately documents NFC normalization and Unicode case
folding; folding does not normalize text by itself. Source IDs and exact queries
are recorded in `docs/research/research-log.md` R26 and `sources.jsonl`.

Focused `cmd/eval` model-free tests passed after the latest scorer change.
They are arithmetic/contract fixtures, not a human-reviewed speech corpus,
model-quality result, M1 measurement, or Meet integration qualification.
Full-suite verification and independent review remain pending.
