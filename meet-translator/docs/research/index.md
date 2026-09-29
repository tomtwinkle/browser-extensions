# Research and selection status

Last primary-source review: **2026-09-29 (R10 and cause-specific addendum)**. R0/R4 covered evaluation harnesses, English/Japanese ASR, small translation models, model-specific instructions, and Apple-silicon runtime options. R5 rechecked VAD and short-speech handling. R6 reviewed candidate preservation, current small-model routes, and in-memory audio APIs. R7 rechecked Qwen3-ASR, Hy-MT2, Apple MLX/MLX-Audio, evaluation guidance, and a Whisper hallucination-mitigation paper. R8 screened newer compact candidates and compression families using published numerical results. R9 rechecked the official CAT-Translate 0.8B and Qwen3.8 FP8 cards and refined the same-benchmark screen. R10 rechecked evaluation validity, WMT holdout design, current ASR/MT cards, and Apple's MLX guidance while closing independent code-review findings. The addendum checked Chrome alarm timing against speaker-batch expiry behavior. These are bounded evidence reviews, not a universal model ranking.

Current profile: **PROFILE_NOT_QUALIFIED**. The available machine matches the M1 Max / 32 GB / 24-core GPU hardware target, but there is no authorized model run, human-reviewed bilingual development/holdout set, quality evaluation, or Meet integration run. Current model identifiers are baselines, not selected models.

The registry contains **64 sources and 10 candidates**. All ten candidates remain `DEFERRED`; none is `SELECTED`. Three public benchmark screens pass: quantized Hy-MT2 1.8B Q4_K_M and compact bilingual CAT-Translate 0.8B and 1.4B. This only admits them to bounded research comparison. The Qwen3.5 0.8B default is retained solely as a reproduction baseline and hidden from selectable model choices. See [`compression-screen.md`](compression-screen.md) for pass/defer/screen-out results by model family.

- Read [`research-log.md`](research-log.md) for each checkpoint's question, primary sources, conclusions, and implementation delta.
- Read [`sources.jsonl`](sources.jsonl) for source owner/type, retrieval date, supported claims, and limitations.
- Read [`candidates.json`](candidates.json) for per-candidate language, artifact, runtime, template, gate, and deferral records.
- Read [`compression-screen.md`](compression-screen.md) for numeric screening rules across quantization, MoE, knowledge distillation, pruning, low-rank factorization, and weight sharing.
- Read [`selection-lock.json`](selection-lock.json) for the source recovery point and explicit unqualified status.
- Run `node eval/check-research.mjs --offline` from this project to validate local record consistency. This check does not browse, fetch weights, run inference, or qualify a candidate.
