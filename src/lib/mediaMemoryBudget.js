export function createMediaMemoryBudget(limitBytes = 64 * 1024 * 1024) {
  const entries = new Map();
  let used = 0;
  const remove = (key) => {
    const entry=entries.get(key);
    if (!entry) return;
    entries.delete(key); used-=entry.bytes; entry.release();
  };
  return {
    reserve(key, bytes, release = () => {}, { pinned = false } = {}) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limitBytes) throw new Error('Недостаточно памяти для медиафайла');
      remove(key);
      while (used + bytes > limitBytes && entries.size) {
        const candidate=[...entries].find(([,entry])=>!entry.pinned);
        if(!candidate)throw new Error('Недостаточно памяти для медиафайла');
        remove(candidate[0]);
      }
      entries.set(key,{bytes,release,pinned}); used+=bytes;
    },
    isPinned(key) { return Boolean(entries.get(key)?.pinned); },
    pin(key, pinned = true) { const entry=entries.get(key); if(entry)entry.pinned=pinned; },
    touch(key) { const entry=entries.get(key); if(entry){entries.delete(key);entries.set(key,entry);} },
    remove,
    dispose() { for(const key of [...entries.keys()]) remove(key); },
    usedBytes() { return used; },
  };
}
