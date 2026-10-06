import { createNotebookSession } from '../src/lib/notebookSession.js';

const check = (value, message) => { if (!value) throw Error(message); };
const task = () => new Promise(resolve => setTimeout(resolve, 0));
const empty = () => ({ revision: 0, snapshot: { version: 2, background: 'blank', canvas: { objects: [
  { type: 'BoardNotebook', boardObjectId: 'book', notebookPageNumber: 1, notebookPages: [[]] },
] } } });
const ink = id => ({ type: 'notebook', version: 1, id: 'book', pageNumber: 1,
  changes: [{ type: 'insert', ifAbsent: true, object: { type: 'Rect', boardObjectId: id, width: 5, height: 5 } }] });
const action = id => ({ actionId: id, clientId: 'writer', ops: [ink(id)] });
const checkpoint = id => { const value = empty(); value.revision = 1;
  value.snapshot.canvas.objects[0].notebookPages[0] = [ink(id).changes[0].object]; return value; };
const ids = s => s.getState().snapshot.canvas.objects[0].notebookPages[0].map(x => x.boardObjectId);
const populate = s => { for (let i = 0; i < 128; i++) s.enqueue(action(`ink-${i}`)); };
const create = extra => { const s = createNotebookSession({ confirmedState: empty(), publish: () => new Promise(() => {}), cooperativeRecovery: true, ...extra }); s.pause('offline'); return s; };

/** Real browser task ordering and immutable model invariants; no time/speed claim. */
export async function runNotebookRecoveryCases() {
  const results = [];
  async function run(name, work) { try { results.push({ name, ...await work() }); } catch (error) { results.push({ name, error: error.message }); } }
  await run('checkpoint exposes only a complete model and admits interleaved input', async () => {
    const s = create();
    try {
      populate(s); const previous = s.getState().snapshot; let sawOld = false;
      const input = task().then(() => { sawOld = s.getState().snapshot === previous;
        const h = s.enqueue(action('live')); check(ids(s).at(-1) === 'live', 'live input was delayed');
        s.enqueue({ actionId: 'undo-live', history: true, ops: h.inverseOps }); });
      s.rebase(checkpoint('remote')); check(s.getState().snapshot === previous, 'checkpoint replay blocked caller');
      await s.whenReconciled(); await input;
      check(sawOld && ids(s)[0] === 'remote' && ids(s).length === 129 && !ids(s).includes('live'), 'input/undo was lost');
      return { inputBeforeInstall: sawOld, children: ids(s).length, pending: s.pendingCount() };
    } finally { s.dispose(); }
  });
  await run('new checkpoint and rejection cannot install a stale replay', async () => {
    const s = create(), oracle = create({ cooperativeRecovery: false });
    try {
      populate(s); populate(oracle); s.rebase(checkpoint('old')); oracle.rebase(checkpoint('old')); await task();
      const next = checkpoint('new'); next.revision = 2;
      s.rebase(next); oracle.rebase(next);
      const rejection = { actionId: 'ink-60', revision: 2, accepted: false };
      s.reject(rejection); oracle.reject(rejection); s.enqueue(action('late')); oracle.enqueue(action('late'));
      await s.whenReconciled(); check(JSON.stringify(s.getState()) === JSON.stringify(oracle.getState()), 'canonical oracle differs');
      return { sameCanonicalState: true, children: ids(s).length };
    } finally { s.dispose(); oracle.dispose(); }
  });
  await run('reverse confirmation burst is drained cooperatively and flush observes it', async () => {
    const s = create();
    try {
      populate(s); const before = s.getState().snapshot;
      const commits = Array.from({ length: 128 }, (_, i) => ({ actionId: `ink-${i}`, clientId: 'writer', revision: i + 1, changed: true,
        ops: [{ ...ink(`ink-${i}`), changes: [{ type: 'insert', zIndex: i, object: ink(`ink-${i}`).changes[0].object }] }] }));
      let revisionAtInput; const input = task().then(() => { revisionAtInput = s.getConfirmedState().revision; check(s.getState().snapshot === before, 'partly replayed state exposed'); });
      for (let i = commits.length - 1; i >= 0; i--) s.ack(commits[i]);
      check(s.getConfirmedState().revision === 0, 'whole burst drained inside ack');
      await s.whenReconciled(); await input;
      check(revisionAtInput < 128 && s.pendingCount() === 0 && ids(s).length === 128, 'confirmation burst lost data or starved input');
      return { revisionAtInput, confirmedRevision: s.getConfirmedState().revision, pending: s.pendingCount() };
    } finally { s.dispose(); }
  });
  await run('dispose retains pending identities and aborts recovery observation', async () => {
    const s = create(); populate(s); s.rebase(checkpoint('remote'));
    const ready = s.whenReconciled(), exported = JSON.stringify(s.exportPending());
    const retained = s.dispose(); let rejected = false;
    try { await ready; } catch (error) { rejected = error.code === 'notebook_disposed'; }
    await task(); check(rejected && JSON.stringify(retained) === exported && s.pendingCount() === 0, 'disposed recovery mutated or lost intents');
    return { retained: retained.length, rejected };
  });
  await run('remote-only buffered commits finish before flush resolves', async () => {
    const s = createNotebookSession({ confirmedState: empty(), publish: () => new Promise(() => {}), cooperativeRecovery: true });
    try {
      for (let i = 95; i >= 0; i--) s.ack({ actionId: `r-${i}`, revision: i + 1, changed: true,
        ops: [{ ...ink(`r-${i}`), changes: [{ type: 'insert', zIndex: i, object: ink(`r-${i}`).changes[0].object }] }] });
      let resolved = false; const done = s.flush().then(() => { resolved = true; });
      await Promise.resolve(); check(!resolved, 'flush ignored recovery'); await done;
      check(s.getConfirmedState().revision === 96 && ids(s).length === 96, 'flush resolved before full state');
      return { children: ids(s).length, revision: s.getConfirmedState().revision };
    } finally { s.dispose(); }
  });
  return results;
}
