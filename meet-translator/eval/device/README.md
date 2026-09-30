# M1 Max Edge browser integration fixture

Run from the repository root on the target Mac:

```sh
node meet-translator/eval/device/run-browser-e2e.mjs
```

The runner requires macOS on an Apple M1 Max with 32 GB memory and a 24-core GPU, plus Microsoft Edge at `/Applications/Microsoft Edge.app`. It verifies the machine profile before starting.

The test reads Edge's version from its app-bundle metadata and starts it through macOS Launch Services (`open -n -g -a`) with a new temporary profile and a copied extension. On normal completion, it asks that isolated browser to close through its DevTools connection, waits for processes using the unique profile to exit, and removes the scratch directory. It never sends a PID-based termination signal. If matching processes remain or their exit cannot be confirmed, it retains the profile and reports cleanup failure. It serves a local HTTPS page at the exact `meet.google.com` host, plays a synthetic 440 Hz tab tone, and uses a deterministic loopback API test double for ASR and translation. Host resolver rules route the fixture host to loopback and fail closed for other DNS names. No Google account, real Meet room, microphone, camera, meeting recording, model weights, or external API is used. The temporary profile, certificate, extension ID, API token, and servers are removed when the runner exits cleanly.

The suite exercises settings save, authenticated local API access, Edge's native correction side panel, the actual `tabCapture` path, private candidate review, correction and undo, explicit caption approval, safe rendering of hostile-looking text, silence suppression, stop, and restart. The side-panel check requires Edge to expose `chrome.sidePanel.open`, verifies the manifest permission, waits for the panel page target, and confirms that the page was not opened as a normal browser tab. A DevTools target alone is insufficient because the unsupported-browser fallback also creates that target. A test-only extension shortcut is dispatched through the isolated browser's DevTools session to invoke the action and satisfy Edge's `activeTab` requirement.

The generated report is written to the ignored `meet-translator/eval/private-data/device-browser-e2e.json`. Its Edge process-tree RSS is browser/test-fixture memory only; it is not model inference memory.

A `PASS` means this Edge extension path and synthetic audio fixture ran on the stated physical Mac. The API returns deterministic test output, so the run does not evaluate ASR or translation quality, model-specific prompts or EOS behavior, inference latency, Metal execution, model memory, real Google Meet compatibility, screen sharing, or the 60-minute load profile. It cannot change the `PROFILE_NOT_QUALIFIED` selection lock.
