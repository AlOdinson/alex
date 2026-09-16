import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
const moduleUrl = new URL('../src/lib/cloudPublisherAuthorization.js', import.meta.url);
const factory = existsSync(moduleUrl) ? (await import(moduleUrl)).createCloudPublisherAuthorization : null;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(patch = {}) {
  assert.equal(typeof factory, 'function', 'Cloud needs owner-authorized guest publishing on local boards');
  let context = { boardId: 'board-local', sessionId: 'screen-local', clientId: 'teacher', hostId: 'student',
    isOwner: true, role: 'viewer', sourceMode: 'screen', canEdit: true, boardKey: 'owner-secret', roomKey: 'room-secret' };
  let board = { boardId: 'board-local', ownerKey: 'owner-secret', shareKey: 'room-secret', guestMode: 'edit' };
  const sent = []; let issued = 0;
  const broker = factory({ getContext: () => context, getOwnerBoard: async () => board,
    authorizePublisher: async () => { issued++; return { publisherGrant: 'signed-permit' }; },
    sendSignal: async (type, payload) => { sent.push({ type, ...payload }); }, timeoutMs: 50,
    createId: () => 'request-123456', ...patch });
  return { broker, sent, issued: () => issued, context: (value) => { context = { ...context, ...value }; },
    board: (value) => { board = { ...board, ...value }; } };
}
const request = { type: 'cloud-grant-request', sessionId: 'screen-local', clientId: 'student', requestId: 'request-123456' };

test('owner checks current local guest mode before issuing a Cloud publishing permit', async () => {
  const f = fixture(); await f.broker.handleSignal(request);
  assert.equal(f.issued(), 1); assert.equal(f.sent[0].publisherGrant, 'signed-permit');
  assert.equal(f.sent[0].targetId, 'student'); f.broker.close();
});
for (const reason of ['view-only', 'wrong-room', 'wrong-host', 'stale-session']) {
  test(`owner never authorizes ${reason}`, async () => {
    const f = fixture(); const signal = { ...request };
    if (reason === 'view-only') f.board({ guestMode: 'view' });
    if (reason === 'wrong-room') f.board({ shareKey: 'another-room' });
    if (reason === 'wrong-host') signal.clientId = 'bystander';
    if (reason === 'stale-session') signal.sessionId = 'obsolete-session';
    await f.broker.handleSignal(signal); assert.equal(f.issued(), 0); f.broker.close();
  });
}
test('requester awaits the matching addressed screen permit, not arbitrary broadcasts', async () => {
  const f = fixture(); f.context({ clientId: 'student', hostId: 'student', isOwner: false, role: 'host' });
  let settled = false;
  const pending = f.broker.request().then((permit) => { settled = true; return permit; });
  await flush(); assert.equal(f.sent[0].type, 'cloud-grant-request');
  await f.broker.handleSignal({ ...request, type: 'cloud-publisher-grant', clientId: 'teacher', targetId: 'other', publisherGrant: 'wrong' });
  await flush(); assert.equal(settled, false);
  await f.broker.handleSignal({ ...request, type: 'cloud-publisher-grant', clientId: 'teacher', targetId: 'student', publisherGrant: 'signed-permit' });
  assert.equal(await pending, 'signed-permit'); f.broker.close();
});
test('closing the board rejects pending permission requests immediately', async () => {
  const f = fixture(); f.context({ clientId: 'student', hostId: 'student', isOwner: false, role: 'host' });
  const pending = assert.rejects(f.broker.request(), /closed/i); f.broker.close(); await pending;
});
test('absent owner cannot leave the Cloud checkbox waiting forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.context({ clientId: 'student', hostId: 'student', isOwner: false, role: 'host' });
  const pending = assert.rejects(f.broker.request(), /timed out/i);
  await flush(); t.mock.timers.tick(51); await pending; f.broker.close();
});
test('stopping a screen session while permission is being issued never publishes a late permit', async () => {
  let release;
  const f = fixture({ authorizePublisher: () => new Promise((resolve) => { release = resolve; }) });
  const handling = f.broker.handleSignal(request); await flush();
  f.context({ sessionId: 'different-screen' }); release({ publisherGrant: 'late-permit' }); await handling;
  assert.equal(f.sent.length, 0); f.broker.close();
});
test('actual Cloud hook supplies browser room scope and routes guest grants through the owner', () => {
  const source = readFileSync(new URL('../src/components/useCloudScreenShareFallback.js', import.meta.url), 'utf8');
  assert.match(source, /roomKey: boardRealtimeKey/);
  assert.match(source, /getPublisherGrant:/);
  assert.match(source, /createCloudPublisherAuthorization/);
  assert.match(source, /getAuthorityBoard/);
});
test('closing before the queued grant request starts does not send a stale signal', async () => {
  const f = fixture(); f.context({ clientId: 'student', hostId: 'student', isOwner: false, role: 'host' });
  const pending = assert.rejects(f.broker.request(), /closed/i);
  f.broker.close(); await pending; await flush(); assert.equal(f.sent.length, 0);
});
