import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { evaluateAuthorityAction } from '../src/lib/authorityOperationEvaluator.js';
import { prepareAuthoritativeHistory } from '../src/lib/historyOperations.js';
import { applyAuthorityOpsInPlace } from '../src/lib/authoritySnapshot.js';

// Pure model/preflight/history benchmark. This is NOT handwriting-to-screen
// latency, video reception, browser rendering, persistence or an iPad measurement.
const stroke = id => ({ type: 'Path', boardObjectId: id,
  path: Array.from({ length: 40 }, (_, i) => [i ? 'L' : 'M', i, i * 2]),
  stroke: '#123456', strokeWidth: 3, updatedAt: 1, updatedBy: 'teacher' });
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const results = [];
for (const pages of [1, 6, 12, 20]) {
  const notebook = { type: 'BoardNotebook', boardObjectId: 'book', notebookPageNumber: pages,
    notebookPages: Array.from({ length: pages }, (_, page) => Array.from({ length: 300 }, (_, i) => stroke(`${page}-${i}`))) };
  const snapshot = { version: 2, background: 'grid', canvas: { objects: [notebook] } };
  const operation = { type: 'notebook', version: 1, id: 'book', pageNumber: pages,
    changes: [{ type: 'insert', object: stroke('new-ink'), zIndex: 300, ifAbsent: true }],
    updatedAt: 2, updatedBy: 'teacher' };
  const times = [];
  let history;
  for (let repeat = 0; repeat < 100; repeat++) {
    const start = performance.now();
    const evaluation = evaluateAuthorityAction({ snapshot, ops: [operation], notebookVersion: 1,
      clientId: 'teacher', actionId: 'benchmark' });
    history = prepareAuthoritativeHistory(snapshot, evaluation.appliedOps, null, { clientId: 'teacher', actionId: 'benchmark' });
    const target = { ...snapshot, canvas: { objects: [notebook] } };
    applyAuthorityOpsInPlace(target, history.appliedOps);
    const elapsed = performance.now() - start;
    assert.equal(target.canvas.objects[0].notebookPages[pages - 1].length, 301);
    assert.equal(notebook.notebookPages[pages - 1].length, 300);
    for (let page = 0; page < pages - 1; page++) {
      assert.equal(target.canvas.objects[0].notebookPages[page], notebook.notebookPages[page]);
    }
    if (repeat >= 25) times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  results.push({ pages, strokesPerPage: 300, pointsPerStroke: 40, measuredRepeats: times.length,
    preparationP50Ms: times[Math.floor(times.length * 0.5)], preparationP95Ms: times[Math.floor(times.length * 0.95)],
    forwardBytes: bytes(history.appliedOps), inverseBytes: bytes(history.historyInverseOps) });
}
for (const result of results) {
  assert.ok(result.forwardBytes <= 16_384 && result.inverseBytes <= 16_384);
  assert.ok(result.forwardBytes / results[0].forwardBytes <= 1.05);
  assert.ok(result.inverseBytes / results[0].inverseBytes <= 1.05);
}
const report = { scenario: 'Pure notebook child model/preflight/history/apply; wire capability disabled in production',
  exclusions: ['network', 'storage', 'Fabric rendering', 'screen sharing', 'physical devices'],
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  generatedAt: new Date().toISOString(), structuralGatesPassed: true, results };
const json = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv[2]) await writeFile(process.argv[2], json);
console.log(json);
