/** Budget Fabric's existing page and mask surfaces; never allocate a second renderer. */
export function createNotebookRenderCache({maxNotebookBytes=33_554_432,maxBoardBytes=67_108_864}={}) {
  const entries=new Map();
  let bytes=0;
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
      if(value.surfaces.length>2 || size>maxNotebookBytes || size>maxBoardBytes) {value.onEvict?.();return false;}
      while(bytes+size>maxBoardBytes && entries.size)release(entries.keys().next().value);
      entries.set(owner,{...value,bytes:size});bytes+=size;return true;
    },
    invalidate:release,release,
    dispose(){for(const owner of [...entries.keys()])release(owner);},
    bytesUsed(){return bytes;},
  };
}
const boardCaches=new WeakMap();
export function notebookRenderCacheFor(canvas) {
  if(!canvas)return null;
  if(!boardCaches.has(canvas))boardCaches.set(canvas,createNotebookRenderCache());
  return boardCaches.get(canvas);
}
