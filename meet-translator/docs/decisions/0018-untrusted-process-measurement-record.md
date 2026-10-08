# ADR 0018: keep local process measurements untrusted until a collector exists

- Status: Accepted
- Date: 2026-10-08
- Scope: `server/cmd/eval` process-group resource measurement records
- Requirement: `docs/implementation-spec.md` §2.4 and §9

## Context

The repository needs a reproducible way to validate process-group resource
samples without downloading model weights, controlling Edge/Meet, or claiming
that caller-authored data is a real M1 run. No independently trusted host
collector, executor, or production signing key is provisioned. The current
environment also has no available Computer Use permission for the Edge/Meet
integration path.

## Decision

Implement a strict, content-free record analyzer. It validates the specified
M1 Max / 32 GiB / 24-core GPU / arm64 hardware fields and Edge version, power
conditions, model-release observation, accelerator observation, sample
intervals, and process identities. Process membership is joined by PID and
process start time; incomplete process membership suppresses process-group
aggregates. A nominal 1,000 ms sample interval permits 900–1,500 ms between
samples. Qualification requires at least two minutes of warmup and 60 minutes
of measured time, plus a post-measurement stop sample.

The analyzer reports RSS and available `phys_footprint` separately. Steady
state p95 uses only samples after warmup through the measured interval; peak
uses every sample, including initial/load and post-measurement/stop samples.
Unavailable footprint or pressure remains `null`; missing footprint is never
inferred from RSS. Counts for warmup, measured, and stop samples are reported
separately, excluding the time-zero baseline. The summary identifies process
membership completeness without claiming that every resource signal was
available.

Every record and summary remains `qualificationEvidence=false`,
`qualityEvidence=false`, and `productStatus=not-evaluated`. It is a schema
validator and aggregator, not a live macOS/Edge collector, quality scorer,
latency instrument, hardware attestation, or trusted execution provenance.
The production trust-key registry remains empty under ADR 0017.

## Alternatives considered

- **Treat a local `ps`/memory snapshot as M1 product evidence:** rejected;
  caller-editable process data cannot establish which model ran or whether a
  measured process tree was complete.
- **Fill missing `phys_footprint`, pressure, or accelerator data from RSS,
  booleans, or hardware names:** rejected; unavailable evidence stays unknown.
- **Claim a live collector now:** rejected because there is no approved
  executor, independent trust anchor, or accessible real Meet run.

## Consequences

The analyzer and its tests can catch malformed sample schedules, unstable PID
identities, incomplete process membership, overflow, and incorrect p95/peak
aggregation before a trusted collection path is designed. These checks do not
qualify a model, runtime, publication gate, or M1 performance profile. Actual
M1 model memory, power, accelerator use, latency, Meet media, and 60-minute
combined operation remain blocked or not run.

The parent-chain check also rejects a process whose recorded start time is
earlier than its parent, at any depth. Adjacent sample spacing is explicitly
bounded to 900–1,500 ms (inclusive), matching the specification. Regression
tests cover direct-child and nested-child time inversions, plus both spacing
boundaries and out-of-range samples.

## Evidence

The 2026-10-08 model-free checks and limitations are recorded in
`docs/implementation-status.md`. R28 rechecked Apple’s Core ML Xcode report
documentation: it covers load/prediction timing and CPU/GPU/Neural Engine
placement on a selected device, but not memory or power. No model weights,
audio, or evaluation data were used for this decision.
