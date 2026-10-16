# ADR 0014: serialize ASR and translation inference

- Status: Accepted
- Date: 2026-09-30
- Scope: `server/main.go`, `server/llama.go`, `server/inference_gate.go`

## Context

The extension currently serializes its audio queue, but the local server also
accepts independent `/transcribe`, `/translate`, and combined requests. The
LLM model mutex protects translation and model replacement; it does not keep
ASR from entering the same Metal/Core ML/MLX device at the same time. Apple
Silicon unified memory and a runtime's internal scheduler do not establish the
product's one-high-load-operation limit.

## Decision

- Give one server process a shared capacity-one inference lane for ASR,
  translation, and raw LLM generation. Hold it from immediately before the
  synchronous backend call until that call returns. Backend callbacks must not
  release the permit merely because the requesting context was cancelled; a
  native or GPU operation may still be running.
- Keep LLM model ownership as a separate cancellable permit. It protects
  model swaps and backend identity while the shared lane protects accelerator
  use. A request waiting for LLM ownership may leave when its context is
  cancelled. The operation that already entered native inference continues to
  hold the shared lane until the backend returns.
- Reject new inference after shutdown begins, close the shared lane, wait for
  active native work, then release model resources.
- Measure queue wait separately from synchronous execution duration. Current
  values are logged only in verbose mode; this is not durable evaluation
  telemetry or adaptive load control.
- Do not claim deadline ordering yet. The implementation does not pass audio
  end deadlines into the server, prioritize earliest deadlines, or break equal
  deadlines in favor of ASR. Those remain T15 work.

## Consequences

The server cannot overlap high-load ASR and translation calls, even when
different HTTP handlers arrive concurrently. A waiting request can time out or
cancel without entering inference. Cancellation during a non-preemptible native
call does not free the lane until the native call has completed. The lane is
process-local and does not measure hidden runtime workers or GPU operations
that outlive the synchronous API call; each backend adapter must preserve the
synchronous-completion contract.

## Evidence

Model-free Go regressions submit 20 `/transcribe` and 20 `/translate` requests
to their actual handlers, verify `max(active inference) == 1`, and confirm all
requests complete. Additional tests cover separate queue/execution durations,
backend error release, timeout and waiter cancellation, cancellation during
native work, old/new session exclusion, shutdown barriers, and cancellable LLM
ownership waits. A canceled translation owner does not add its late result to
shared context history; a surviving identical waiter still receives the
shared result. These tests use deterministic backend doubles and do not prove
model quality, Metal operation, memory, latency, or Google Meet behavior.

## Research boundary

The 2026-09-30 R23 primary-source check found no evidence requiring a model,
runtime, quantization, template, quality threshold, or publication-gate
change. The MLX scheduler documentation does not implement this server gate.
Keep the selection lock at `PROFILE_NOT_QUALIFIED`.
