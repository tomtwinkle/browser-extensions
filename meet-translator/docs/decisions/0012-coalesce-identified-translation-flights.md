# ADR 0012: coalesce only identified in-flight translations

- Status: Accepted
- Date: 2026-09-30
- Scope: `server/main.go`, `server/translation_flight.go`, `extension/background.js`

## Context

The translation endpoint could run duplicate requests for the same live
segment while adding the same source/translation pair to global context more
than once. A global text cache would incorrectly cross sessions, stream
generations, corrections, glossary changes, and model configurations.

## Decision

- Coalesce concurrently active translations only. Remove the entry as soon as
  its inference completes, whether it succeeds or fails; do not cache results.
- Build an opaque SHA-256 key from translation input and source text, language
  direction, session, audio source, stream generation, segment, source revision,
  effective model/runtime/quantization/template, decoded model options,
  generation limits, and hashes of the exact context-history snapshot and
  translation glossary prompt used by the owner.
- Require a complete session/stream/generation/segment/revision/source identity
  before allowing requests to join. Assign a per-request nonce otherwise, so
  legacy or incomplete requests cannot share work across unrelated callers.
- Let the first request own inference, the existing model lock, and the single
  context-history update. Other callers wait for its result. A waiter's request
  cancellation returns only that waiter and never cancels work for the owner or
  remaining waiters.
- Snapshot context history and glossary prompt before identity construction,
  hash both snapshots into the key, and pass those same snapshots to inference.
  A retry joins only when its actual prompt context also matches; if ambient
  history changed while the owner waited for the model lock, the retry starts a
  distinct flight instead of receiving output based on an older context.
- Preserve support for clients that omit the new form fields. The extension now
  sends source and revision metadata for live and corrected translations.
- Keep model-specific prompt/template handling unchanged. `canonicalLlamaSpec`
  now preserves an empty model value instead of treating it as an alias for an
  arbitrary registry entry.

## Consequences

Twenty simultaneous requests for one fully identified segment execute one
translation and add one history entry. Failure leaves no flight behind, so a
retry can run. A canceled waiter does not interrupt the shared inference. The
single-flight does not implement the separate pending-translation queue,
8-item cap, 3-second wait limit, or audio-end-plus-8-second stale limit; those
remain T15 work. Server-wide ASR/translation GPU exclusion also remains open.

## Evidence

Focused Go tests vary each source, history, and inference identity dimension,
verify that two requests with changed history snapshots do not join while one
waits for the model lock, and verify one inference/context side effect for 20
matching callers. Failure retry and waiter cancellation are also covered. The
duplicate-join and history-snapshot tests pass under `go test -race`. Extension
tests verify the source/session/revision fields are sent without logging
transcript content. All 3 Go packages and all 83 extension tests pass. These
are model-free concurrency and API contract tests; they provide no
translation-quality or M1 inference evidence.
