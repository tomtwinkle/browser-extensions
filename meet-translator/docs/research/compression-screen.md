# Compression and compact-model benchmark screen

Reviewed: 2026-09-29. This is a published-results pre-screen for bounded local
experiments, not application qualification. Model, artifact, runtime, template,
quality, memory, final-caption latency, and M1 integration gates still apply.

## Screen rule

The comparison profile remains M1 Max / 32 GB / 24-core GPU, one ASR model, one
translator, one small VAD, and a maximum 10 GiB inference-process peak. A model
does not pass because of a parameter label, active-parameter count, file size,
publisher speed claim, or a benchmark from an unrelated language pair.

An experimental compressed translation artifact may enter the bounded shortlist
only when a primary source publishes numeric machine-translation results for
the exact compressed variant and a comparable parent/reference under the same
benchmark and metric. The pre-screen requires at least 95% retention on the
primary translation score and, when the source publishes a second
translation-specific score, at least 90% retention there. Higher-is-better
retention is `variant / reference * 100`; lower-is-better metrics must be
compared as an error ratio or reported as a score reduction, with direction
recorded. A missing comparison is `DEFERRED`; an observed score below the
threshold is screened out of the current shortlist. These thresholds are
project screening rules, not universal quality guarantees.

For compact models that are not compression variants, the screen requires
published Japanese-English translation numbers in both directions, using the
same named benchmark, metric, and reference model. Each direction must meet or
exceed that reference using the metric's correct score direction, and any
reported retention must match the published scores within rounding tolerance.
A score without a clear direction or comparable reference does not meet this
rule. A positive result on only one direction stays `DEFERRED`. Passing this
screen allows a candidate into research comparison only. Local MT-only
evaluation must still use reviewed correct source text and local E2E must still
use speech.

MoE active parameters do not replace total stored parameters when checking the
artifact and process memory budget. For every method, the full runtime process
group must remain below the fixed M1 limits in `m1-max-performance.md`.

## Reviewed shortlist

| Model or artifact | Method | Published evidence | Screen | Local status |
| --- | --- | --- | --- | --- |
| Tencent Hy-MT2 1.8B Q4_K_M | Quantization | The author report gives FLORES-200 82.22 vs BF16 83.49 (98.48% retention), and IFMTBench total 63.47 vs 69.36 (91.51%). | PASS | `DEFERRED`: exact weight hash, runtime/STQ compatibility, template/EOS, reviewed bilingual holdout, and M1 run are missing. |
| CyberAgent CAT-Translate 0.8B | Compact JA↔EN translation model; not a compression claim | Author card reports average BLEU 29.71 JA→EN / 30.68 EN→JA, above TranslateGemma 4B on the same table (29.41 / 26.76). | PASS | `DEFERRED`: exact artifact/tokenizer, Sarashina 2.2 0.5B template, M1 runtime, reviewed local holdout, and integration are missing. |
| CyberAgent CAT-Translate 1.4B | Compact JA↔EN translation model; not a compression claim | Author card reports average BLEU 33.26 JA→EN / 34.19 EN→JA and 33.73 overall. On the same card's benchmark it exceeds TranslateGemma 4B (29.41 / 26.76). | PASS | `DEFERRED`: exact artifact and tokenizer hashes, M1 runtime, reviewed local holdout and integration are missing. |
| Google TranslateGemma 4B | Compact translation fine-tuning; not labelled as a size-compression method by its report | WMT24++ English→Japanese MetricX 4.44 vs Gemma 3 4B 5.09; 55-language COMET22 80.1 vs 77.2. The reviewed 4B report lacks a Japanese→English result. | DEFERRED | Not admitted to the shortlist. Its official card also requires a one-item, language-coded user template and 2K context; terms, exact weights, M1 runtime and local results are unverified. |

The research shortlist has three published-benchmark passes: one quantized
artifact and two compact bilingual model sizes. The two CAT models are research
comparators only; neither is registered as a runtime choice. Qwen3.5 0.8B
remains the configured reproduction baseline, but is hidden from the current
selectable catalog. It is not a published-benchmark pass or a selected model.

## Excluded and deferred findings

| Family or model | Finding | Decision |
| --- | --- | --- |
| Qwen3.8-27B-FP8 | Official card describes block-128 fine-grained FP8 and says general performance is nearly identical to the original, but supplies no numeric JA↔EN translation result or parent comparison. At 27B, raw FP8 weights alone are about 27 GB before scale data and runtime memory. | `DEFERRED`; exceeds the 10 GiB process budget and has no task-specific benchmark evidence. |
| Hy-MT2 1.8B AngelSlim 1.25-bit | The reviewed official materials publish storage and speed claims but no numeric translation-quality score for this exact variant. | `DEFERRED`; no benchmark-based promotion. |
| Hy-MT2-30B-A3B MoE | The paper reports strong multilingual scores, but 30B total parameters must be stored. The 3B active label does not make total weights fit the 10 GiB process peak. | Exclude from the M1 profile. |
| Hy-MT2 1.8B 2-bit | FLORES-200 remains measurable, but IFMTBench total retention is 85.05%, below the 90% secondary floor. | Do not shortlist this variant. |
| Kotoba-Whisper-Bilingual v1.0 | The author card identifies a distilled 0.8B model. Japanese ReazonSpeech held-out CER is 16.8 versus 14.9 for Whisper large-v3 (lower is better). | Screen out as a Japanese ASR replacement; the published Japanese score is worse than the current comparison baseline. |
| TranslateGemma as knowledge distillation | Its report describes supervised fine-tuning and reinforcement learning from a Gemma 3 checkpoint; it does not call this parameter reduction or knowledge distillation. | Keep only as a compact translation comparator, not as a KD result. |
| CAT-Translate and low-rank factorization | The card says LoRA was used during training. The released inference artifact is not a low-rank adapter or factorized model. | Do not classify it as low-rank compression. |
| Shisa V2.1 LFM2 1.2B | The author card reports a Japanese MT-Bench score of 6.69 with the GPT-4-Turbo judge, but the reviewed score does not identify both Japanese→English and English→Japanese results separately. | `DEFERRED`; do not shortlist on an unclear one-direction score. |
| CULL-MT layer pruning | The paper's pruning results cover Persian, French, and German to English; it does not provide Japanese-English measurements for the method. | Do not shortlist for this product. |
| Gemma 4 QAT Q4_0 | The reviewed exact quantized repository does not publish relevant JA↔EN translation quality numbers. | Do not shortlist until exact-variant translation scores exist. |
| Knowledge distillation | Distilled Kotoba-Whisper-Bilingual v1.0 has Japanese CER 16.8 versus 14.9 for Whisper large-v3; no reviewed distilled JA↔EN translation artifact passes the score screen. | Screen out this ASR example; defer translation models without numeric bilingual scores. |
| Pruning | CULL-MT reports Persian/French/German→English results, not Japanese-English. | No model is shortlisted without exact-variant Japanese-English scores against a comparable parent. |
| Low-rank factorization | CAT-Translate reports using LoRA in training, but its released inference weights are not a low-rank adapter or factorized checkpoint. | Do not treat CAT-Translate's scores as evidence for low-rank-compressed inference. |
| Weight sharing | No reviewed exact Japanese-English artifact with a comparable parent score was found. | Defer until a method-specific artifact passes the same numeric screen. |

WMT26's official model-compression shared task evaluates Czech→German,
English→Chinese, and English→Egyptian Arabic. Its framework is useful for
thinking about deployment and quality together, but those language directions
cannot qualify this Japanese-English product.

## M1 and product qualification remain separate

Every `PASS` above means only that a public score justifies spending one slot in
the research comparison budget. No weights were downloaded to the M1 Mac or
committed, and no Gemma terms were accepted. An existing GitHub Actions PR
workflow separately downloaded and cached model weights on remote runners
before it was stopped; those smoke jobs did not evaluate reviewed bilingual
data or qualify any candidate. No local ASR-only, correct-source MT-only, or
audio-to-published caption run was performed for these models. No model was
loaded on M1 Max, and no local memory, Metal execution, caption latency, or Meet
integration result was measured. The selection lock stays `PROFILE_NOT_QUALIFIED`.

Source IDs and limitations are recorded in `research/sources.jsonl`; candidate
details and numeric evidence are in `research/candidates.json`.
