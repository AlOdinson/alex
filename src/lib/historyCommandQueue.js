// One queue for mouse, keyboard, touch and Pencil. The history entry stays on
// its source stack until the authority confirms it; failed/ambiguous requests
// are retryable and must retain their stable action id in the executor.
export function createHistoryCommandQueue({
  getUndo, getRedo, getGeneration = () => 0, canEdit = () => true,
  prepare = async () => {}, execute, onChange = () => {}, onError = () => {},
  maxQueued = 1024,
}) {
  const queue = [];
  let active = null;
  let closed = false;
  const notify = () => { if (!closed) onChange(); };
  const fail = (error) => { try { onError(error); } catch { /* diagnostic only */ } };
  const drain = async () => {
    if (active || closed) return;
    while (queue.length && !closed) {
      const command = queue.shift();
      active = command;
      notify();
      try {
        if (!canEdit()) throw new Error('Редактирование доски недоступно');
        await prepare();
        if (closed) break;
        let result = { changed: false };
        const source = command.direction === 'undo' ? getUndo() : getRedo();
        // Skip inapplicable entries, but never manufacture redo for changes that
        // were not made. A conflict in one entry cannot trap the entire history.
        const candidates = [...source].reverse();
        while (candidates.length && !closed) {
          const action = candidates.shift();
          if (!source.includes(action)) continue;
          const generation = getGeneration();
          const undoBefore = command.direction === 'redo' ? new Set(getUndo()) : null;
          result = await execute(action, command.direction) ?? { changed: true };
          if (closed) break;
          const index = source.lastIndexOf(action);
          if (index >= 0) source.splice(index, 1);
          if (result.changed !== false) {
            // A new local edit during an in-flight undo starts a new branch.
            if (generation === getGeneration()) {
              (command.direction === 'undo' ? getRedo() : getUndo()).push(action);
            } else if (command.direction === 'redo') {
              // Redo was submitted before edits recorded during its acknowledgement
              // wait. Keep it undoable, immediately before those newer edits, even
              // if recording trimmed the old stack or replaced the redo branch.
              const undo = getUndo();
              const firstNew = undo.findIndex((entry) => !undoBefore.has(entry));
              undo.splice(firstNew < 0 ? undo.length : firstNew, 0, action);
            }
            break;
          }
        }
        command.resolve(result);
      } catch (error) {
        fail(error);
        command.resolve({ changed: false, error });
        // Do not execute a backlog after a failed command with ambiguous outcome.
        while (queue.length) queue.shift().resolve({ changed: false, error });
      } finally {
        if (closed) command.resolve({ changed: false, closed: true });
        active = null;
        notify();
      }
    }
  };
  return {
    enqueue(direction) {
      if (closed) return Promise.resolve({ changed: false, closed: true });
      if (!['undo', 'redo'].includes(direction)) throw new Error('Invalid history direction');
      if (queue.length >= maxQueued) {
        const error = new Error('Очередь отмены заполнена'); fail(error);
        return Promise.resolve({ changed: false, error });
      }
      return new Promise((resolve) => {
        queue.push({ direction, resolve }); notify(); drain();
      });
    },
    pendingCount() { return queue.length + (active ? 1 : 0); },
    availability() {
      let undo = getUndo().length;
      let redo = getRedo().length;
      for (const command of [...(active ? [active] : []), ...queue]) {
        if (command.direction === 'undo' && undo > 0) { undo--; redo++; }
        if (command.direction === 'redo' && redo > 0) { redo--; undo++; }
      }
      return { canUndo: undo > 0, canRedo: redo > 0 };
    },
    close() {
      closed = true;
      while (queue.length) queue.shift().resolve({ changed: false, closed: true });
    },
  };
}
