const runtimes = new Map();

export function registerBoardRuntime(boardId, runtime) {
  const id = String(boardId ?? '').trim();
  if (!id) throw new Error('boardId is required');
  if (!runtime || typeof runtime !== 'object') throw new Error('runtime is required');

  runtimes.set(id, runtime);
  let active = true;
  return () => {
    if (!active) return false;
    active = false;
    if (runtimes.get(id) !== runtime) return false;
    runtimes.delete(id);
    return true;
  };
}

export function getBoardRuntime(boardId) {
  const id = String(boardId ?? '').trim();
  if (!id) return null;
  return runtimes.get(id) ?? null;
}
