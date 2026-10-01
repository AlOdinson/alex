export function createMediaMemoryBudget(limitBytes = 128 * 1024 * 1024) {
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
    resize(key, bytes) {
      const entry=entries.get(key);
      if(!entry)throw new Error('Media reservation missing');
      if(!Number.isSafeInteger(bytes)||bytes<0||bytes>limitBytes)throw new Error('Недостаточно памяти для медиафайла');
      const pinned=[...entries].reduce((sum,[id,item])=>sum+(id!==key&&item.pinned?item.bytes:0),0);
      if(pinned+bytes>limitBytes)throw new Error('Недостаточно памяти для медиафайла');
      while(used-entry.bytes+bytes>limitBytes){
        const candidate=[...entries].find(([id,item])=>id!==key&&!item.pinned);
        if(!candidate)throw new Error('Недостаточно памяти для медиафайла');
        remove(candidate[0]);
      }
      used+=bytes-entry.bytes;entry.bytes=bytes;
    },
    pin(key, pinned = true) { const entry=entries.get(key); if(entry)entry.pinned=pinned; },
    touch(key) { const entry=entries.get(key); if(entry){entries.delete(key);entries.set(key,entry);} },
    remove,
    dispose() { for(const key of [...entries.keys()]) remove(key); },
    usedBytes() { return used; },
  };
}
