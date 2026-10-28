# ADR 0008: open private corrections in the Edge side panel

- Status: Accepted
- Date: 2026-09-29
- Scope: `extension/manifest.json`, `extension/popup.js`

## Context

The private correction view should stay beside the Meet tab during review. Opening a regular tab forces users to leave the meeting context and makes the requested side-by-side review harder.

## Decision

Register `sidepanel.html` as the extension's default Edge side panel and request the `sidePanel` permission. The popup opens that panel for the active tab. Keep a regular extension-page fallback for browsers that do not expose `chrome.sidePanel.open()`.

## Consequences

Private candidate review remains in a trusted extension page alongside Meet; the public caption presenter remains a separate page and channel. Edge's native side panel is covered by the physical-device browser fixture.

## Evidence

Microsoft Edge's extension documentation specifies the manifest permission, `side_panel.default_path`, and `sidePanel.open()` interaction model. The M1 Max Edge 154 fixture verified the panel target opens and initializes. This does not claim compatibility with a real Meet room or an installed-store extension build.
