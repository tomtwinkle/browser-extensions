# ADR 0015: add private evaluation telemetry and queue load controls

- Status: Accepted
- Date: 2026-10-07
- Scope: `extension/background.js`, `extension/evaluation-telemetry.js`, `extension/load-control.js`, private side panel
- Requirement: `docs/implementation-spec.md` §2.5

## Context

The extension had queue limits and private drop counts, but it could not
reconstruct a model-free evaluation run's stage timing or explain why an item
was dropped, held, rejected, or superseded. The specification also requires
queue-driven reduction of optional work and a user-controlled translation
pause/recovery path. It separately requires process-group memory and system
pressure handling, which the extension does not currently have a provider or
a safe native model-release API to implement.

## Decision

- Store a bounded allowlist of content-free events in `chrome.storage.session`.
  Export is an explicit action from the private correction side panel. No
  event sends data to a remote service or enters the public caption projection.
- Keep event names and timing stages distinct: audio admission/start/finish,
  ASR, translation queue/execution, approval, correction/undo, caption store
  publication event, rejection/hold/drop, and load-control transitions. The
  `caption_publication_event` is recorded before the store update is sent to
  connected clients; it does not measure visible DOM rendering completion.
- Label the observed configuration with a deterministic FNV-1a 32-bit ID and
  `configCoverage=partial`. This value is not a complete model/runtime/template/
  decoding/gate fingerprint, trusted provenance, or tamper-resistant run ID.
- Measure only the extension serial audio-admission queue for the local
  adaptive controller. Treat an observed 900–1,500 ms interval as a
  consecutive sample for its nominal 1,000 ms cadence; intervals outside that
  range reset consecutive windows. Three consecutive waits strictly greater
  than 2,000 ms stop optional experiments/diagnostics. After at least 10
  seconds, three consecutive samples each strictly greater than 2,000 ms pause
  new translation admission and mark pending translations `paused`, preserving
  approved source text. Explicit resume is allowed only after the existing 30-second
  normal-memory condition and ASR queue wait below 500 ms; old translations
  are not resubmitted. The recorded queue source is `extension_audio_admission`,
  not the Go/native inference lane.
- Keep the memory-pressure branch as a model-free policy contract only. It
  represents the specified two consecutive one-second samples over 10 GiB or
  critical pressure, admission blocking, one model-release request, ASR stop
  after five seconds, and user resume after recovery. Production has no
  process-group memory/pressure input and no safe unload call. When a release
  effect is requested, record that it is unavailable; do not claim that the
  model or an active native operation was safely stopped or released.

## Consequences

The private bounded event history can support offline stage analysis without
persisting meeting text or audio. Session storage and the explicit export path
are not durable across all browser lifecycle events and are not a signed
measurement archive. Partial IDs are useful for grouping observations, not
for proving that a complete configuration stayed fixed. Queue-driven
translation pause is wired to the extension's serialized admission path, but
does not establish native inference queue time or M1 behavior. The memory
policy is not operational until a process-group/pressure source and safe
model-lifecycle integration exist.

## Evidence

Model-free regression tests verify allowlisted storage, restore/capacity,
private export, absence of sensitive text fields, reason-specific queue
events, correction and approval outcomes, publication-event timing labels,
specification threshold boundaries, pending translation hold, preserved
source text, and explicit resume without requeue. Focused C3 tests passed
16/16 and the full extension suite passed 107/107 on 2026-10-07. These tests
do not establish actual rendering latency, memory pressure response, safe
model unload, model quality, accelerator use, real Meet behavior, or an M1
qualification.

## Research boundary

The 2026-10-07 primary-source check was `NO_MATERIAL_CHANGE` to the model,
runtime, quantization, template, quality threshold, or publication decision.
The implementation follows the repository-as-record and machine-checkable
feedback practices described in OpenAI's engineering article without adding
its internal infrastructure. Keep all 10 candidates `DEFERRED`, zero
`SELECTED`, and `PROFILE_NOT_QUALIFIED`.
