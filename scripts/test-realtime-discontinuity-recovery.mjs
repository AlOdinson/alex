import assert from 'node:assert/strict';
import { createAblyBrowserTransport } from '../src/lib/browserAuthorityRealtime.js';

let connectionHandler = null;
let attachedHandler = null;
let updateHandler = null;
let presenceHandler = null;
let users = [{
  clientId: 'teacher-a',
  data: { clientId: 'teacher-a', name: 'Teacher', permission: 'owner', color: '#000' },
}];

const channel = {
  on(event, handler) {
    if (event === 'attached') attachedHandler = handler;
    if (event === 'update') updateHandler = handler;
  },
  async subscribe() {},
  async publish() {},
  presence: {
    async get() { return users; },
    async subscribe(handler) { presenceHandler = handler; },
    async enter() {},
    async leave() {},
  },
};

class FakeRealtime {
  constructor() {
    this.connection = {
      state: 'connected',
      on(handler) { connectionHandler = handler; },
      async once() {},
    };
    this.channels = { get: () => channel };
  }

  close() {}
}

const statuses = [];
const presenceSnapshots = [];
let recoveries = 0;
const transport = createAblyBrowserTransport({
  boardId: 'board-a',
  roomKey: 'room-key-12345678901234567890',
  clientId: 'student-a',
  name: 'Student',
  permission: 'edit',
  tokenRequest: async () => ({ token: 'fake-token' }),
  AblyRuntime: { Realtime: FakeRealtime },
  onUsers: (nextUsers) => presenceSnapshots.push(nextUsers.map((user) => user.clientId).sort()),
  onStatus: (status) => statuses.push(status),
  onRecover: async () => { recoveries += 1; },
});

await transport.start();
assert.deepEqual(presenceSnapshots.at(-1), ['teacher-a']);
assert.equal(typeof connectionHandler, 'function');
assert.equal(typeof presenceHandler, 'function');
assert.equal(typeof attachedHandler, 'function', 'Ably channel continuity must observe ATTACHED state');
assert.equal(typeof updateHandler, 'function', 'Ably channel continuity must observe UPDATE state');

users = [
  { clientId: 'teacher-a', data: { clientId: 'teacher-a', permission: 'owner' } },
  { clientId: 'student-b', data: { clientId: 'student-b', permission: 'edit' } },
];
connectionHandler({ current: 'connected' });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(presenceSnapshots.at(-1), ['student-b', 'teacher-a']);
assert.equal(recoveries, 1, 'a later Ably reconnect must recover browser-authority continuity');
assert.ok(statuses.includes('RECOVERING'));
assert.ok(statuses.includes('RECOVERED'));

attachedHandler({ resumed: false });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(recoveries, 2, 'reattach without continuity must recover browser-authority state');

updateHandler({ resumed: false });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(recoveries, 3, 'Ably UPDATE discontinuity must recover browser-authority state');

await transport.disconnect();
console.log('Realtime discontinuity recovery regression passed.');
