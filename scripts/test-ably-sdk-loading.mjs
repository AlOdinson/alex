import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createAblyBrowserTransport } from '../src/lib/browserAuthorityRealtime.js';

test('initial page load has no blocking external Ably script', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../src/lib/browserAuthorityRealtime.js', import.meta.url), 'utf8');

  assert.doesNotMatch(html, /cdn\.ably\.com/i);
  assert.doesNotMatch(html, /<script[^>]+ably/i);
  assert.match(source, /import\(['"]ably['"]\)/);
});

test('Ably SDK is loaded lazily only when realtime starts', async () => {
  let loadCalls = 0;

  class FakeRealtime {
    constructor() {
      this.connection = {
        state: 'connected',
        on() {},
        once: async () => {},
      };
      this.channel = {
        on() {},
        subscribe: async () => {},
        presence: {
          subscribe: async () => {},
          enter: async () => {},
          get: async () => [],
        },
      };
      this.channels = { get: () => this.channel };
    }

    close() {
      this.connection.state = 'closed';
    }
  }

  const transport = createAblyBrowserTransport({
    boardId: 'board-lazy-ably',
    roomKey: 'room-key-lazy-ably-1234567890',
    clientId: 'student-lazy',
    permission: 'edit',
    AblyRuntime: null,
    loadAblyRuntime: async () => {
      loadCalls += 1;
      return { Realtime: FakeRealtime };
    },
  });

  assert.equal(loadCalls, 0, 'constructing the board transport must not fetch Ably');
  await transport.start();
  assert.equal(loadCalls, 1, 'Ably should load when realtime actually starts');
  await transport.disconnect();
});
