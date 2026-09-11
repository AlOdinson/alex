import assert from 'node:assert/strict';
import test from 'node:test';
import { connectBoardRealtime } from '../src/lib/browserAuthorityRealtime.js';

test('student disconnected state refreshes owner presence immediately to rebuild durable peer', async () => {
  let sessionOptions = null;
  let refreshCalls = 0;
  const statuses = [];

  const realtime = connectBoardRealtime({
    boardId: 'board-reconnect',
    realtimeKey: 'room-key-reconnect-123456789012345',
    clientId: 'student-a',
    permission: 'edit',
    onStatus: (status) => statuses.push(status),
  }, {
    createSession: (options) => {
      sessionOptions = options;
      return {
        async start() {},
        async updateParticipants() {},
        async handleRealtimeSignal() {},
        close() {},
      };
    },
    createCore: () => ({
      async flushPending() {},
      async disconnect() {},
      async sendScreenShareSignal() {},
    }),
    createTransport: () => ({
      async start() {},
      async publish() { return 'ok'; },
      async refreshUsers() { refreshCalls += 1; },
      async disconnect() {},
    }),
  });

  await Promise.resolve();
  sessionOptions.onPeerState('disconnected');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    refreshCalls,
    1,
    'teacher presence must be refreshed as soon as the student durable peer is disconnected',
  );
  assert.ok(statuses.includes('RECOVERING'));
  await realtime.disconnect();
});
