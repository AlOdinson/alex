import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBoardRepository } from '../src/lib/browserBoardRepositoryCompat.js';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';
import { createPeerDataChannelTransport } from '../src/lib/peerDataChannel.js';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';
import { createTeacherPeerNetwork } from '../src/lib/teacherPeerNetwork.js';

const AUTHORITY_BOARD = {
  boardId: 'board-a',
  ownerKey: 'owner-secret',
  shareKey: 'share-secret',
  realtimeKey: 'share-secret',
  title: 'Board A',
  studentName: 'Student',
  guestMode: 'edit',
  gameLibraryVisible: false,
  revision: 9,
  snapshotRevision: 4,
  snapshot: { version: 2, background: 'grid', canvas: { objects: [] } },
  createdAt: 100,
  updatedAt: 200,
};

class FakeChannel {
  constructor() {
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((entry) => entry.listener !== listener));
  }

  emit(type, event = {}) {
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      entry.listener(event);
      if (entry.once) this.removeEventListener(type, entry.listener);
    }
  }

  send() {}
}

test('owner compatibility compaction never replaces authority with a caller UI snapshot', async () => {
  let directSnapshotSaves = 0;
  let runtimeCompactions = 0;
  const repo = createBrowserBoardRepository({
    getBoard: async (boardId) => (boardId === AUTHORITY_BOARD.boardId ? { ...AUTHORITY_BOARD } : null),
    saveSnapshot: async () => {
      directSnapshotSaves += 1;
      return 9;
    },
    getRuntime: () => ({
      async compactSnapshot() {
        runtimeCompactions += 1;
        return 9;
      },
    }),
  });

  const staleUiSnapshot = {
    version: 2,
    background: 'grid',
    canvas: { objects: [{ boardObjectId: 'only-one-of-many' }] },
  };
  const revision = await repo.saveBoardSnapshot(
    AUTHORITY_BOARD.boardId,
    AUTHORITY_BOARD.ownerKey,
    staleUiSnapshot,
    9,
  );

  assert.equal(revision, 9);
  assert.equal(runtimeCompactions, 1, 'owner compaction must come from the active authority runtime');
  assert.equal(directSnapshotSaves, 0, 'caller/Fabric snapshot must never overwrite teacher authority');
});

test('student board session stays waiting until the peer runtime completes initial authority sync', async () => {
  let finishInitialSync;
  let runtimeStarts = 0;
  let readySettled = false;
  const initialSync = new Promise((resolve) => { finishInitialSync = resolve; });
  const studentRuntime = {
    async start() {
      runtimeStarts += 1;
      await initialSync;
    },
    async proposeActionAndWait(action) {
      return { actionId: action.actionId, accepted: true, changed: true, revision: 1, appliedOps: action.ops };
    },
    handleRealtimeSignal() { return true; },
    close() {},
  };

  const session = createBrowserBoardSession({
    boardId: 'student-readiness-board',
    clientId: 'student-a',
    permission: 'edit',
    sendScreenShareSignal: async () => {},
    getReplica: () => ({ revision: 0 }),
    createStudentRuntime: () => studentRuntime,
    registerRuntime: () => () => {},
  });

  await session.start();
  const readyTask = session.whenRuntimeReady().then((runtime) => {
    readySettled = true;
    return runtime;
  });
  const transition = session.updateParticipants([
    { clientId: 'teacher-a', permission: 'owner' },
  ]);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(runtimeStarts, 1);
  assert.equal(session.getRuntimeState(), 'waiting');
  assert.equal(readySettled, false, 'editing must remain gated before authoritative sync completes');

  finishInitialSync();
  await transition;
  assert.equal(await readyTask, studentRuntime);
  assert.equal(session.getRuntimeState(), 'ready');
  session.close();
});

test('student initial peer sync does not resolve until an authoritative head or snapshot arrives', async () => {
  let connectionOptions;
  let transportOptions;
  let sessionOptions;
  let startSettled = false;

  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a',
    signaling: { send: async () => {} },
    getRevision: () => 4,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() {} };
    },
    createTransport: (options) => {
      transportOptions = options;
      return { send: async () => {}, close() {} };
    },
    createSession: (options) => {
      sessionOptions = options;
      let resolveSync;
      const synced = new Promise((resolve) => { resolveSync = resolve; });
      return {
        start: () => synced,
        handleMessage(message) {
          if (message?.type === 'head') resolveSync();
          return Promise.resolve();
        },
        handleTransfer() { resolveSync(); return Promise.resolve(); },
        close() {},
      };
    },
  });

  const starting = network.start().then(() => { startSettled = true; });
  await Promise.resolve();
  assert.equal(startSettled, false, 'WebRTC offer creation alone must not mark the student durable runtime ready');

  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(startSettled, false, 'opening the DataChannel alone must not mark initial authority sync complete');

  await transportOptions.onMessage({ type: 'head', payload: { revision: 4 } });
  await starting;
  assert.equal(startSettled, true);
  assert.ok(sessionOptions, 'student peer session was not created');
});

test('peer data channel reports unexpected close to its owner', () => {
  const channel = new FakeChannel();
  let closes = 0;
  createPeerDataChannelTransport({
    channel,
    onClose: () => { closes += 1; },
  });

  channel.emit('close');
  channel.emit('close');
  assert.equal(closes, 1, 'unexpected DataChannel close must be observable exactly once');
});

test('student network turns a DataChannel-only close into terminal recovery even while peer connection stays connected', async () => {
  let connectionOptions;
  let transportOptions;
  let connectionClosed = 0;
  let sessionClosed = 0;
  const states = [];

  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a',
    signaling: { send: async () => {} },
    getRevision: () => 0,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    onState: (state) => states.push(state),
    createConnection: (options) => {
      connectionOptions = options;
      return {
        async start() {},
        async handleSignal() {},
        close() { connectionClosed += 1; },
      };
    },
    createTransport: (options) => {
      transportOptions = options;
      return { send: async () => {}, close() {} };
    },
    createSession: () => ({
      async start() {},
      close() { sessionClosed += 1; },
    }),
  });

  const starting = network.start();
  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });
  await starting;
  assert.equal(typeof transportOptions.onClose, 'function', 'student transport must observe DataChannel close');

  transportOptions.onClose();
  assert.equal(sessionClosed, 1, 'closed DataChannel must close the student peer session');
  assert.equal(connectionClosed, 1, 'closed DataChannel must retire its peer connection');
  assert.equal(states.at(-1), 'failed', 'closed DataChannel must enter the existing reconnect path');
});

test('teacher network removes a peer when only its DataChannel closes', async () => {
  let connectionOptions;
  let transportOptions;
  const removed = [];
  const network = createTeacherPeerNetwork({
    signaling: { send: async () => {} },
    peerHub: {
      addPeer: () => () => {},
      removePeer(peerId) { removed.push(peerId); },
      async handleMessage() {},
    },
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() {} };
    },
    createTransport: (options) => {
      transportOptions = options;
      return { send: async () => {}, sendTextTransfer: async () => {}, close() {} };
    },
  });

  await network.handleSignal({ sourceId: 'student-a', signal: { type: 'offer' } });
  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });
  assert.equal(network.getPeerCount(), 1);
  assert.equal(typeof transportOptions.onClose, 'function', 'teacher transport must observe DataChannel close');

  transportOptions.onClose();
  assert.equal(network.getPeerCount(), 0);
  assert.deepEqual(removed, ['student-a']);
});
