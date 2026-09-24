import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const KEY = 'alex-board:owner-library:v2';
let sequence = 0;
async function libraryFixture({ denied = false, unavailable = false } = {}) {
  const values = new Map();
  const control = { denied, unavailable };
  globalThis.localStorage = {
    getItem(key) {
      if (control.unavailable) throw new DOMException('Access denied', 'SecurityError');
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (control.denied || control.unavailable) throw new DOMException('Storage full', 'QuotaExceededError');
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
  };
  const library = await import(`../src/lib/boardLibrary.js?storage-test=${++sequence}`);
  return { library, values, control };
}
const entry = (boardId) => ({ boardId, ownerKey: `owner-${boardId}`, title: boardId });

for (const mode of ['quota', 'denied']) {
  test(`library ${mode} error must not reject a saved board or lose same-tab metadata`, async () => {
    const { library } = await libraryFixture({ denied: true, unavailable: mode === 'denied' });
    assert.doesNotThrow(() => library.rememberOwnedBoard(entry('created')));
    assert.equal(library.getOwnedBoard('created')?.ownerKey, 'owner-created');
    library.updateOwnedBoard('created', { title: 'Renamed' });
    assert.equal(library.getOwnedBoard('created').title, 'Renamed');
    library.forgetOwnedBoard('created');
    assert.equal(library.getOwnedBoard('created'), null);
  });
}

test('failed library writes merge with another tab when storage becomes writable', async () => {
  const { library, values, control } = await libraryFixture();
  library.rememberOwnedBoard(entry('old'));
  control.denied = true;
  assert.doesNotThrow(() => library.rememberOwnedBoard(entry('new')));
  library.forgetOwnedBoard('old');
  values.set(KEY, JSON.stringify([entry('old'), entry('other-tab')]));
  control.denied = false;
  library.updateOwnedBoard('new', { title: 'Saved after retry' });
  assert.deepEqual(new Set(library.getOwnedBoards().map((x) => x.boardId)), new Set(['new', 'other-tab']));
  assert.deepEqual(new Set(JSON.parse(values.get(KEY)).map((x) => x.boardId)), new Set(['new', 'other-tab']));
});

test('recovery restores owner links from durable records without restoring canvas data into localStorage', async () => {
  const { library } = await libraryFixture({ denied: true });
  assert.equal(typeof library.restoreOwnedBoards, 'function', 'durable library recovery is missing');
  const records = [{ ...entry('orphan'), createdAt: 1000, updatedAt: 2000, snapshot: { secretCanvas: true } }];
  const restored = library.restoreOwnedBoards(records);
  assert.equal(restored[0].ownerKey, 'owner-orphan');
  assert.equal(restored[0].createdAt, new Date(1000).toISOString());
  assert.equal(restored[0].snapshot, undefined);
  assert.equal(restored[0].recoveredFromStorage, true);
  assert.deepEqual(records[0].snapshot, { secretCanvas: true });
});

test('recovering hidden boards never makes existing boards eligible for automatic deletion', async () => {
  const { library } = await libraryFixture();
  for (let i = 0; i < 50; i += 1) library.rememberOwnedBoard(entry(`known-${i}`));
  assert.equal(typeof library.restoreOwnedBoards, 'function');
  library.restoreOwnedBoards(Array.from({ length: 5 }, (_, i) => ({ ...entry(`recovered-${i}`), createdAt: 1000, updatedAt: 1000 })));
  assert.equal(library.getOwnedBoards().length, 55);
  assert.deepEqual(library.getOwnedBoardsOverLimit(), []);
  library.rememberOwnedBoard(entry('new'));
  const overflow = library.getOwnedBoardsOverLimit();
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].boardId.startsWith('known-'), true);
});

const homeSource = await readFile(new URL('../src/components/Home.jsx', import.meta.url), 'utf8');
function createHandler(bindings) {
  const start = homeSource.indexOf('  async function handleCreate()');
  const end = homeSource.indexOf('  async function handleRename', start);
  const source = homeSource.slice(start, end).replaceAll('import.meta.env.BASE_URL', "'/alex/'");
  return vm.runInNewContext(`${source}; handleCreate`, bindings);
}

test('Home opens the durable board even when the library cache rejects writes', async () => {
  const { library } = await libraryFixture({ denied: true });
  let durable = false;
  let destination = '';
  const errors = [];
  const handler = createHandler({
    creatingRef: { current: false },
    setCreating() {}, setError(error) { errors.push(error); },
    title: 'Test', studentName: '',
    async createBoard() { durable = true; return entry('created'); },
    rememberOwnedBoard: library.rememberOwnedBoard,
    window: { location: { assign(url) { assert.equal(durable, true); destination = url; } } },
    Error, encodeURIComponent,
  });
  await handler();
  assert.equal(destination, '/alex/board/created?key=owner-created');
  assert.deepEqual(errors.filter(Boolean), []);
});

test('two synchronous create events produce only one durable board', async () => {
  let count = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = createHandler({
    creatingRef: { current: false }, setCreating() {}, setError() {},
    title: 'Test', studentName: '',
    async createBoard() { count += 1; await gate; return entry('created'); },
    rememberOwnedBoard() {}, window: { location: { assign() {} } }, Error, encodeURIComponent,
  });
  const first = handler();
  const second = handler();
  assert.equal(count, 1);
  release();
  await Promise.all([first, second]);
});

test('a failed durable create re-enables the control and never navigates or remembers a board', async () => {
  let busy = false;
  let navigations = 0;
  let remembered = 0;
  let attempts = 0;
  const handler = createHandler({
    creatingRef: { current: false }, setCreating(value) { busy = value; }, setError() {},
    title: 'Test', studentName: '',
    async createBoard() { attempts += 1; throw new Error('write failed'); },
    rememberOwnedBoard() { remembered += 1; },
    window: { location: { assign() { navigations += 1; } } }, Error, encodeURIComponent,
  });
  await handler();
  await handler();
  assert.equal(busy, false);
  assert.equal(attempts, 2);
  assert.equal(remembered, 0);
  assert.equal(navigations, 0);
});

const storeSource = await readFile(new URL('../src/lib/browserAuthorityStore.js', import.meta.url), 'utf8');
async function drain() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
function storeFixture({ stalledOpen = false, throwTransaction = false } = {}) {
  const timers = new Map();
  let timerId = 0;
  const request = {};
  const addRequest = {};
  const state = { closed: 0, aborted: 0, transactions: 0 };
  const tx = {
    objectStore() { return { add() { return addRequest; }, getAll() { return addRequest; } }; },
    abort() { state.aborted += 1; },
  };
  const db = {
    close() { state.closed += 1; },
    transaction() {
      state.transactions += 1;
      if (throwTransaction) throw new Error('transaction constructor failed');
      return tx;
    },
  };
  request.result = db;
  const context = {
    indexedDB: { open() { if (!stalledOpen) queueMicrotask(() => request.onsuccess?.()); return request; } },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    structuredClone, Error, DOMException,
  };
  const api = vm.runInNewContext(`${storeSource.replaceAll('export ', '')}\n;({createAuthorityBoard,listAuthorityBoards})`, context);
  return { api, request, addRequest, tx, db, timers, state,
    expire() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } },
  };
}
function observe(promise) {
  const outcome = { status: 'pending' };
  promise.then((value) => Object.assign(outcome, { status: 'fulfilled', value }),
    (error) => Object.assign(outcome, { status: 'rejected', error }));
  return outcome;
}

test('stalled IndexedDB open rejects within a deadline; a late open is closed without a write', async () => {
  const f = storeFixture({ stalledOpen: true });
  const outcome = observe(f.api.createAuthorityBoard(entry('x')));
  f.expire(); await drain();
  assert.equal(outcome.status, 'rejected', 'database open remained pending indefinitely');
  assert.equal(outcome.error.name, 'TimeoutError');
  f.request.onsuccess(); await drain();
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.transactions, 0);
  assert.equal(f.timers.size, 0);
});

test('blocked database rejects, then closes a late successful connection', async () => {
  const f = storeFixture({ stalledOpen: true });
  const outcome = observe(f.api.createAuthorityBoard(entry('x')));
  f.request.onblocked(); await drain();
  assert.equal(outcome.status, 'rejected');
  f.request.onsuccess(); await drain();
  assert.equal(f.state.closed, 1, 'late blocked connection leaked');
  assert.equal(f.state.transactions, 0);
});

test('a stalled create request aborts and rejects even if the abort event never arrives', async () => {
  const f = storeFixture();
  const outcome = observe(f.api.createAuthorityBoard(entry('x')));
  await drain(); f.expire(); await drain();
  assert.equal(outcome.status, 'rejected', 'create remained pending indefinitely');
  assert.equal(outcome.error.name, 'TimeoutError');
  assert.ok(f.state.aborted >= 1);
  assert.equal(f.state.closed, 1);
});

test('successful add alone is not success: wait for transaction commit and bound the wait', async () => {
  const f = storeFixture();
  const outcome = observe(f.api.createAuthorityBoard(entry('x')));
  await drain(); f.addRequest.onsuccess(); await drain();
  assert.equal(outcome.status, 'pending');
  f.expire(); await drain();
  assert.equal(outcome.status, 'rejected');
  assert.ok(f.state.aborted >= 1);
});

test('normal create resolves after commit, clears timers, closes the database', async () => {
  const f = storeFixture();
  const outcome = observe(f.api.createAuthorityBoard(entry('x')));
  await drain(); f.addRequest.onsuccess(); f.tx.oncomplete(); await drain();
  assert.equal(outcome.status, 'fulfilled');
  assert.equal(outcome.value.boardId, 'x');
  assert.equal(f.timers.size, 0);
  assert.equal(f.state.closed, 1);
  assert.equal(f.state.aborted, 0);
});

test('transaction construction failure still closes its database connection', async () => {
  const f = storeFixture({ throwTransaction: true });
  const outcome = observe(f.api.createAuthorityBoard(entry('x')));
  await drain();
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.error.message, 'transaction constructor failed');
  assert.equal(f.state.closed, 1);
});

test('library enumeration is bounded as well as creation', async () => {
  const f = storeFixture();
  const outcome = observe(f.api.listAuthorityBoards());
  await drain(); f.expire(); await drain();
  assert.equal(outcome.status, 'rejected');
  assert.equal(f.state.closed, 1);
});

test('Home restores an empty cached library from existing IndexedDB records', async () => {
  const { library } = await libraryFixture({ denied: true });
  const record = { ...entry('orphan'), createdAt: 1000, updatedAt: 2000 };
  let shown = [];
  const start = homeSource.indexOf('  const refreshBoards = useCallback(');
  const end = homeSource.indexOf('\n  useEffect(', start);
  const refresh = vm.runInNewContext(`${homeSource.slice(start, end)}; refreshBoards`, {
    useCallback: (callback) => callback,
    refreshSequenceRef: { current: 0 },
    setLoadingBoards() {}, setBoards(value) { shown = value; },
    getOwnedBoards: library.getOwnedBoards,
    restoreOwnedBoards: library.restoreOwnedBoards,
    listAuthorityBoards: async () => [record],
    getOwnedBoardSummaries: async () => [{ ...record }],
    updateOwnedBoard: library.updateOwnedBoard,
  });
  await refresh();
  assert.equal(shown.length, 1, 'empty localStorage hid a durable board');
  assert.equal(shown[0].ownerKey, 'owner-orphan');
  assert.equal(shown[0].unavailable, false);
});

test('malformed cache entries cannot block creating or recovering a valid board', async () => {
  const { library, values } = await libraryFixture();
  values.set(KEY, JSON.stringify([null, 12, {}, { boardId: 'missing-key' }, entry('valid')]));
  assert.doesNotThrow(() => library.rememberOwnedBoard(entry('new')));
  assert.deepEqual(new Set(library.getOwnedBoards().map((x) => x.boardId)), new Set(['valid', 'new']));
});

test('request errors retain their original cause and abort rather than waiting for completion', async () => {
  const f = storeFixture();
  const outcome = observe(f.api.createAuthorityBoard(entry('x')));
  await drain();
  const error = new DOMException('Disk full', 'QuotaExceededError');
  f.addRequest.error = error;
  f.addRequest.onerror();
  await drain();
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.error, error);
  assert.equal(f.state.closed, 1);
  assert.ok(f.state.aborted >= 1);
});
