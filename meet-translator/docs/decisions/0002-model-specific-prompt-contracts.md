# ADR 0002: Match prompt builders to model-specific instructions

- Status: accepted
- Date: 2026-09-28

## Context

The current native translation path builds raw prompts in Go and sends them through a llama.cpp C API that cannot pass tokenizer chat-template options. R4 review of official cards showed two mismatches: Hy-MT2 was receiving a generic system prompt and a different translation instruction than its documented target-language prompt; Qwen3.5-0.8B was routed through the Qwen3 thinking builder even though its card says the default is non-thinking and the Qwen3 soft switches are unsupported. A separate Qwen3 prompt used `/no-think`; Qwen3 documents `/no_think`.

## Decision

- Give Hy-MT2 and Qwen3.5-0.8B distinct prompt builders that match the official task instructions the local adapter can express.
- Keep Qwen3's model-specific switch separate and spell its documented `/no_think` token exactly.
- Pin synthetic prompt outputs in test fixtures and hash those fixture files. Those hashes identify repository prompt contracts only; they do not identify GGUF tokenizer metadata, prove stop/EOG behavior, or establish model quality.
- Do not change model selection, sampling, runtime, quantization, publication gate, or M1 acceptance limits without the required same-condition evaluation. In particular, the official Qwen3 warning about greedy decoding remains an open baseline risk.

## Consequences

- Model-free tests prove which prompt bytes the repository sends for Hy-MT2 and Qwen3.5-0.8B.
- Candidate records remain DEFERRED because exact artifact hashes, real loading, human-reviewed translation data, and M1 measurements are missing.
- Existing explicit model aliases remain available. Prompt corrections do not qualify a model or constitute a model promotion.

## Revisit when

An authorized local artifact and human-reviewed Japanese/English development/holdout cases are available. Verify tokenization and EOG behavior against that exact file, then run MT-only and end-to-end comparisons with frozen sampling parameters on M1 Max.
