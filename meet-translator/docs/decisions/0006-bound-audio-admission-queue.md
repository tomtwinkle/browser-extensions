# ADR 0006: bound local audio queue admission

- Status: Accepted
- Date: 2026-09-29
- Scope: `extension/background.js`, `extension/sidepanel.js`

## Context

The serial Promise chain retained each incoming audio closure while waiting for
local ASR/translation work. A slow local inference path could accumulate audio
and stale captions without a bound or visible indication.

## Decision

- Limit queued and running audio requests to four items and 10 seconds of audio
  in aggregate.
- Drop an audio item as `STALE` when it is older than five seconds at admission
  or when it reaches the head of the queue.
- Drop an item as `OVERLOAD` when adding it exceeds either queue limit.
- Report the cumulative drop reason, count, and audio duration only to the
  private correction UI. Do not send transcript or audio data in this status.

## Consequences

The queue no longer grows without bound from incoming audio events, and hosts
can see when audio was dropped. Some utterances may be discarded during model
overload, so this is visible loss handling, not a quality improvement.

This is a partial T15 implementation. Translation deduplication/deadlines,
evaluation telemetry, a shared inference lock, adaptive load control, and
in-flight cancellation remain open. It does not qualify latency or memory on
M1 Max; the profile remains `PROFILE_NOT_QUALIFIED`.

## Evidence

Model-free tests verify item/duration rejection, stale rejection, private-only
status delivery, and the UI's count/duration message.
