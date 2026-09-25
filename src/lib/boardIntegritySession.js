import { createBoardIntegrityQueue } from './boardIntegrityQueue.js';
import {
  captureIntegrityRecords, compareIntegrityCanvas, createIntegrityBudget,
  fingerprintIntegrityRecord, validIntegrityIds,
} from './boardIntegrityData.js';

function* committedObjectIds(commit) {
  for (const op of commit?.appliedOps ?? commit?.ops ?? []) {
    if (op?.type === 'upsert' && op.object?.boardObjectId) yield String(op.object.boardObjectId);
    else if ((op?.type === 'delete' || op?.type === 'patch') && op.id) yield String(op.id);
    else if (op?.type === 'transform') {
      for (const entry of Array.isArray(op.objects) ? op.objects : [op]) if (entry?.id) yield String(entry.id);
    }
  }
}

// Created only after an explicit new-board/capable-peer opt-in. This coordinator
// has no periodic heartbeat and never joins the durable acknowledgement queue.
export function createBoardIntegritySession({
  getSource, canvas = null, requestCheck = null, repairSource = null,
  runWork = (work) => work(), onBatch = () => {}, onAhead = () => {},
  onError = () => {}, ...clock
} = {}) {
  if (typeof getSource !== 'function') throw new Error('Integrity source is required');
  let closed = false;
  let rotation = 0;
  let scan = null;
  const sample = (limit, { rescan, exclude }) => {
    const source = getSource();
    const objects = source?.snapshot?.canvas?.objects ?? [];
    const canvasCount = Math.max(0, Number(canvas?.size?.() ?? 0));
    const total = objects.length + canvasCount;
    if (!total) return { ids: [], more: false };
    if (rescan && (!scan || scan.revision !== source?.revision)) scan = { revision: source?.revision, at: 0 };
    if (!rescan) scan = null;
    const ids = []; const seen = new Set(exclude);
    let at = rescan ? scan.at : rotation % total;
    let examined = 0;
    // This is membership sampling only, not object serialization. Bound traversal
    // even when many unidentifiable/transient objects occupy the visible Canvas.
    const maxExamined = Math.min(total, Math.max(limit * 4, 100));
    while (ids.length < limit && examined < maxExamined && (!rescan || at < total)) {
      const i = at % total;
      const id = i < objects.length ? String(objects[i]?.boardObjectId ?? '') : String(canvas?.idAt?.(i - objects.length) ?? '');
      at++; examined++;
      if (id && id.length <= 128 && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    const capturedScan = scan;
    return { ids, more: rescan && at < total, acknowledge() {
      if (rescan && scan === capturedScan) scan.at = at;
      else if (!rescan) rotation = at % total;
    } };
  };
  const queue = createBoardIntegrityQueue({
    ...clock, sample, onError,
    run: async (ids, { signal }) => {
      if (closed || signal.aborted) return { status: 'paused' };
      if (canvas?.isReady?.() === false || canvas?.isBusy?.()) return { status: 'paused' };
      const source = getSource();
      if (!source?.snapshot) return { status: 'paused' };
      const revision = source.revision;
      const isCurrent = () => {
        const current = getSource();
        return !closed && !signal.aborted && current?.revision === revision && current.snapshot === source.snapshot;
      };
      const budget = createIntegrityBudget({ signal, isCurrent });
      try {
        let records = await runWork(() => captureIntegrityRecords(source, ids, budget));
        if (requestCheck) {
          const fingerprints = await runWork(async () => {
            const result = [];
            for (const record of records) result.push({ id: record.id, hash: await fingerprintIntegrityRecord(record, budget) });
            return result;
          });
          budget.assertCurrent();
          const result = await requestCheck({ revision, records: fingerprints, background: source.snapshot.background });
          budget.assertCurrent();
          if (result?.status === 'disabled') return { status: 'paused' };
          if (result?.status !== 'done' || result.revision !== revision) {
            if (Number(result?.revision) > revision) {
              // Ask the existing contiguous journal path, not a new retry protocol.
              try { Promise.resolve(onAhead(result.revision)).catch(onError); } catch { /* observer */ }
              return { status: 'paused' };
            }
            return { status: 'deferred' };
          }
          const repairs = result.records;
          if (!Array.isArray(repairs) || !validIntegrityIds(repairs.map((record) => record?.id))
            || repairs.some((record) => !ids.includes(record.id))) throw new Error('Invalid integrity repair response');
          if (repairs.length || result.background != null) {
            if (typeof repairSource !== 'function' || !repairSource(revision, repairs, result.background)) return { status: 'deferred' };
            budget.assertCurrent();
            records = await runWork(() => captureIntegrityRecords(getSource(), ids, budget));
          }
        }
        if (canvas) {
          const actual = await runWork(() => canvas.capture(ids, budget));
          budget.assertCurrent();
          const mismatches = await runWork(() => compareIntegrityCanvas(records, actual, budget));
          const backgroundMismatch = typeof canvas.getBackground === 'function' && canvas.getBackground() !== source.snapshot.background;
          if (mismatches.length || backgroundMismatch) {
            const wanted = new Set(mismatches);
            const repairs = records.filter((record) => wanted.has(record.id));
            const repaired = await canvas.repair(repairs, backgroundMismatch ? source.snapshot.background : null, { isCurrent, budget, revision });
            if (!repaired) return { status: canvas.isBusy?.() ? 'paused' : 'deferred' };
            budget.assertCurrent();
          }
          if (actual.some((record) => record.protected)) return { status: 'paused' };
        }
        budget.assertCurrent();
        try { Promise.resolve(onBatch(ids, revision)).catch(onError); } catch { /* optional audit notification */ }
        return { status: 'done' };
      } catch (error) {
        if (!isCurrent()) return { status: closed ? 'paused' : 'deferred' };
        throw error;
      }
    },
  });
  return {
    markCommit(commit) {
      if (closed) return;
      queue.mark(committedObjectIds(commit), { background: (commit?.appliedBackground ?? commit?.background) != null });
    },
    markHint(ids) { if (!closed && validIntegrityIds(ids)) queue.mark(ids, { background: true }); },
    wake() { queue.wake(); },
    inspect() { return queue.inspect(); },
    close() { closed = true; queue.close(); },
  };
}
