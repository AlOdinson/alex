import { createBoundedVerificationScheduler } from './boundedVerificationScheduler.js';
import { createVerificationBudget, verificationDigest } from './boundedVerificationDigest.js';
import { validVerificationRecords } from './boundedVerificationState.js';
import { operationObjectIds } from './operationProtocol.js';

const disabledVerifier = () => ({
  notify() {}, resume() {}, close() {}, stats: () => ({ enabled: false }),
});

// A verifier is scoped to one board/runtime/teacher epoch. It is never part of the
// authoritative apply queue or the history queue. Only committed events notify it.
export function createBoundedBoardVerifier({
  enabled = false,
  epoch = '',
  view,
  request = null,
  applyRecords = () => false,
  checkCanvas = async () => true,
  readCanvasIds = () => ({ ids: [], done: true }),
  canCheck = () => true,
  isCurrentRuntime = () => true,
  runWork = (work) => work(),
  createScheduler = createBoundedVerificationScheduler,
  schedulerOptions = {},
  onError = () => {},
} = {}) {
  if (enabled !== true) return disabledVerifier();
  if (!view?.capture || !view?.read || !view?.readOlder) throw new TypeError('Verification view required');
  let closed = false;
  let remoteCursor = 0;
  let remoteScanRevision = -1;
  let remotePage = [];
  let remoteSweepDone = typeof request !== 'function';
  let sourceDone = false;
  let canvasDone = false;
  const live = () => !closed && isCurrentRuntime();

  const readOlder = (limit, { fullSweep = false, reset = false } = {}) => {
    const maximum = Math.max(0, Math.min(100, Number(limit) || 0));
    if (reset) {
      sourceDone = false; canvasDone = false; remoteCursor = 0; remotePage = [];
      remoteSweepDone = typeof request !== 'function';
    }
    const ids = new Set();
    const add = (result) => {
      let inspected = 0;
      for (const id of result?.ids ?? []) {
        if (++inspected > maximum || ids.size >= maximum) break;
        if (typeof id === 'string' && id && id.length <= 200) ids.add(id);
      }
    };
    // Confirm each authoritative page before advancing: checking source order
    // establishes a correct prefix even while arbitrary dirty repairs move layers.
    if (fullSweep) add({ ids: remotePage });
    const localCapacity = maximum - ids.size;
    // Spend older capacity on both stored and actually visible identities. A lost
    // delete can leave a Canvas ghost even when the replica is already correct.
    const first = !fullSweep || !sourceDone || reset
      ? view.readOlder(Math.ceil(localCapacity / 2), { fullSweep, reset })
      : { ids: [], done: true };
    add(first); sourceDone = first.done !== false;
    const second = !fullSweep || !canvasDone || reset
      ? readCanvasIds(maximum - ids.size, { fullSweep, reset })
      : { ids: [], done: true };
    add(second); canvasDone = second?.done !== false;
    if (ids.size < maximum && !sourceDone) {
      const rest = view.readOlder(maximum - ids.size, { fullSweep });
      add(rest); sourceDone = rest.done !== false;
    }
    return { ids: [...ids], done: sourceDone && canvasDone && remoteSweepDone && remotePage.length === 0 };
  };

  const verify = async (batch) => {
    if (!live() || !canCheck(view.revision())) return { complete: false };
    let stamp = view.capture();
    const current = () => live() && !batch.signal?.aborted && view.isCurrent(stamp) && canCheck(view.revision());
    const budget = createVerificationBudget({ signal: batch.signal, isCurrent: current });
    const perform = async (laneSignal) => {
      if (laneSignal?.aborted) return { complete: false };
      budget.assertCurrent();
      if (typeof request === 'function') {
        const confirmingPage = remotePage;
        const entries = [];
        for (const id of batch.ids) {
          entries.push({ id, hash: await verificationDigest(view.read(id), { budget }) });
        }
        if (batch.fullSweep && remoteScanRevision !== stamp.revision) {
          remoteCursor = 0; remoteSweepDone = false; remotePage = [];
        }
        remoteScanRevision = stamp.revision;
        const payload = {
          revision: stamp.revision, entries,
          // Checking a tiny background value also detects a previously missed change.
          backgroundHash: await verificationDigest(view.background(), { budget }),
          scanCursor: remoteCursor,
          scanLimit: batch.fullSweep && remoteSweepDone ? 0 : 20,
        };
        const reply = await request(payload);
        if (!current()) return { complete: false };
        const requested = new Set(batch.ids);
        if (reply?.version !== 1 || reply.epoch !== epoch || reply.revision !== stamp.revision
          || reply.status !== 'ok' || !Array.isArray(reply.checkedIds)
          || reply.checkedIds.length !== requested.size
          || new Set(reply.checkedIds).size !== requested.size
          || reply.checkedIds.some((id) => !requested.has(id))
          || !validVerificationRecords(reply.repairs)
          || reply.repairs.some((record) => !requested.has(record.id))
          || (reply.background != null && !['grid', 'dots', 'blank'].includes(reply.background))) {
          return { complete: false };
        }
        const structuralRepair = reply.repairs.some((record) => {
          const previous = view.read(record.id);
          return Boolean(previous.object) !== Boolean(record.object) || previous.zIndex !== record.zIndex;
        });
        if (reply.repairs.length || reply.background != null) {
          // Synchronous targeted model update is fenced immediately before applying.
          // It changes neither revision nor user history; Canvas installation has its
          // own fence after asynchronous image/object preparation.
          if (!applyRecords(reply.repairs, stamp.revision, reply.background ?? null)) return { complete: false };
          stamp = view.capture();
        }
        const scan = reply.scan;
        if (scan && Array.isArray(scan.ids) && scan.ids.length <= 20
          && Number.isSafeInteger(scan.next) && scan.next >= 0
          && Number.isSafeInteger(scan.total) && scan.total >= 0) {
          const missing = scan.ids.filter((id) => typeof id === 'string' && id.length > 0
            && id.length <= 200 && view.read(id).object === null);
          remoteSweepDone = scan.done === true;
          if (batch.fullSweep && confirmingPage.every((id) => requested.has(id))) {
            remotePage = payload.scanLimit > 0 ? scan.ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200) : [];
          }
          remoteCursor = remoteSweepDone && !batch.fullSweep ? 0 : scan.next;
          if (missing.length) scheduler.mark(missing);
          // A count disagreement is evidence, not a periodic full-board scan. The
          // ensuing sweep is finite and includes both peers' identities.
          if (!batch.fullSweep && (structuralRepair || scan.total !== view.count())) scheduler.requestSweep();
        }
      }
      budget.assertCurrent();
      const records = batch.ids.map((id) => view.read(id));
      const applied = await checkCanvas(records, {
        revision: stamp.revision,
        background: view.background(),
        isCurrent: current,
        budget,
        signal: batch.signal,
        onStructuralRepair: () => { if (!batch.fullSweep) scheduler.requestSweep(); },
      });
      return { complete: applied !== false && current() };
    };
    try {
      // The owner shares one CPU lane across local and remote comparisons. Student
      // request waiting remains independent from every durable action/acknowledgement.
      return await runWork(perform);
    } catch (error) {
      if (error?.name === 'AbortError' || !live()) return { complete: false };
      throw error;
    }
  };

  const scheduler = createScheduler({
    ...schedulerOptions, enabled: true, readOlder, verify, onError,
  });
  return {
    notify(commit) {
      if (!live() || commit?.changed === false) return;
      const ops = Array.isArray(commit?.appliedOps) ? commit.appliedOps : (commit?.ops ?? []);
      const background = commit?.appliedBackground ?? commit?.background ?? null;
      scheduler.mark(operationObjectIds(ops), { background: ['grid', 'dots', 'blank'].includes(background) });
    },
    resume() { if (live()) scheduler.resume(); },
    stats() { return scheduler.stats(); },
    close() { if (!closed) { closed = true; scheduler.close(); } },
  };
}
