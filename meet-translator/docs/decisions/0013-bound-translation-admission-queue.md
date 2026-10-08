# ADR 0013: bound extension translation admission

- Status: Accepted
- Date: 2026-09-30
- Scope: `extension/background.js`, `extension/offscreen-vad.js`, `extension/offscreen.js`, `extension/sidepanel.js`

## Context

Server-side in-flight translation coalescing is recorded in ADR 0012. The
extension also needs a bounded admission point so obsolete pending caption
translations do not accumulate or overwrite a newer source revision. The
existing audio lane remains serial while this queue is introduced; this
decision does not enable overlapping ASR and MT.

## Decision

- Keep at most eight not-yet-started translation jobs. The active translation
  is not part of this pending count. A corrected-caption translation reserves
  its slot as soon as its caption record is available, before waiting behind
  the audio lane, and retains the action timestamp for stale checks.
- Scope revision handling by session, stream, generation, and segment. Keep
  the newest pending source revision for that scope. Reject a lower revision;
  coalesce an identical request at the same revision; reject a conflicting
  same-revision request rather than sharing an unsafe result. A newer revision
  replaces only older pending work. An already active request can finish, but
  caption-store revision checks prevent it from updating a newer source.
- The extension request identity includes session/stream/generation/segment,
  source revision and source text, translation direction, server URL, and
  historical-source policy. The server's ADR 0012 identity additionally
  covers the effective model, runtime, quantization, template, decode options,
  and glossary prompt. Neither layer caches completed translations.
- At dispatch, mark a pending item stale only when its queue age is strictly
  greater than 3,000 ms or, for audio-derived work, strictly greater than
  8,000 ms from the VAD's last voiced frame. These limits are already in
  `implementation-spec.md` §2.5. The wall-clock `audioEndedAtMs` is transient
  metadata used only for expiry; do not persist or publish it as caption data.
- On stale expiry or overflow, retain the original source and mark only its
  translation failed. Report the count/reason to the private correction UI;
  do not send transcript or audio content in queue status.
- Clear pending live work for a stopped session. A running request may finish,
  but existing session/generation/source-revision guards prevent stale writes.
- Keep translation work inside the current serial audio lane. Decoupling ASR
  and MT or allowing concurrent accelerator work requires the separate C2
  shared-inference decision and tests.
- Admit a correction as a not-ready queue item immediately. A short callback
  scheduled on the serial audio lane marks it ready when that lane reaches the
  correction, then awaits that job's promise before releasing the lane. The
  scheduler may run another ready job around a waiting correction reservation,
  but it never starts inference from the correction before its serial-lane
  callback or allows the next ASR task to overlap its MT.
- Independently bound correction activation callbacks waiting in the audio
  promise chain to eight. Hold each reservation until its callback is consumed,
  even if expiry or a newer source revision has already removed the translation
  job. When the callback reaches the lane, it skips a job no longer present in
  the pending translation queue. This keeps repeated expired corrections from
  building an unbounded chain of zero-audio tasks and preserves later ASR access.

## Consequences

The bounded scheduler is model-free and adds no persistent cache or API field.
Fake-clock tests cover D-1/D/D+1 for both limits, pending capacity, source
revision replacement, stale-source preservation, and the most recent voiced
frame timestamp for speaker batches. A held-lane regression repeatedly expires
corrections, verifies the activation callback count remains capped, and confirms
reservations drain when the lane resumes. Focused extension tests verify that
drop status stays private. These tests do not measure production latency, queue
pressure under an M1 model, translation quality, or Google Meet behavior.

## Evidence

The extension regression suite passed 86/86, including correction admission,
stale-slot release, the bounded activation callback backlog, runnable-work
progress around a not-ready correction, and an ASR/MT serial-lane overlap
regression. Queue expiry is separately identified from source-revision
supersession so the side panel reports a failed translation without falsely
claiming that the corrected source changed. The displayed drop count is labeled
as a cumulative total, and the latest category is shown separately so mixed
stale/overload events are not attributed to one category. Focused correction
admission and expiry-reason UI tests passed; bridge, VAD, and side-panel
tests passed 16/16. The full
results and the unchanged `PROFILE_NOT_QUALIFIED` status are recorded in
`implementation-status.md`. No model or evaluation data was loaded.
