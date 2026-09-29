# Manual test plan

All audio and meeting tests use a consented test meeting and known test audio. Do not use ordinary meeting recordings in repository fixtures. The measurements below remain blocked until the local model and dataset are authorized and prepared.

## M1 Max integration run

1. Record macOS, Chrome, M1 Max/32 GB/24-core GPU, AC state, power mode, browser profile, display size, and selected audio streams.
2. Compare Meet with the extension inactive against the extension active under the same network, room, window, and 720p target. Include four participants and a shared caption tab no larger than 1920x1080.
3. Open the private correction view. Confirm it is not shown in the shared tab.
4. Run two minutes of warmup and sixty minutes of measurement. Include 50% voiced audio, a two-minute 80% voiced period every ten minutes, short/long utterances, silence, overlap, and both mic and tab capture.
5. Every five minutes, correct a source, undo it, and register a terminology correction. Separately test stop/restart, mute, tab reload, and permission revocation.
6. Record p50/p95/max for end-of-speech to source/translation display, ASR RTF, UI response, queue wait, and stage durations. Record process-group memory, system pressure, swap delta, queue depth, drops, errors, and observed Meet audio/video changes.
7. Fail on OOM, sustained queue growth, normal-load OVERLOAD, silent translation stalls, old-revision display, or steady-state/peak budget breaches. Do not treat a lower publication rate as an accuracy or capacity improvement.

## Browser and privacy checks

- Start, update, edit, and stop without posting to Meet/Chat or changing chat input focus/value/selection.
- Open the caption-share tab explicitly; confirm the UI does not imply that screen sharing has started. Select it manually in Meet.
- Confirm the public tab shows only approved caption text and never plays audio.
- Keep a draft open while new results arrive. Verify the active element, draft value, selection, and selected segment stay fixed. Press Enter during IME composition and verify it does not save.
- Correct a source and verify the prior translation disappears until the matching revision completes. Undo and verify the intended source/glossary revision returns.
- Stop, revoke mic publication, and restart. Confirm stale results and previously private candidates are not published.
- Attempt an unauthenticated request, a wrong token, invalid Origin/Host, and an oversized audio body. Verify explicit rejection and no transcript/secret in ordinary logs.
- Enter hostile-looking HTML in source and translation fixtures. Verify they render as text.

## Candidate model check

Do not run until the candidate weights and evaluation assets are authorized. Load from local files only; disable network access for model execution. Confirm the intended arm64/Metal path, no silent CPU fallback, exactly one ASR and one translation model resident, safe stop/release, and repeatable start/stop. A smoke test is not a qualification run.
