import {
  captureIntegrityRecords, createIntegrityBudget, fingerprintIntegrityRecord,
  serializeIntegrityValue, validIntegrityIds,
} from './boardIntegrityData.js';

export function createIntegrityPeerClient({ send } = {}) {
  let info = null;
  let pending = null;
  let serial = 0;
  let closed = false;
  const rejectPending = (error) => {
    if (!pending) return;
    const current = pending; pending = null; current.reject(error);
  };
  const accept = (payload) => {
    if (closed || !pending || !info || payload?.requestId !== pending.id
      || payload.sessionId !== info.sessionId || payload.boardId !== info.boardId
      || payload.version !== 1) return false;
    const current = pending; pending = null; current.resolve(payload); return true;
  };
  return {
    configure(next) {
      const normalized = next?.version === 1 && typeof next.sessionId === 'string' && next.sessionId
        && typeof next.boardId === 'string' && next.boardId
        ? { version: 1, sessionId: next.sessionId, boardId: next.boardId } : null;
      if (info?.sessionId !== normalized?.sessionId || info?.boardId !== normalized?.boardId) {
        rejectPending(new Error('Integrity peer session changed'));
      }
      info = normalized;
      return info;
    },
    getInfo() { return info; },
    async request(payload) {
      if (closed) throw new Error('Integrity peer is closed');
      if (!info) return { status: 'disabled' };
      if (pending) throw new Error('Integrity request already pending');
      const id = `${info.sessionId}:${++serial}`;
      const task = new Promise((resolve, reject) => { pending = { id, resolve, reject }; });
      // No new audit deadline/backoff. The existing channel lifecycle cancels this
      // one waiter on disconnect; subsequent changes never create extra waiters.
      Promise.resolve().then(() => send('integrity-request', {
        ...payload, ...info, requestId: id,
      })).catch((error) => { if (pending?.id === id) rejectPending(error); });
      return task;
    },
    handleMessage(message) {
      return message?.type === 'integrity-result' ? accept(message.payload) : false;
    },
    handleTransfer(transfer) {
      if (transfer?.kind !== 'integrity-result') return false;
      try { return accept(JSON.parse(String(transfer.text ?? ''))); }
      catch (error) { rejectPending(error); return false; }
    },
    close() { closed = true; info = null; rejectPending(new Error('Integrity peer is closed')); },
  };
}

export function createIntegrityPeerResponder({
  getSource, sessionId, boardId, send, sendTextTransfer,
  runWork = (work) => work(), onError = () => {},
} = {}) {
  let active = false;
  let closed = false;
  const controller = new AbortController();
  return {
    async handle(message) {
      const p = message?.payload;
      if (closed || active || message?.type !== 'integrity-request'
        || p?.version !== 1 || p.sessionId !== sessionId || p.boardId !== boardId
        || typeof p.requestId !== 'string' || p.requestId.length > 256
        || !Number.isInteger(p.revision) || p.revision < 0
        || !Array.isArray(p.records) || !validIntegrityIds(p.records.map((r) => r?.id))
        || p.records.some((r) => typeof r.hash !== 'string' || r.hash.length > 32)) return false;
      active = true;
      const fields = { version: 1, requestId: p.requestId, sessionId, boardId };
      const reply = (status, revision) => closed ? undefined : send('integrity-result', { ...fields, status, revision });
      try {
        const result = await runWork(async () => {
          const source = getSource();
          if (source?.version !== 1) return { status: 'disabled', revision: Number(source?.revision ?? 0) };
          if (source.revision !== p.revision) return { status: 'stale', revision: source.revision };
          const budget = createIntegrityBudget({ signal: controller.signal, isCurrent: () => {
            const current = getSource();
            return current?.revision === p.revision && current?.snapshot === source.snapshot;
          } });
          const records = await captureIntegrityRecords(source, p.records.map((r) => r.id), budget);
          const repairs = [];
          for (let i = 0; i < records.length; i++) {
            if (await fingerprintIntegrityRecord(records[i], budget) !== p.records[i].hash) repairs.push(records[i]);
          }
          const background = source.snapshot?.background === p.background ? null : source.snapshot?.background;
          const payload = { ...fields, status: 'done', revision: p.revision, records: repairs, background };
          if (!repairs.length) { budget.assertCurrent(); return { payload }; }
          const encoded = await serializeIntegrityValue(payload, budget);
          budget.assertCurrent();
          return { encoded };
        });
        if (closed) return false;
        if (result.encoded) await sendTextTransfer('integrity-result', result.encoded);
        else if (result.payload) await send('integrity-result', result.payload);
        else await reply(result.status, result.revision);
        return true;
      } catch (error) {
        if (!closed) {
          try { await reply('stale', Number(getSource()?.revision ?? 0)); } catch { /* existing transport handles closure */ }
          try { onError(error); } catch { /* audit-only observer */ }
        }
        return false;
      } finally { active = false; }
    },
    close() { closed = true; controller.abort(); },
  };
}

// Share the teacher's computational lane between its local Canvas verifier and
// remote audit responders. Network waiting happens outside this lane.
export function createIntegrityWorkLane() {
  let tail = Promise.resolve();
  return (work) => {
    const task = tail.then(work);
    tail = task.catch(() => undefined);
    return task;
  };
}
