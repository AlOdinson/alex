/** Budget Fabric's existing page and mask surfaces; never allocate a second renderer. */
export function createNotebookRenderCache({maxNotebookBytes=33_554_432,maxBoardBytes=67_108_864}={}) {
  const entries=new Map();
  let bytes=0, temporary=0;
  const reservations=new Map();
  function release(owner) {
    const entry=entries.get(owner);
    if(!entry)return;
    entries.delete(owner);bytes-=entry.bytes;entry.onEvict?.();
  }
  return {
    acquire(owner, value) {
      if(!value) {const entry=entries.get(owner);if(!entry)return false;entries.delete(owner);entries.set(owner,entry);return true;}
      const size=value.surfaces.reduce((n,s)=>n+s.width*s.height*4,0);
      const previous=entries.get(owner);
      if(previous) {entries.delete(owner);bytes-=previous.bytes;}
      if(value.surfaces.length>2 || size+(reservations.get(owner)||0)>maxNotebookBytes || size+temporary>maxBoardBytes) {value.onEvict?.();return false;}
      while(bytes+temporary+size>maxBoardBytes && entries.size)release(entries.keys().next().value);
      if(bytes+temporary+size>maxBoardBytes) {value.onEvict?.();return false;}
      entries.set(owner,{...value,bytes:size});bytes+=size;return true;
    },
    reserveTemporary(owner, size) {
      const entry=entries.get(owner), reserved=reservations.get(owner)||0;
      if(!entry || !Number.isSafeInteger(size) || size<0 || entry.bytes+reserved+size>maxNotebookBytes
        || bytes+temporary+size>maxBoardBytes) return null;
      temporary+=size;reservations.set(owner,reserved+size);let released=false;
      return () => { if(released)return;released=true;temporary-=size;
        const remaining=(reservations.get(owner)||0)-size;
        if(remaining)reservations.set(owner,remaining);else reservations.delete(owner);
      };
    },
    invalidate:release,release,
    dispose(){for(const owner of [...entries.keys()])release(owner);},
    bytesUsed(){return bytes+temporary;},
  };
}
const boardCaches=new WeakMap();
export function notebookRenderCacheFor(canvas) {
  if(!canvas)return null;
  if(!boardCaches.has(canvas))boardCaches.set(canvas,createNotebookRenderCache());
  return boardCaches.get(canvas);
}
