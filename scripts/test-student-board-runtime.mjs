import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentBoardRuntime } from '../src/lib/studentBoardRuntime.js';

test('routes signaling and student actions through the peer network', async () => {
  const events = [];
  let signalHandler;
  const runtime = createStudentBoardRuntime({
    clientId: 'student-a',
    teacherId: 'teacher-a',
    sendScreenShareSignal: async () => {},
    getRevision: () => 2,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createSignaling: ({ onSignal }) => {
      signalHandler = onSignal;
      return { send: async () => {}, handle: (payload) => onSignal(payload) };
    },
    createNetwork: () => ({
      async start() { events.push('start'); },
      async handleSignal(message) { events.push(`signal:${message.sourceId}`); },
      async proposeAction(action) { events.push(`proposal:${action.actionId}`); return 'sent'; },
      async proposeActionAndWait(action) { events.push(`proposal-wait:${action.actionId}`); return { accepted: true, revision: 3 }; },
      whenIdle: async () => {},
      close() { events.push('close'); },
      isReady: () => true,
    }),
  });

  await runtime.start();
  await signalHandler({ sourceId: 'teacher-a', signal: { type: 'answer' } });
  const result = await runtime.proposeAction({ actionId: 'student-action', ops: [] });
  const ack = await runtime.proposeActionAndWait({ actionId: 'student-action-wait', ops: [] });
  runtime.close();

  assert.equal(result, 'sent');
  assert.deepEqual(ack, { accepted: true, revision: 3 });
  assert.deepEqual(events, [
    'start',
    'signal:teacher-a',
    'proposal:student-action',
    'proposal-wait:student-action-wait',
    'close',
  ]);
});
