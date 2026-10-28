#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, sep, isAbsolute } from 'node:path';

const EXPECTED_TRACKS = ['asr-only', 'mt-only', 'end-to-end'];
const HASH = /^[0-9a-f]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withinRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`));
}

async function verifyLocalAudio(root, item) {
  assert(typeof item.audioRef === 'string' && item.audioRef.length > 0, `case ${item.caseId} requires audioRef`);
  assert(!item.audioRef.includes('://') && !item.audioRef.includes('\\'), `case ${item.caseId} audioRef must be a local POSIX path`);
  assert(!item.audioRef.startsWith('/') && !item.audioRef.split('/').includes('..'), `case ${item.caseId} audioRef must stay under the project root`);
  assert(HASH.test(item.audioSHA256 ?? ''), `case ${item.caseId} requires lowercase SHA-256 audio hash`);
  const projectPath = resolve(root, item.audioRef);
  assert(withinRoot(root, projectPath), `case ${item.caseId} audioRef escapes the project root`);
  const resolvedRoot = await realpath(root);
  let current = resolvedRoot;
  for (const component of item.audioRef.split('/')) {
    current = resolve(current, component);
    const info = await lstat(current);
    assert(!info.isSymbolicLink(), `case ${item.caseId} audioRef must not traverse symlinks`);
  }
  const resolvedAudio = await realpath(projectPath);
  assert(withinRoot(resolvedRoot, resolvedAudio), `case ${item.caseId} audioRef resolves outside the project root`);
  const digest = createHash('sha256').update(await readFile(resolvedAudio)).digest('hex');
  assert(digest === item.audioSHA256, `case ${item.caseId} audio hash mismatch: got ${digest}`);
}

function validateCase(item, requestedTrack) {
  assert(item.track === requestedTrack, `case ${item.caseId} track mismatch: expected ${requestedTrack}, got ${item.track}`);
  assert(item.schemaVersion === 1, `case ${item.caseId} has unsupported schemaVersion`);
  assert(item.split === 'contract' && item.fixtureKind === 'synthetic', `case ${item.caseId} is not a synthetic contract fixture`);
  assert(item.annotationStatus === 'contract-test', `case ${item.caseId} must use contract-test annotation status`);
  assert(item.annotationVersion, `case ${item.caseId} requires annotationVersion`);
  assert(['en', 'ja'].includes(item.sourceLanguage), `case ${item.caseId} requires en/ja source language`);
  if (requestedTrack === 'mt-only' || requestedTrack === 'end-to-end') {
    assert(['en', 'ja'].includes(item.targetLanguage) && item.targetLanguage !== item.sourceLanguage, `case ${item.caseId} requires a distinct en/ja target language`);
  }
  if (requestedTrack === 'mt-only') {
    assert(typeof item.sourceText === 'string' && item.sourceText.trim(), `case ${item.caseId} requires correct sourceText`);
    assert(Array.isArray(item.referenceTranslations) && item.referenceTranslations.length > 0, `case ${item.caseId} requires referenceTranslations`);
    assert(!item.audioRef && !item.audioSHA256, `mt-only case ${item.caseId} must not use audio`);
  } else {
    assert(typeof item.referenceText === 'string', `case ${item.caseId} requires referenceText`);
    if (requestedTrack === 'end-to-end') {
      assert(Array.isArray(item.referenceTranslations), `case ${item.caseId} requires referenceTranslations`);
    }
  }
}

export async function inspectEvaluationContracts({ root, manifests }) {
  const resolvedRoot = await realpath(root);
  const trackNames = Object.keys(manifests).sort();
  assert(JSON.stringify(trackNames) === JSON.stringify([...EXPECTED_TRACKS].sort()), 'all three evaluation tracks are required');
  const caseCounts = {};
  let localAudioAssets = 0;
  const allCaseIds = new Set();
  for (const track of EXPECTED_TRACKS) {
    const lines = manifests[track].split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    assert(lines.length > 0, `${track} manifest is empty`);
    const ids = new Set();
    for (const [index, line] of lines.entries()) {
      let item;
      try { item = JSON.parse(line); } catch (error) { throw new Error(`${track} line ${index + 1}: ${error.message}`); }
      validateCase(item, track);
      assert(typeof item.caseId === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(item.caseId), `${track} line ${index + 1} has invalid caseId`);
      assert(!ids.has(item.caseId) && !allCaseIds.has(item.caseId), `duplicate caseId ${item.caseId}`);
      ids.add(item.caseId);
      allCaseIds.add(item.caseId);
      if (track !== 'mt-only') {
        await verifyLocalAudio(resolvedRoot, item);
        localAudioAssets += 1;
      }
      if (track === 'asr-only') assert(item.expectedDecision === 'no_speech', `ASR silence fixture ${item.caseId} must expect no_speech`);
      if (track === 'end-to-end') assert(item.expectedDecision === 'no_speech', `E2E silence fixture ${item.caseId} must expect no_speech`);
    }
    caseCounts[track] = lines.length;
  }
  return {
    mode: 'offline-evaluation-contract-check',
    caseCounts,
    localAudioAssets,
    allFixturesSynthetic: true,
    inferenceExecuted: false,
    qualityEvidence: false,
    contractHarnessPassed: true,
    productAcceptanceState: 'not-evaluated',
    productStatusPath: 'docs/implementation-status.md',
  };
}

async function main() {
  const evalDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(evalDir, '..');
  const definitions = {
    'asr-only': 'asr/contract.jsonl',
    'mt-only': 'translation/contract.jsonl',
    'end-to-end': 'e2e/contract.jsonl',
  };
  const manifests = Object.fromEntries(await Promise.all(Object.entries(definitions).map(async ([track, file]) => [
    track,
    await readFile(resolve(evalDir, file), 'utf8'),
  ])));
  process.stdout.write(`${JSON.stringify(await inspectEvaluationContracts({ root, manifests }), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
