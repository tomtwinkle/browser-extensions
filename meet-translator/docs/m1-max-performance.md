# M1 Max performance record

## Required profile

`m1-max-balanced` requires Apple M1 Max, 32 GB unified memory, and a 24-core GPU. The thresholds below are qualification criteria from the implementation spec, not measured results:

| Measure | Required threshold |
| --- | ---: |
| Inference process group, steady state p95 over 60 minutes | <= 8 GiB |
| Inference process group peak including load and stop | <= 10 GiB |
| Added Chrome UI memory versus Meet-only baseline | target <= 512 MiB |
| ASR p95 real-time factor on 4–8 second audio | <= 0.5 |
| End of speech to source caption p95 | <= 2 seconds |
| End of speech to translation p95 | <= 3 seconds |
| Sustained run | 60 minutes without crash, OOM, growing queue, or overload audio loss |
| Correction interaction p95 | <= 100 ms |

## Environment observed on 2026-09-28

- Machine: MacBook Pro with Apple M1 Max.
- Memory: 32 GB unified memory.
- GPU: 24 cores; Metal is available.
- Architecture: `arm64`.
- OS: macOS 26.6.2 (build 25G83).
- Chrome build, power mode, battery/AC state, and screen-sharing condition: not recorded.
- Vendored `llama.cpp`: commit `4eb19514dd2984662f13aacbb052c559c8fde3b1`.
- Vendored `whisper.cpp`: commit `9386f239401074690479731c1e41683fbbeac557` (`v1.8.4`).
- Makefile's llama.cpp pin string: `b8699`; this differs from the inspected vendor commit and needs reconciliation before a build/runtime lock is qualified.

The machine matches the required hardware profile, so a future real-device run is possible. No ASR or translation model was loaded for this task. No quality, memory, latency, Metal execution, Meet sharing, or 60-minute endurance result was measured. No benchmark result is inferred from hardware specifications, model size, or third-party reports.

## Qualification run record

There is no `m1Measurement` record yet. Before qualification, freeze model file hashes, runtime commits, quantization, template hash, decode options, gate policy, dataset hash, Chrome/OS versions, AC and power mode, warmup, process measurement method, and test run ID. Measure process-group phys_footprint where available, RSS, memory pressure, swap delta, ASR/translation latency, source and published caption quality, and queue/drop state together.
