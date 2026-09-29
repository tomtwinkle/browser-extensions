# ADR 0009: add an isolated Edge device integration fixture

- Status: Accepted
- Date: 2026-09-29
- Scope: `eval/device/run-browser-e2e.mjs`

## Context

Model-free extension tests did not exercise Edge's real extension loader, native side panel, `tabCapture` permission, local API fetch, or the route from captured audio to private correction and approved captions. Running those checks in the user's normal browser profile could affect unrelated tabs and meetings.

## Decision

Run Edge on the target Mac with a fresh temporary profile, a temporary extension copy, a local HTTPS Meet-host fixture, synthetic tab audio, and a deterministic loopback API. Fail external hostname resolution in the test profile while explicitly permitting the loopback test servers. Remove temporary profile and test server state after each run. Keep model evaluation and profile qualification separate from this fixture.

## Consequences

The suite exercises real Edge APIs and real tab audio capture without joining a meeting, accessing a microphone or camera, or loading a model. It can catch browser integration and privacy-projection regressions. Synthetic ASR/translation output, a DOM fixture, and short test duration cannot establish real Meet compatibility, model quality, inference resource use, or the 60-minute requirement.

## Evidence

The corrected 2026-09-29 M1 Max / Edge 154 run passed 13 checks, including `chrome.sidePanel.open` availability, the manifest permission, and a zero normal-tab count for the side-panel URL, plus four synthetic WAV submissions, correction and undo, approval-only public output, hostile-text safety, silence suppression, and stop/restart. The earlier fixture only checked for a DevTools page target and could not distinguish the normal-tab fallback; R15 records that correction. The report is ignored under `eval/private-data/`.
