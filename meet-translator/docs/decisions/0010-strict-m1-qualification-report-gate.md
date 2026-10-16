# ADR 0010: require complete evidence for M1 qualification

- Status: Accepted
- Date: 2026-09-29
- Scope: `server/cmd/eval/qualification.go`, `eval/README.md`

## Context

The M1 acceptance conditions span dataset authorization, three distinct evaluation tracks, real Meet integration, exact model/runtime/template/gate pins, sustained resource measurements, accelerator verification, and rollback. The synthetic Edge fixture and manifest checker do not produce this evidence. A missing or aggregate-only result must not be mistaken for a passing configuration.

## Decision

Add a strict report assessor that returns `BLOCKED` for missing, synthetic, inconsistent, unpinned, or untrusted evidence and `REJECTED` for measured product or quality failures. The assessor requires the exact translation candidate to identify a passing published-score screen, separates raw ASR scores from public-caption scores, and verifies all scored case counts against each pinned split: ASR by Japanese/English, MT by translation direction, and E2E by publication direction. It also compares critical translation failures by reviewed case ID. Runtime pins must be full immutable commit/content hashes. Published-caption metrics must cover every end-to-end speech case; withheld captions count as deletions, visible/omitted counts must reconcile, and candidate coverage may not fall below baseline. All-hold is rejected even if subset metrics claim improvement.

The assessor consumes one recorded JSON report. The report-only interface has no trusted executor provenance verifier, so caller-authored fields cannot be promoted to `QUALIFIED`; until a trusted collector and verifier exist, an otherwise-passing report remains `BLOCKED` (a report that declares a measured violation is `REJECTED`). Missing `testDouble` or `dataset.synthetic` fields also block instead of defaulting to a real-run claim. The assessor does not run Edge or Meet, capture measurements, load models, or score model output. It does not change model selection, published-score screening, product thresholds, or the production caption publication policy.

## Consequences

The assessor can make incomplete evidence fail closed and gives CI a deterministic `BLOCKED` / `REJECTED` result. `QUALIFIED` is unreachable from the current caller-supplied report path by design. A valid unit-test fixture is only a test of assessor logic; it is not a signed measurement or a device result. Qualification still requires an authorized real M1 Max run and verifiable backing artifacts. The current profile remains `PROFILE_NOT_QUALIFIED`.

## Evidence

Focused Go tests cover absent/positive synthetic attestations, caller-authored report blocking, missing benchmark-screen identity, exact per-language ASR, per-direction MT, and published-caption case counts, all-hold and mass-withholding rejection, immutable runtime pins, model/gate pins, case-level critical failures, and measured resource failures. No qualification report has been produced from real model and Meet measurements.
