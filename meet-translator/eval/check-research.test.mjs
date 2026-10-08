import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateResearchState, validateSelectedCandidate } from './check-research.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadState() {
  const research = resolve(root, 'docs/research');
  const [sourcesText, candidatesText, lockText] = await Promise.all([
    readFile(resolve(research, 'sources.jsonl'), 'utf8'),
    readFile(resolve(research, 'candidates.json'), 'utf8'),
    readFile(resolve(research, 'selection-lock.json'), 'utf8'),
  ]);
  const sources = sourcesText.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  return {
    sources,
    registry: JSON.parse(candidatesText),
    lock: JSON.parse(lockText),
    root,
  };
}

test('offline research record is internally consistent and unqualified', async () => {
  const state = await loadState();
  const report = validateResearchState(state);
  assert.equal(report.profileStatus, 'PROFILE_NOT_QUALIFIED');
  assert.equal(report.selected, null);
  assert.ok(report.sourceCount >= 10);
  assert.ok(report.deferredCandidateCount >= 1);
});

test('rejects a candidate whose source id is missing', async () => {
  const state = await loadState();
  state.registry.candidates[0].sourceIds = ['SRC-DOES-NOT-EXIST'];
  assert.throws(() => validateResearchState(state), /unknown sourceId/);
});

test('rejects a compressed model without a positive published benchmark screen', async () => {
  const state = await loadState();
  const candidate = state.registry.candidates.find((item) => item.candidateId === 'hy-mt2-1.8b');
  candidate.compressionMethods = ['quantization'];
  candidate.publishedBenchmarkScreen = {
    policyId: 'published-mt-benchmark-screen-v1',
    decision: 'PASS',
    evidence: [],
  };
  assert.throws(() => validateResearchState(state), /cannot pass without published numeric benchmark evidence/);
});

test('requires bilateral published scores before shortlisting a compact translation model', async () => {
  const state = await loadState();
  const candidate = state.registry.candidates.find((item) => item.candidateId === 'translategemma-4b');
  candidate.publishedBenchmarkScreen.decision = 'PASS';
  assert.throws(() => validateResearchState(state), /same benchmark and metric in both JA↔EN directions/);
});

test('requires compact model scores to meet a same-benchmark reference in both directions', async () => {
  const state = await loadState();
  const candidate = state.registry.candidates.find((item) => item.candidateId === 'cat-translate-1.4b');
  candidate.publishedBenchmarkScreen.evidence[0].relativeRetentionPercent = 99.99;
  assert.throws(() => validateResearchState(state), /requires a published numeric comparison meeting the screen/);
});

test('requires compact-model comparison directions to use one benchmark and metric', async () => {
  const state = await loadState();
  const candidate = state.registry.candidates.find((item) => item.candidateId === 'cat-translate-0.8b');
  candidate.publishedBenchmarkScreen.evidence[1].benchmark = 'Unrelated test set';
  assert.throws(() => validateResearchState(state), /same benchmark and metric in both JA↔EN directions/);
});

test('checks that reported score retention matches the published numeric values', async () => {
  const state = await loadState();
  const candidate = state.registry.candidates.find((item) => item.candidateId === 'cat-translate-0.8b');
  candidate.publishedBenchmarkScreen.evidence[0].relativeRetentionPercent = 110;
  assert.throws(() => validateResearchState(state), /same benchmark and metric in both JA↔EN directions/);
});

test('rejects compressed candidates below the published quality-retention threshold', async () => {
  const state = await loadState();
  const candidate = state.registry.candidates.find((item) => item.candidateId === 'hy-mt2-1.8b');
  candidate.publishedBenchmarkScreen.evidence[0].relativeRetentionPercent = 94.99;
  assert.throws(() => validateResearchState(state), /at least 95% verified retention/);
});

test('rejects a SOURCE_VERIFIED candidate promoted without hashes and M1 evidence', async () => {
  const state = await loadState();
  state.registry.candidates[1].status = 'SELECTED';
  state.lock.status = 'QUALIFIED';
  state.lock.selected = { asrCandidateId: 'qwen3-asr-0.6b', translationCandidateId: 'hy-mt2-1.8b' };
  assert.throws(() => validateResearchState(state), /selected candidate.*requires a pinned/i);
});

test('rejects a selected lock that points at a deferred candidate', async () => {
  const state = await loadState();
  state.lock.status = 'QUALIFIED';
  state.lock.selected = { asrCandidateId: 'qwen3-asr-0.6b', translationCandidateId: 'hy-mt2-1.8b' };
  assert.throws(() => validateResearchState(state), /must be SELECTED/);
});

test('rejects test-double measurement evidence for promotion', async () => {
  const candidate = {
    candidateId: 'test-asr',
    task: 'asr',
    modelRevision: 'a'.repeat(40),
    artifactProvider: 'provider',
    artifactName: 'model.bin',
    artifactHash: 'b'.repeat(64),
    quantization: 'none',
    runtimeId: 'runtime',
    runtimeRevision: 'c'.repeat(40),
    executionBackend: 'Metal',
    dtype: 'fp16',
    languages: ['en', 'ja'],
    auxiliaryModels: [],
    codeLicense: 'MIT',
    weightTerms: 'reviewed',
    redistributionStatus: 'cleared',
    templateHash: 'not-applicable',
    decodeOptions: {},
    gatePolicyId: 'asr-v1',
    datasetHashes: ['d'.repeat(64)],
    evaluationRunIds: ['eval-run-1'],
    m1Measurement: {
      testDouble: true,
      hardware: 'M1 Max',
      os: 'macOS',
      browser: 'Chrome',
      gpu: 'Metal',
      ram: '32 GB',
      powerMode: 'normal',
      runId: 'm1-run-1',
      processes: ['server'],
      memory: {},
      latency: {},
      quality: {},
      evidenceFiles: ['results.json'],
    },
  };
  assert.throws(() => validateSelectedCandidate(candidate), /testDouble/);
});
