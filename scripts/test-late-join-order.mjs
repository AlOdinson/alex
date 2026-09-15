import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerSession } from '../src/lib/studentPeerSession.js';

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function fixture() {
  let revision = 0;
  let objects = [];
  let settled = false;
  const sent = [];
  const session = createStudentPeerSession({
    transport: { send: async (type, payload) => { sent.push({ type, payload }); } },
    getRevision: () => revision,
    applyCommit: async (commit) => { objects.push(commit.objectId); revision = commit.revision; },
    installSnapshot: async (snapshot, nextRevision) => {
      objects = snapshot.canvas.objects.map((object) => object.boardObjectId);
      revision = nextRevision;
    },
  });
  const starting = session.start().then(() => { settled = true; }, () => {});
  return {
    session, sent, starting,
    revision: () => revision, objects: () => objects, settled: () => settled,
    snapshot: (nextRevision, ids) => session.handleTransfer({ kind: 'snapshot', text: JSON.stringify({
      revision: nextRevision,
      snapshot: { version: 2, canvas: { objects: ids.map((boardObjectId) => ({ boardObjectId })) } },
    }) }),
  };
}

test('late join: commits arriving before the baseline cannot advance a blank replica', async (t) => {
  const f = fixture();
  t.after(async () => { f.session.close(); await f.starting; });
  await f.session.handleMessage({ type: 'commit', payload: { revision: 1, objectId: 'new-stroke' } });
  assert.equal(f.revision(), 0, 'the missing revision-zero baseline must be installed first');
  assert.deepEqual(f.objects(), []);
  await f.snapshot(0, ['existing-text']);
  await flush();
  assert.deepEqual(f.objects(), ['existing-text']);
  assert.equal(f.settled(), false, 'a newer observed commit still needs catch-up');
  assert.equal(f.sent.at(-1).type, 'sync-request');
  await f.session.handleMessage({ type: 'commit', payload: { revision: 1, objectId: 'new-stroke' } });
  await f.session.handleMessage({ type: 'head', payload: { revision: 1 } });
  await f.starting;
  assert.equal(f.settled(), true);
  assert.deepEqual(f.objects(), ['existing-text', 'new-stroke']);
});

test('late join: a snapshot covering early commits installs the entire board without duplicate replay', async (t) => {
  const f = fixture();
  t.after(async () => { f.session.close(); await f.starting; });
  await f.session.handleMessage({ type: 'commit', payload: { revision: 1, objectId: 'new-stroke' } });
  await f.snapshot(1, ['existing-text', 'new-stroke']);
  await f.starting;
  assert.deepEqual(f.objects(), ['existing-text', 'new-stroke']);
  assert.equal(f.sent.length, 1, 'a covering snapshot does not require redundant history replay');
});

test('late join: closing a session discards queued incoming snapshots', async () => {
  const f = fixture();
  const transferring = f.snapshot(5, ['must-not-install-after-close']);
  f.session.close();
  await transferring;
  await f.starting;
  assert.deepEqual(f.objects(), []);
  assert.equal(f.revision(), 0);
  assert.equal(f.settled(), false);
});
