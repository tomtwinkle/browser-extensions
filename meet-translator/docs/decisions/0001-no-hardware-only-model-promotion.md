# ADR 0001: Do not promote models from hardware capacity alone

- Status: accepted
- Date: 2026-09-28

## Context

The server contained RAM/GPU tiers that could select much larger models. The adjacent comments cited old benchmark scores and latency as if they established suitability, but the existing benchmark was translation-only and did not establish current model identity, audio-to-caption quality, or M1 Max integration behavior. The implementation spec fixes resource and quality thresholds and requires model-specific, same-condition evidence before promotion.

## Decision

Keep the existing first-run model identifiers as the reproducibility baseline. Hardware capacity alone will not change them or promote another model. Preserve saved configuration and explicitly supplied model choices. A new selection requires a separate research entry, model/runtime/template pins, track-separated quality evidence, and M1 Max integration evidence.

## Consequences

- Removed the RAM/GPU tier table and corrected the server's stale “auto-upgrade” help text.
- The current baseline is not thereby qualified. Its weight hash, actual runtime loading, quality, memory, latency, and integration remain to be measured.
- New candidates remain deferred while weights are unauthorized/unavailable or evaluation data is insufficient.
- Rollback target for this code decision is repository revision `6ac37a149a0314ba1b989a1c1f66d5dedf35ff47`; it is a source-code recovery point, not proof that old hardware tiers were correct.

## Revisit when

An authorized local model artifact and a reviewed bilingual development/holdout set are available, and a frozen candidate passes the model-specific contract, quality thresholds, M1 resource/latency run, and stop/restore test.
