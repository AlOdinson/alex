import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shouldRejectRealtimeObjectFrame } from '../src/lib/convergence.js';

const realtimeSource = fs.readFileSync(new URL('../src/lib/realtime.js', import.meta.url), 'utf8');
const boardSource = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');

const sendDrawStart = realtimeSource.indexOf('sendDraw(draw) {');
const sendDrawEnd = realtimeSource.indexOf('sendPreview(records', sendDrawStart);
assert.ok(sendDrawStart >= 0 && sendDrawEnd > sendDrawStart, 'sendDraw block must be present');
assert.match(
  realtimeSource.slice(sendDrawStart, sendDrawEnd),
  /baseRevision/,
  'draw realtime packets must carry a causal baseRevision',
);

const liveSendStart = boardSource.indexOf("const sendLiveDrawNow = useCallback((phase = 'update') => {");
const liveSendEnd = boardSource.indexOf('const beginLiveDraw = useCallback', liveSendStart);
assert.match(
  boardSource.slice(liveSendStart, liveSendEnd),
  /baseRevision:\s*state\.baseRevision/,
  'every packet in one stroke must keep the stroke start revision',
);

const beginStart = boardSource.indexOf('const beginLiveDraw = useCallback');
const beginEnd = boardSource.indexOf('const updateLiveDraw = useCallback', beginStart);
assert.match(
  boardSource.slice(beginStart, beginEnd),
  /state\.baseRevision\s*=\s*Number\(revisionRef\.current\s*\?\?\s*0\)/,
  'a stroke must capture its causal revision once at start',
);

const remoteDrawStart = boardSource.indexOf('const handleRemoteDraw = useCallback((message) => {');
const remoteDrawEnd = boardSource.indexOf('const flushRemotePreviewQueue', remoteDrawStart);
assert.ok(remoteDrawStart >= 0 && remoteDrawEnd > remoteDrawStart, 'remote draw block must be present');
const remoteDrawBlock = boardSource.slice(remoteDrawStart, remoteDrawEnd);
assert.match(
  remoteDrawBlock,
  /normalizeRealtimeBaseRevision\(message\?\.baseRevision\)/,
  'desktop must read draw baseRevision',
);
assert.match(
  remoteDrawBlock,
  /shouldRejectRealtimeObjectFrame\(authoritativeFence,\s*\{\s*baseRevision\s*\}\)/,
  'desktop must reject a delayed draw packet after its durable object already won',
);

const cleanupStart = boardSource.indexOf('const lockCleanupInterval = window.setInterval(() => {');
const cleanupEnd = boardSource.indexOf('const syncOnFocus = () => {', cleanupStart);
assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, 'cleanup block must be present');
const cleanupBlock = boardSource.slice(cleanupStart, cleanupEnd);
assert.match(cleanupBlock, /staleDrawPreviewIds/, 'stale committed previews need reconciliation');
assert.match(
  cleanupBlock,
  /session\.ended\s*&&\s*session\.awaitingCommit\s*&&\s*age\s*>\s*90000[\s\S]*staleDrawPreviewIds\.add/,
  'completed stale draw sessions must remain visible for authoritative reconciliation',
);
assert.match(
  cleanupBlock,
  /staleAwaitingCommitPreview[\s\S]*continue;/,
  'awaiting-commit Fabric previews must not be blindly deleted',
);
assert.match(
  cleanupBlock,
  /scheduleTargetedReconciliation\(\[\.\.\.staleDrawPreviewIds\]/,
  'stale previews must request targeted authoritative reconciliation',
);

for (let index = 0; index < 400; index += 1) {
  const baseRevision = 1000 + index * 2;
  const fence = {
    kind: 'upsert',
    revision: baseRevision + 1,
    updatedAt: 10_000 + index,
  };
  assert.equal(
    shouldRejectRealtimeObjectFrame(fence, { baseRevision }),
    true,
    `delayed draw ${index} must not revive a transient preview`,
  );
  assert.equal(
    shouldRejectRealtimeObjectFrame(fence, { baseRevision: fence.revision }),
    false,
    `fresh draw ${index} must remain allowed`,
  );
}

console.log('Stale draw preview regression tests passed.');
