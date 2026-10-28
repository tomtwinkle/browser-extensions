import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { inspectEvaluationContracts } from './check-contracts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadManifests() {
  const entries = [
    ['asr-only', 'eval/asr/contract.jsonl'],
    ['mt-only', 'eval/translation/contract.jsonl'],
    ['end-to-end', 'eval/e2e/contract.jsonl'],
  ];
  return Object.fromEntries(await Promise.all(entries.map(async ([track, file]) => [
    track,
    await readFile(resolve(root, file), 'utf8'),
  ])));
}

test('all three evaluation tracks contain only local synthetic contract cases', async () => {
  const report = await inspectEvaluationContracts({ root, manifests: await loadManifests() });
  assert.deepEqual(report.caseCounts, { 'asr-only': 1, 'mt-only': 3, 'end-to-end': 1 });
  assert.equal(report.inferenceExecuted, false);
  assert.equal(report.qualityEvidence, false);
  assert.equal(report.productAcceptanceState, 'not-evaluated');
  assert.equal(report.productStatusPath, 'docs/implementation-status.md');
  assert.equal(Object.hasOwn(report, 'passedProductContracts'), false);
});

test('rejects a case placed in the wrong track', async () => {
  const manifests = await loadManifests();
  manifests['mt-only'] = manifests['mt-only'].replace('"track":"mt-only"', '"track":"asr-only"');
  await assert.rejects(() => inspectEvaluationContracts({ root, manifests }), /track mismatch/);
});

test('rejects changed fixture audio when its recorded hash is stale', async () => {
  const manifests = await loadManifests();
  manifests['asr-only'] = manifests['asr-only'].replace('2976da01e205a110c9fa41d47659e238a5c6d3c3f3137582f2949853faa201dd', '0'.repeat(64));
  await assert.rejects(() => inspectEvaluationContracts({ root, manifests }), /audio hash mismatch/);
});
