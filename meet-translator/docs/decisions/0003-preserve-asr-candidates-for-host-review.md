# ADR 0003: Preserve ASR candidate text for private host review

- Status: accepted
- Date: 2026-09-28

## Context

At the inspected `whisper.cpp` revision, the native decoder can use no-speech probability and average log probability to suppress segment text before the bridge sees it. Those values are model-specific evidence, but this project has no human-reviewed Japanese Meet dataset to calibrate a destructive publication threshold. The task requires host review and retaining uncertain candidates; an upstream heuristic must not make a plausible transcript disappear before review.

The app also has optional ASR backends. Their confidence values and output shapes do not have Whisper's semantics. Applying the Whisper thresholds to another backend would invent a quality meaning the other model does not provide.

## Decision

- Apply the source patch `server/patches/whisper-preserve-candidate-text.patch` to the pinned vendored `whisper.cpp` build. The patch prevents the no-speech decoder condition from removing decoded candidate text, while preserving decoder fallback behavior.
- Return available segment timing, average log probability, and no-speech probability in the ASR response. A value the backend does not expose remains `null`.
- Use Whisper's initial score thresholds only to add private review reasons. They are uncalibrated diagnostics; they do not discard candidates or auto-publish them.
- Require explicit host approval before creating a public caption projection. Corrections increment `sourceRevision`, and older translation results cannot replace the current revision.
- Do not apply Whisper thresholds to SenseVoice, WhisperX alternatives, Qwen, Nemotron, or another ASR backend. Each requires its own score contract and calibration evidence.

The current patch SHA-256 is `9c277e88879b63c8822ffa3548e45d25441b2def9558d698626ba068cbcdd941`. The exact upstream source revision is recorded in `docs/research/candidates.json` and `docs/research/sources.jsonl`.

## Consequences

- Weak or hallucinated text may reach the host-only correction history. The public presenter remains limited to explicitly approved records.
- The native adapter now retains more output than the upstream default suppression path. This changes review workload, not model accuracy or qualification.
- Python adapters preserve available timing and report unavailable confidence values as null. Not every adapter currently has equivalent segment metadata.
- Regression tests exercise the bridge output and private candidate lifecycle, but no ASR model was loaded and no real speech quality was measured.
- The M1 profile stays `PROFILE_NOT_QUALIFIED`; there is no evidence that this change improves WER, hallucination rate, latency, memory, or Meet behavior.

## Revisit when

An authorized, human-reviewed Japanese/English development and holdout set is available. Compare candidate retention and review reasons with a frozen model/runtime on speech and non-speech cases, measure the review burden, and verify that the explicit public approval gate remains intact. Any changed threshold must be Whisper-specific and must not be inferred from another backend.

## Rollback

Revert this ADR's change by removing the source patch application and patch file, then rebuild from the pinned upstream source. The source recovery point for the overall task is `6ac37a149a0314ba1b989a1c1f66d5dedf35ff47`; neither that commit nor this rollback procedure contains or qualifies model weights.
