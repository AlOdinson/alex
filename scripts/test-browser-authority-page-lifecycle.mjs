import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { connectBoardRealtime } from '../src/lib/browserAuthorityRealtime.js';

test('disconnect releases the owner session before awaiting async cleanup', async () => {
  let sessionClosed = false;
  let resolveCoreDisconnect;
  const coreDisconnect = new Promise((resolve) => { resolveCoreDisconnect = resolve; });

  const realtime = connectBoardRealtime({
    boardId: 'pagehide-board',
    realtimeKey: 'room-key-pagehide-1234567890',
    clientId: 'pagehide-owner',
    permission: 'owner',
  }, {
    createSession: () => ({
      async start() {},
      async updateParticipants() {},
      async handleRealtimeSignal() {},
      getRevision: () => 0,
      close() { sessionClosed = true; },
    }),
    createCore: () => ({
      async flushPending() {},
      disconnect() { return coreDisconnect; },
      async sendScreenShareSignal() {},
    }),
    createTransport: () => ({
      async start() {},
      async publish() { return 'ok'; },
      async disconnect() {},
    }),
  });

  await Promise.resolve();
  await Promise.resolve();
  const disconnectTask = realtime.disconnect();

  assert.equal(
    sessionClosed,
    true,
    'page lifecycle teardown must synchronously release the teacher Web Lock before awaiting core/transport cleanup',
  );

  resolveCoreDisconnect();
  await disconnectTask;
});

test('Board releases browser authority on pagehide and reloads a restored BFCache page', async () => {
  const board = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');

  assert.match(
    board,
    /const syncOnPageHide\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,500}realtimeRef\.current\?\.disconnect\?\.\(\)/,
    'pagehide must close the realtime/session so the outgoing page cannot retain owner authority',
  );
  assert.match(
    board,
    /const syncOnPageShow\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,500}persisted[\s\S]{0,500}location\.reload\(\)/,
    'a BFCache-restored board must reload so it creates a fresh authority session after pagehide teardown',
  );
});
