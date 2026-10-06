import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { callback, boardFunction } from './notebook-ui-node-harness.mjs';

const ref = current => ({ current });

function pendingImageFixture() {
  const placeholder = {
    boardObjectId: 'image-1', pendingImage: true,
    pendingImageSerialized: { type: 'Image', src: 'fixture', boardObjectId: 'image-1' },
    updatedAt: 1, pendingImageRetryAt: 0,
  };
  const canvas = {
    getObjects() { throw new Error('pending image retry must not rescan the complete scene'); },
    remove() {}, add() {}, moveObjectTo() {}, requestRenderAll() {},
  };
  const scope = {
    pendingImageRetryInFlightRef: ref(false), pendingImageCanvasObjectsRef: ref(new Set([placeholder])),
    fabricCanvasRef: ref(canvas), Date: { now: () => 1000 }, getLocalMutationIds: () => new Set(['image-1']),
    enlivenImageAwareObjects: async () => [], boardObjectsById: () => [placeholder], applyingRemoteRef: ref(false),
    serializedObjectCacheRef: ref(new WeakMap()), clamp: value => value, applyObjectInteractivity() {},
  };
  return { scope, retry: callback('retryPendingServerImages', scope) };
}

test('pending image retry reads the event-maintained pending set without enumerating the board', async () => {
  const { retry } = pendingImageFixture();
  await retry();
});

test('notebook authoritative cleanup collects candidates from id and transaction registries only', () => {
  assert.doesNotThrow(() => boardFunction('notebookTransientCleanupCandidates', {
    objectRegistryRef: ref(new Map()), selectionTransactionRegistryRef: ref(new Map()),
  }));
});


test('board disposal cancels periodic hotpath work and drops retained registry references', () => {
  const source=fs.readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
  for(const expected of [
    'window.clearInterval(localLockRefreshInterval)',
    'window.clearInterval(pendingImageRetryInterval)',
    'window.clearInterval(lockCleanupInterval)',
    'objectRegistryRef.current.clear()',
    'transientCanvasObjectsRef.current.clear()',
    'pendingImageCanvasObjectsRef.current.clear()',
    'creationSessionRegistryRef.current.clear()',
    'selectionTransactionRegistryRef.current.clear()',
  ]) assert.ok(source.includes(expected),`missing disposal boundary: ${expected}`);
});
