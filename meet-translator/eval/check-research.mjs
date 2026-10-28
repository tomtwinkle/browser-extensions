#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const STATUS = new Set([
  'DISCOVERED', 'SOURCE_VERIFIED', 'COMPAT_VERIFIED', 'EVALUATED',
  'QUALIFIED', 'SELECTED', 'REJECTED', 'DEFERRED', 'SCREENED_OUT',
]);
const COMPRESSION_METHODS = new Set([
  'quantization', 'moe', 'knowledge-distillation', 'pruning',
  'low-rank-factorization', 'weight-sharing',
]);
const REQUIRED_CANDIDATE_FIELDS = [
  'schemaVersion', 'candidateId', 'task', 'upstreamModelId', 'modelRevision',
  'artifactProvider', 'artifactName', 'artifactHash', 'quantization', 'runtimeId',
  'runtimeRevision', 'executionBackend', 'dtype', 'languages', 'streamingKind',
  'auxiliaryModels', 'codeLicense', 'weightTerms', 'redistributionStatus',
  'sourceIds', 'sourceCheckedAt', 'templateHash', 'decodeOptions', 'gatePolicyId',
  'datasetHashes', 'evaluationRunIds', 'm1Measurement', 'status', 'reasonCodes',
  'reconsiderWhen',
];
const HASH = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{7,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function retentionMatchesPublishedScores(item) {
  if (item.higherIsBetter !== true || !Number.isFinite(item.value) || !Number.isFinite(item.referenceValue) || item.referenceValue <= 0 || !Number.isFinite(item.relativeRetentionPercent)) return false;
  const computed = (item.value / item.referenceValue) * 100;
  return Math.abs(computed - item.relativeRetentionPercent) <= 0.02;
}

export function validateSelectedCandidate(candidate) {
  assert(REVISION.test(candidate.modelRevision ?? ''), `selected candidate ${candidate.candidateId} requires a pinned modelRevision`);
  assert(typeof candidate.artifactProvider === 'string' && candidate.artifactProvider.trim(), `selected candidate ${candidate.candidateId} requires artifactProvider`);
  assert(typeof candidate.artifactName === 'string' && candidate.artifactName.trim(), `selected candidate ${candidate.candidateId} requires artifactName`);
  assert(HASH.test(candidate.artifactHash ?? ''), `selected candidate ${candidate.candidateId} requires a pinned artifactHash`);
  assert(typeof candidate.quantization === 'string' && candidate.quantization.trim(), `selected candidate ${candidate.candidateId} requires quantization`);
  assert(typeof candidate.runtimeId === 'string' && candidate.runtimeId.trim(), `selected candidate ${candidate.candidateId} requires runtimeId`);
  assert(REVISION.test(candidate.runtimeRevision ?? ''), `selected candidate ${candidate.candidateId} requires a pinned runtimeRevision`);
  assert(typeof candidate.executionBackend === 'string' && candidate.executionBackend.trim(), `selected candidate ${candidate.candidateId} requires executionBackend`);
  assert(typeof candidate.dtype === 'string' && candidate.dtype.trim(), `selected candidate ${candidate.candidateId} requires dtype`);
  assert(Array.isArray(candidate.languages) && candidate.languages.includes('en') && candidate.languages.includes('ja'), `selected candidate ${candidate.candidateId} requires verified en/ja languages`);
  assert(Array.isArray(candidate.auxiliaryModels), `selected candidate ${candidate.candidateId} requires an explicit auxiliaryModels list`);
  assert(typeof candidate.codeLicense === 'string' && candidate.codeLicense.trim(), `selected candidate ${candidate.candidateId} requires codeLicense`);
  assert(typeof candidate.weightTerms === 'string' && candidate.weightTerms.trim(), `selected candidate ${candidate.candidateId} requires reviewed weightTerms`);
  assert(candidate.redistributionStatus === 'cleared', `selected candidate ${candidate.candidateId} requires cleared redistributionStatus`);
  assert(candidate.task === 'asr' || HASH.test(candidate.templateHash ?? ''), `selected translation candidate ${candidate.candidateId} requires a pinned templateHash`);
  assert(candidate.task !== 'asr' || candidate.templateHash === 'not-applicable', `selected ASR candidate ${candidate.candidateId} must explicitly mark templateHash not-applicable`);
  assert(candidate.decodeOptions !== null && candidate.decodeOptions !== undefined, `selected candidate ${candidate.candidateId} requires pinned decodeOptions`);
  assert(typeof candidate.gatePolicyId === 'string' && candidate.gatePolicyId.trim(), `selected candidate ${candidate.candidateId} requires gatePolicyId`);
  assert(Array.isArray(candidate.datasetHashes) && candidate.datasetHashes.length > 0 && candidate.datasetHashes.every((hash) => HASH.test(hash)), `selected candidate ${candidate.candidateId} requires pinned datasetHashes`);
  assert(Array.isArray(candidate.evaluationRunIds) && candidate.evaluationRunIds.length > 0, `selected candidate ${candidate.candidateId} requires evaluationRunIds`);

  const measurement = candidate.m1Measurement;
  assert(measurement && typeof measurement === 'object', `selected candidate ${candidate.candidateId} requires m1Measurement`);
  assert(measurement.testDouble === false, `selected candidate ${candidate.candidateId} m1Measurement must have testDouble=false`);
  for (const field of ['hardware', 'os', 'browser', 'gpu', 'ram', 'powerMode', 'runId', 'processes', 'memory', 'latency', 'quality', 'evidenceFiles']) {
    assert(measurement[field] !== null && measurement[field] !== undefined, `selected candidate ${candidate.candidateId} m1Measurement requires ${field}`);
  }
  assert(Array.isArray(measurement.evidenceFiles) && measurement.evidenceFiles.length > 0, `selected candidate ${candidate.candidateId} requires M1 evidence file references`);
}

export function validateResearchState({ sources, registry, lock }) {
  assert(Array.isArray(sources), 'sources.jsonl must contain a JSON object per line');
  const sourceIds = new Set();
  for (const source of sources) {
    assert(source.sourceId && !sourceIds.has(source.sourceId), `duplicate or missing sourceId ${source.sourceId ?? ''}`);
    sourceIds.add(source.sourceId);
    assert(typeof source.canonicalUrl === 'string' && source.canonicalUrl.startsWith('https://'), `source ${source.sourceId} requires canonical https URL`);
    for (const field of ['owner', 'kind', 'title']) assert(typeof source[field] === 'string' && source[field].trim(), `source ${source.sourceId} requires ${field}`);
    assert(DATE.test(source.retrievedAt ?? ''), `source ${source.sourceId} requires retrievedAt`);
    assert(Array.isArray(source.supportingClaims) && source.supportingClaims.length > 0, `source ${source.sourceId} requires supportingClaims`);
    assert(Array.isArray(source.limitations) && source.limitations.length > 0, `source ${source.sourceId} requires limitations`);
  }

  assert(registry?.schemaVersion === 1, 'candidate registry schemaVersion must be 1');
  assert(Array.isArray(registry.candidates) && registry.candidates.length > 0, 'candidate registry is empty');
  const candidates = new Map();
  for (const candidate of registry.candidates) {
    assert(candidate.schemaVersion === 1, `candidate ${candidate.candidateId ?? ''} schemaVersion must be 1`);
    for (const field of REQUIRED_CANDIDATE_FIELDS) assert(Object.hasOwn(candidate, field), `candidate ${candidate.candidateId ?? ''} missing ${field}`);
    assert(typeof candidate.candidateId === 'string' && !candidates.has(candidate.candidateId), `duplicate or missing candidateId ${candidate.candidateId ?? ''}`);
    assert(STATUS.has(candidate.status), `candidate ${candidate.candidateId} has invalid status ${candidate.status}`);
    assert(['asr', 'translation'].includes(candidate.task), `candidate ${candidate.candidateId} has invalid task`);
    assert(Array.isArray(candidate.sourceIds) && candidate.sourceIds.length > 0, `candidate ${candidate.candidateId} requires sourceIds`);
    for (const sourceId of candidate.sourceIds) assert(sourceIds.has(sourceId), `candidate ${candidate.candidateId} references unknown sourceId ${sourceId}`);
    assert(DATE.test(candidate.sourceCheckedAt ?? ''), `candidate ${candidate.candidateId} requires sourceCheckedAt`);
    assert(Array.isArray(candidate.datasetHashes) && candidate.datasetHashes.every((hash) => HASH.test(hash)), `candidate ${candidate.candidateId} contains an invalid dataset hash`);
    assert(Array.isArray(candidate.evaluationRunIds), `candidate ${candidate.candidateId} evaluationRunIds must be an array`);
    assert(Array.isArray(candidate.compressionMethods), `candidate ${candidate.candidateId} compressionMethods must be an array`);
    for (const method of candidate.compressionMethods) assert(COMPRESSION_METHODS.has(method), `candidate ${candidate.candidateId} has unknown compression method ${method}`);
    if (candidate.compressionMethods.length > 0 || candidate.publishedBenchmarkScreen !== null) {
      const screen = candidate.publishedBenchmarkScreen;
      assert(screen && typeof screen === 'object', `candidate ${candidate.candidateId} requires publishedBenchmarkScreen`);
      assert(screen.policyId === 'published-mt-benchmark-screen-v1', `candidate ${candidate.candidateId} requires published-mt-benchmark-screen-v1`);
      assert(['PASS', 'DEFERRED', 'SCREENED_OUT'].includes(screen.decision), `candidate ${candidate.candidateId} has invalid benchmark screen decision`);
      assert(Array.isArray(screen.evidence), `candidate ${candidate.candidateId} benchmark evidence must be an array`);
      for (const item of screen.evidence) {
        assert(sourceIds.has(item.sourceId), `candidate ${candidate.candidateId} benchmark evidence references unknown sourceId ${item.sourceId}`);
        assert(candidate.sourceIds.includes(item.sourceId), `candidate ${candidate.candidateId} benchmark evidence source ${item.sourceId} must be listed in sourceIds`);
        assert(typeof item.benchmark === 'string' && item.benchmark.trim(), `candidate ${candidate.candidateId} benchmark evidence requires benchmark`);
        assert(typeof item.metric === 'string' && item.metric.trim(), `candidate ${candidate.candidateId} benchmark evidence requires metric`);
        assert(Number.isFinite(item.value), `candidate ${candidate.candidateId} benchmark evidence requires a finite numeric value`);
      }
      if (screen.decision === 'PASS') {
        assert(screen.evidence.length > 0, `candidate ${candidate.candidateId} cannot pass without published numeric benchmark evidence`);
        assert(candidate.status !== 'SCREENED_OUT', `candidate ${candidate.candidateId} with passing benchmark screen cannot be SCREENED_OUT`);
        if (candidate.task === 'translation' && candidate.compressionMethods.length === 0) {
          const sameBenchmarkBilateralComparison = screen.evidence.some((jaEn) => {
            if (jaEn.direction !== 'ja->en' || typeof jaEn.referenceModel !== 'string' || !jaEn.referenceModel.trim() || !retentionMatchesPublishedScores(jaEn) || jaEn.relativeRetentionPercent < 100) return false;
            return screen.evidence.some((enJa) => enJa.direction === 'en->ja'
              && enJa.benchmark === jaEn.benchmark
              && enJa.metric === jaEn.metric
              && enJa.referenceModel === jaEn.referenceModel
              && retentionMatchesPublishedScores(enJa)
              && enJa.relativeRetentionPercent >= 100);
          });
          assert(sameBenchmarkBilateralComparison, `compact translation candidate ${candidate.candidateId} requires a published numeric comparison meeting the screen on the same benchmark and metric in both JA↔EN directions`);
        }
        if (candidate.compressionMethods.length > 0) {
          const primary = screen.evidence.filter((item) => item.screenRole === 'primary');
          assert(primary.some((item) => retentionMatchesPublishedScores(item) && item.relativeRetentionPercent >= 95), `compressed candidate ${candidate.candidateId} requires at least 95% verified retention on a primary published translation score`);
          for (const item of screen.evidence.filter((entry) => entry.screenRole === 'secondary')) {
            assert(retentionMatchesPublishedScores(item) && item.relativeRetentionPercent >= 90, `compressed candidate ${candidate.candidateId} requires at least 90% verified retention on each secondary published translation score`);
          }
        }
      }
      if (screen.decision === 'SCREENED_OUT') {
        assert(candidate.status !== 'SELECTED', `candidate ${candidate.candidateId} screened out by published benchmarks cannot be SELECTED`);
        assert(candidate.status === 'SCREENED_OUT', `candidate ${candidate.candidateId} with a screened-out benchmark must have SCREENED_OUT status`);
      }
      if (candidate.status === 'SCREENED_OUT') {
        assert(screen.decision === 'SCREENED_OUT', `candidate ${candidate.candidateId} with SCREENED_OUT status requires a screened-out benchmark decision`);
      }
      if (candidate.status === 'SELECTED') {
        if (candidate.compressionMethods.length > 0) {
          assert(screen.decision === 'PASS', `selected compressed candidate ${candidate.candidateId} requires a passing published benchmark screen`);
        }
      }
    } else {
      assert(candidate.compressionMethods.length === 0, `compressed candidate ${candidate.candidateId} requires publishedBenchmarkScreen`);
    }
    candidates.set(candidate.candidateId, candidate);
  }

  assert(lock?.schemaVersion === 1, 'selection lock schemaVersion must be 1');
  assert(lock.profileId === registry.profileId, 'selection lock and registry profileId differ');
  assert(['PROFILE_NOT_QUALIFIED', 'QUALIFIED'].includes(lock.status), `unsupported selection lock status ${lock.status}`);
  assert(REVISION.test(lock.rollback?.sourceRevision ?? ''), 'rollback requires an exact repository sourceRevision');
  assert(lock.rollback?.qualified === false || lock.rollback?.qualified === true, 'rollback requires an explicit qualified flag');
  for (const candidateId of [lock.baseline?.asrCandidateId, lock.baseline?.translationCandidateId]) {
    assert(candidates.has(candidateId), `selection lock references unknown baseline candidate ${candidateId}`);
  }

  const selectedCandidates = registry.candidates.filter((candidate) => candidate.status === 'SELECTED');
  if (lock.selected === null) {
    assert(lock.status === 'PROFILE_NOT_QUALIFIED', 'a null selected profile must be PROFILE_NOT_QUALIFIED');
    assert(selectedCandidates.length === 0, 'candidate registry has SELECTED candidate while selection lock is empty');
  } else {
    assert(lock.status === 'QUALIFIED', 'a selected profile must have QUALIFIED status');
    const ids = [lock.selected.asrCandidateId, lock.selected.translationCandidateId];
    assert(ids[0] && ids[1] && ids[0] !== ids[1], 'selection lock must name one ASR and one translation candidate');
    const [asr, translation] = ids.map((id) => candidates.get(id));
    assert(asr && translation, 'selection lock references an unknown candidate');
    assert(asr.task === 'asr' && translation.task === 'translation', 'selection lock candidate task mismatch');
    for (const candidate of [asr, translation]) {
      assert(candidate.status === 'SELECTED', `candidate ${candidate.candidateId} must be SELECTED`);
      validateSelectedCandidate(candidate);
    }
    assert(lock.selected.evaluationRunId, 'selected profile requires a combined ASR/translation evaluationRunId');
    assert(lock.selected.rollbackVerified === true, 'selected profile requires rollbackVerified=true');
  }

  return {
    sourceCount: sources.length,
    candidateCount: registry.candidates.length,
    deferredCandidateCount: registry.candidates.filter((candidate) => candidate.status === 'DEFERRED').length,
    publishedBenchmarkPassCount: registry.candidates.filter((candidate) => candidate.publishedBenchmarkScreen?.decision === 'PASS').length,
    profileStatus: lock.status,
    selected: lock.selected,
  };
}

async function readInputs(root) {
  const researchDir = resolve(root, 'docs/research');
  const [sourcesText, candidatesText, lockText] = await Promise.all([
    readFile(resolve(researchDir, 'sources.jsonl'), 'utf8'),
    readFile(resolve(researchDir, 'candidates.json'), 'utf8'),
    readFile(resolve(researchDir, 'selection-lock.json'), 'utf8'),
  ]);
  const sources = sourcesText.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`sources.jsonl line ${index + 1}: ${error.message}`); }
  });
  return { sources, registry: JSON.parse(candidatesText), lock: JSON.parse(lockText) };
}

async function main() {
  if (!process.argv.includes('--offline')) {
    throw new Error('usage: node meet-translator/eval/check-research.mjs --offline');
  }
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const report = validateResearchState(await readInputs(projectRoot));
  process.stdout.write(`${JSON.stringify({ mode: 'offline-research-check', ...report }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
