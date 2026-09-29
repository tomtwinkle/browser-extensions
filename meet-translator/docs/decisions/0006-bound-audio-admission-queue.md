# ADR 0006: bound local audio queue admission

- Status: Accepted
- Date: 2026-09-29
- Scope: `extension/background.js`, `extension/sidepanel.js`

## Context

The serial Promise chain retained each incoming audio closure while waiting for
local ASR/translation work. Speaker batching also retained WAV data after its
queue callback returned, so its audio was absent from the admission counters.
A delayed batch alarm could then process stale audio outside the bound.

## Decision

- Limit queued, running, and speaker-batched audio to four items and 10 seconds
  of audio in aggregate. Keep each admission reservation until inference ends
  or its batch is explicitly cleared.
- Drop an audio item as `STALE` when it is older than five seconds at admission
  or when it reaches the head of the queue. Recheck the oldest reservation
  before a speaker batch is inferred.
- Drop an item as `OVERLOAD` when adding it exceeds either queue limit.
- Report the cumulative drop reason, count, and audio duration only to the
  private correction UI. Do not send transcript or audio data in this status.
- After awaiting a speaker-change or maximum-duration flush, recheck the
  incoming item's session and stream generation before retaining it in a new
  batch. A stopped or superseded stream must not recreate retained audio.

## Consequences

The audio queue and in-memory speaker batches share the same count, duration,
and age limits. The 1.2-second idle flush uses a one-shot service-worker timer
instead of `chrome.alarms`, which Chrome limits to 30-second intervals in
production. The original admission time remains authoritative at flush. If the
service worker unexpectedly terminates, the in-memory timer and batch can be
lost; there is no persistent replay of meeting audio. Hosts can see overload or
stale drops while the worker is active. This is visible loss handling, not a
quality improvement.

This is a partial T15 implementation. Translation deduplication/deadlines,
evaluation telemetry, a shared inference lock, adaptive load control, and
in-flight cancellation remain open. It does not qualify latency or memory on
M1 Max; the profile remains `PROFILE_NOT_QUALIFIED`.

## Evidence

Model-free tests verify item/duration rejection for queued and speaker-batched
audio, stale rejection after a delayed flush timer, private-only status
delivery, the UI's count/duration message, and stop during an in-flight
speaker-change flush. The stop-race test reproduced a retained batch before
the fix and verifies that batch and queue reservations are released after the
fix. Chrome documents the service worker idle and timer lifecycle in
`SRC-CHROME-SW-LIFECYCLE` and `SRC-CHROME-SW-MIGRATE`; actual Chrome timing
remains unmeasured.
