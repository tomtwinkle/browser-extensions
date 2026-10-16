# ADR 0017: keep execution provenance fail-closed until a trusted runner exists

- Status: Accepted
- Date: 2026-10-07
- Scope: `server/cmd/eval` qualification evidence
- Requirement: `docs/implementation-spec.md` §9

## Context

The qualification command reads a caller-provided JSON file. The caller can
edit that file and can edit this local workspace. Hashes detect byte changes
only when compared to a value held independently; booleans such as `trusted`,
`synthetic`, or `executionVerified` do not prove what ran. There is no
independently operated measurement runner, signing key, or trusted-key
provisioning process in this repository.

The userland machine can record M1/Edge details and run the local scorer, but a
same-user process cannot independently attest that a modified report, binary,
or process tree represents a real model/Meet run. Therefore this task cannot
provision a production signing identity or enable `QUALIFIED`.

## Executor and verifier boundary

- **Executor owner:** No approved trusted executor is currently assigned or
  provisioned. The existing Go evaluation CLI is the report consumer, not an
  independently trusted collector. A future runner must be selected and
  operated outside the caller-editable report path before its public key can
  enter the source-controlled trust set.
- **Caller-editable inputs:** Qualification JSON, detached DSSE envelope,
  output/evidence files, model/runtime labels, timestamps, hashes, and local
  code are caller-editable in the present environment.
- **Executor direct observations required for future qualification:** exact
  report/output/measurement bytes; run ID; immutable executor revision;
  device/OS/browser and accelerator observations; pinned model/runtime/template/
  decode/gate configuration; manifest and asset hashes; monotonic start/end;
  process exit status; measured outputs, memory/pressure/queue/media samples;
  and scorer result. A trusted collector must create the signed payload from
  those observations rather than sign a report supplied by the caller.
- **Independent verifier checks:** exact report SHA-256 and run ID; a full
  executor code revision; a DSSE signature over its application-specific
  payload type and exact serialized bytes; signer identity against a
  source-controlled trust anchor; environment/configuration/manifest/output/
  measurement digests; interval and exit status; explicit `testDouble=false`
  and `synthetic=false`; and agreement with the report's dataset/test-double
  attestations. Envelope `keyid` is an unauthenticated hint and is not a trust
  decision.
- **Caller-authored report rejection:** the CLI never accepts an input public
  key or a caller-selected trust-store path. The compiled production trust
  registry is intentionally empty, so report-only input and signatures from
  unregistered keys remain `BLOCKED`. Test-generated keys exercise mechanics
  only and are not production anchors.

## Decision

Implement a detached DSSE v1 / Ed25519 verifier that binds the exact report
digest and run ID plus collector metadata. Keep report-only assessment blocked.
When no independently trusted key is provisioned, a signed bundle also remains
blocked. Continue to classify detected product/quality violations as
`REJECTED` when the report assessor has sufficient evidence; missing or
untrusted provenance is `BLOCKED`.

This decision implements verification mechanics, not a trusted measurement
collector. The executor, signing-key custody, attested Apple hardware/Metal
execution, and retained output/measurement artifacts remain unverified.

## Consequences

The verifier can detect report swaps, wrong run IDs, altered hashes, malformed
envelopes, untrusted signers, and missing collection fields. It cannot make an
unsigned local report trustworthy, attest a software-only process against a
same-user administrator, or prove an API/dataset/model label is true. Adding a
production key requires a separate approved runner and a documented
provisioning/revocation process; it is not inferred from this unit test.

## Implementation follow-up (2026-10-08)

The verifier now requires both the exact output artifact and the exact
measurement artifact whenever a detached attestation is supplied. It hashes
their raw bytes and checks those hashes against the signed payload; an
attestation without either artifact is rejected. Report-only assessment
continues to be blocked. The production trust registry remains empty, so
test-key success verifies mechanics only and no local report can qualify.

The current M1 resource schema is an untrusted caller-editable input and does
not substitute for an independently operated collector. The full requirements,
R28 source recheck, and exact test evidence are recorded in
`docs/research/research-log.md` and `docs/implementation-status.md`.

### R29 review follow-up (2026-10-08)

The verifier now strictly decodes the measurement artifact as a
`MeasurementRunRecord`, validates its sample schedule, process identities, and
required warmup/measured/stop coverage, and binds its run ID and reported
warmup/measured durations to the signed report. The signed start/end interval
must also extend through the final measurement sample. A regression test
rejects a one-second attestation for a 62-minute artifact and rejects an
artifact whose measured duration differs from the report. The production trust
registry remains empty; test-key success still cannot qualify a run.

## Research and evidence

On 2026-10-07, RFC 8032, the DSSE protocol, and Go's Ed25519 standard-library
documentation were reviewed alongside the required current harness, ASR,
compact translation, and Apple runtime sources. DSSE authenticates the payload
type and exact body bytes; its `keyid` is unauthenticated. A signature does not
establish executor identity unless the verifier already trusts the signer.
R27 source details and exact queries are recorded in
`docs/research/research-log.md` and `docs/research/sources.jsonl`.

Model/runtime/candidate/quality/publication thresholds remain unchanged. No
model weights, evaluation data, or real-M1 inference were used. A test key can
verify cryptographic binding in a model-free test but cannot qualify the
product. The current product status remains `PROFILE_NOT_QUALIFIED`.
