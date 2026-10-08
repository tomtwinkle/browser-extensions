# ADR 0005: reserve capture start before asynchronous work

- Status: Accepted
- Date: 2026-09-29
- Scope: `extension/background.js`

## Context

Capture startup performs health checks, settings reads, offscreen setup, and an
audio-start request. The previous implementation set `isStarting` only after
the first two asynchronous steps. Two start commands could therefore race, and
failure cleanup from one command could stop the other command's valid session.

## Decision

Set the start reservation synchronously before the first await. Reject another
start while that reservation is held. On failure, clean up only the session
owned by that attempt, and send `stop-audio` only if that attempt sent or began
the `start-audio` request.

## Consequences

Overlapping popup or retry commands cannot replace a live start attempt. A
health-check failure does not issue an offscreen stop that could affect another
session. A failed attempt releases its reservation in `finally`.

This protects lifecycle integrity; it does not establish browser/Meet startup
reliability or model performance. The M1 profile remains
`PROFILE_NOT_QUALIFIED`.

## Evidence

A regression test holds the health request open, attempts a second start, then
fails the first request and verifies the start lock is released.
