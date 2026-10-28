# ADR 0011: require explicit opt-in for CI model downloads

- Status: Accepted
- Date: 2026-09-30
- Scope: `.github/workflows/execute-test.yml`

## Context

The repository's `Execute Test` workflow ran its model matrix automatically on
every pull request. Its setup downloaded and loaded real Whisper, ASR, and
translation model artifacts on remote runners and stored them in GitHub Actions
caches. This exceeded the documented rule that new model weights may be
prepared only within an explicitly authorized retrieval scope. The model
matrix's silent-audio/startup checks also do not establish Japanese-English
quality or M1 Max qualification.

Run `36590879953` for PR #74 created 23 remote cache entries totaling
17,275,817,804 bytes. The SenseVoice job was canceled while its `model.pt`
download showed 44% (415 MiB of 936 MiB); other matrix jobs had completed.
Those cache entries remain until separately removed.

## Decision

Keep binary build jobs on pull requests, but skip the model-running `execute`
matrix for pull-request events. Expose the matrix only through `workflow_dispatch`
with a required boolean `allow_model_weight_downloads`, defaulting to `false`.
An authorized operator must explicitly set it to `true` before that workflow
downloads or loads model weights.

## Consequences

Ordinary PR CI remains model-free and can still build the native binaries. The
remote model smoke matrix is available when weight acquisition is explicitly
authorized, but its results still cannot substitute for human-reviewed
bilingual evaluation or the integrated M1 Max / Google Meet test. Existing
remote caches are not automatically deleted by this change.

## Evidence

The workflow condition gates the model matrix on a manual event and explicit
true input. Local application tests and the isolated M1 Edge fixture remain
separate evidence; this workflow change creates no model-quality result.
