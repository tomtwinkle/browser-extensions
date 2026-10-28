# ADR 0019: carry server inference durations into private evaluation telemetry

- Status: Accepted
- Date: 2026-10-28
- Scope: successful local ASR/translation responses and private extension telemetry
- Requirements: implementation-spec.md §2.4, §8.3, T15

## Context

The shared inference gate already measures queue wait and synchronous operation
duration, but only verbose logs expose them. The extension measures audio and
translation admission waits and request completion using its own clock. Those
intervals cannot identify how much time was spent waiting inside the server.
Translation also waits for model ownership before joining the inference gate.

## Decision

Add optional `inference_timing` metadata to successful `/transcribe`,
`/translate`, and `/transcribe-and-translate` JSON responses. Existing response
fields remain unchanged. The envelope has `schema_version: 1` and entries only
for successfully completed `asr` and/or `translation` operations.

| Wire field | Meaning |
| --- | --- |
| `operation_id` | Random 16-byte identifier, encoded as 32 lowercase hexadecimal characters; contains no request or model content. |
| `queue_wait_ms` | Time waiting for the server's shared inference permit. |
| `execution_ms` | Duration of the synchronous callback while holding that permit. |
| `model_ownership_wait_ms` | Translation only: time acquiring LLM model ownership before waiting for the inference permit. |

Compute durations using Go's monotonic clock within the server process and
serialize nonnegative integer milliseconds. Sub-millisecond durations may be
zero. Missing timing stays absent; it is not a measured zero. Do not compare
browser wall-clock timestamps with server timestamps.

The single-flight result includes its completed translation operation's timing.
All surviving subscribers receive the same operation ID and intervals, even if
the first subscriber cancels. Consumers counting executed operations must
deduplicate by operation ID. This does not turn subscriber response wait into
backend execution time. Failed model-identity retry attempts are not included
in the successful final operation's measurements.

The extension validates the schema, operation ID, and integer durations. It
records an allowlisted `server_inference_finished` event with
`queueName=server_inference`, `timingSource=server_monotonic`, and an explicit
ASR/translation stage. The original case/session/configuration and translation
source revision accompany the event. A reply from a replaced run or session
cannot enter the new run. Unknown or malformed optional metadata is ignored
without rejecting otherwise valid captions or translations.
The event's `atMs` is browser receipt/record time, not server completion time.

Keep these events in the existing bounded, private session store and explicit
private-panel export. Do not add them to caption records, public payloads,
model prompts, or remote services. Preserve the existing error responses and
raw-generation response, gate exclusion, cancellation, and model ownership.

## Limits and remaining work

`execution_ms` measures the gated callback, including ASR preparation/mutex
work or an explicitly requested translation model swap. It is not isolated
GPU time, independently instrumented GPU completion, visible-caption latency,
or the full HTTP request duration. Error/canceled responses have no timing
export; this is successful-response diagnostic coverage only.

Existing `asr_finished`/`translation_finished` durations measure extension-side
stage/job elapsed time, including local request/response handling and awaited
translation result handling such as caption-store updates. They are not isolated
HTTP measurements. Keep these intervals separate from server timings; their
difference does not isolate network overhead.

The load controller continues to use extension audio-admission wait. This
change does not implement earliest-deadline scheduling, resource-pressure
collection, safe model unload, or durable trusted execution evidence. Session
storage/export remains bounded and caller-editable. T15 stays PARTIAL, S1 stays
IN_PROGRESS, and the profile remains `PROFILE_NOT_QUALIFIED`.

## Evidence and research

Model-free regressions exercise actual handlers with controlled blocked
operations, ownership/gate wait separation, combined and skipped stages,
cancellation, shared-flight survival, and exact wire fields. Extension tests
exercise live and corrected captions, private export, legacy/malformed metadata,
distinct extension-side stage/job durations, and late-run exclusion. Final execution results belong
in implementation-status.md rather than being inferred from test definitions.

[Go 1.23.0 time documentation](https://pkg.go.dev/time@go1.23.0) defines the
process-local monotonic-clock behavior used here. R30 in the research log
records the current harness, ASR, translation, and runtime sources and their
limits. No model/runtime/template/gate pin or product threshold changes.
