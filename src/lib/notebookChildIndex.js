import { util } from 'fabric';
// Ephemeral visible-page index. Nothing here is serialized into a lesson.
// Large and unsupported footprints stay in a separate set, never millions of cells.
const indexes = new WeakMap();
const CELL = 64, MAX_CELLS = 256;
const knownTypes = new Set(['path','rect','circle','ellipse','triangle','line','polygon','polyline','text','itext','textbox','image']);
export function notebookChildBounds(object, intendedParent = null) {
  if (!knownTypes.has(String(object?.type).toLowerCase()) || object.shadow
    || object.globalCompositeOperation && !['source-over','destination-out'].includes(object.globalCompositeOperation)) return null;
  const m = object.calcOwnMatrix();
  const w = Number(object.width), h = Number(object.height);
  if (![w,h,...m].every(Number.isFinite) || w<0 || h<0) return null;
  let scale = object.strokeUniform ? object.getObjectScaling() : {x:1,y:1};
  if (object.strokeUniform && !object.group && intendedParent) {
    const total=util.qrDecompose(util.multiplyTransformMatrices(intendedParent.calcTransformMatrix(),m));
    scale={x:Math.abs(total.scaleX),y:Math.abs(total.scaleY)};
  }
  const stretch = Math.hypot(m[0]/scale.x,m[1]/scale.x,m[2]/scale.y,m[3]/scale.y);
  const join = object.strokeLineJoin === 'miter' ? Math.max(2,Number(object.strokeMiterLimit)||4) : 2;
  let margin = object.stroke ? Math.max(0,Number(object.strokeWidth)||0)*stretch*join/2 : 0;
  // Text glyph overhang and font metrics need a conservative footprint beyond
  // the logical text box. Unknown effects retain the canonical path.
  if (['text','itext','textbox'].includes(String(object.type).toLowerCase())) margin += 2*(Number(object.fontSize)||0)*Math.hypot(...m.slice(0,4));
  if (!Number.isFinite(margin)) return null;
  const rx=Math.abs(m[0])*w/2+Math.abs(m[2])*h/2+margin;
  const ry=Math.abs(m[1])*w/2+Math.abs(m[3])*h/2+margin;
  const rect={left:m[4]-rx,top:m[5]-ry,right:m[4]+rx,bottom:m[5]+ry};
  return Object.values(rect).every(Number.isFinite) ? rect : null;
}
const overlaps=(a,b)=>!a || a.left<=b.right&&a.right>=b.left&&a.top<=b.bottom&&a.bottom>=b.top;
function keys(rect) {
  if (!rect) return null;
  const x0=Math.floor(rect.left/CELL),x1=Math.floor(rect.right/CELL),y0=Math.floor(rect.top/CELL),y1=Math.floor(rect.bottom/CELL);
  if ((x1-x0+1)*(y1-y0+1)>MAX_CELLS) return null;
  const result=[];for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)result.push(`${x}:${y}`);
  return result;
}
export function createNotebookChildIndex(objects) {
  const entries=new Map(), cells=new Map(), large=new Set();
  const api={
    get size(){return entries.size;},
    get(id){return entries.get(String(id));},
    delete(id){
      id=String(id);const entry=entries.get(id);if(!entry)return;
      entries.delete(id);large.delete(entry);
      for(const key of entry.keys??[]){const cell=cells.get(key);cell?.delete(entry);if(!cell?.size)cells.delete(key);}
    },
    put(object){
      const id=String(object.boardObjectId);this.delete(id);
      const bounds=notebookChildBounds(object), list=keys(bounds),entry={object,bounds,keys:list};entries.set(id,entry);
      if(!list)large.add(entry);
      else for(const key of list){let cell=cells.get(key);if(!cell)cells.set(key,cell=new Set());cell.add(entry);}
    },
    query(rect){
      const found=new Set(large),list=keys(rect);
      if(list)for(const key of list)for(const entry of cells.get(key)??[])found.add(entry);
      else for(const entry of entries.values())found.add(entry);
      return [...found].filter(entry=>overlaps(entry.bounds,rect));
    },
  };
  for(const object of objects)api.put(object);
  return api;
}
const linearFrame=book=>book.calcTransformMatrix().slice(0,4);
const sameFrame=(entry,book)=>{if(!entry)return false;const current=linearFrame(book);return entry.frame.every((value,i)=>Object.is(value,current[i]));};
export function rebuildNotebookChildIndex(book){
  const index=createNotebookChildIndex(book._objects);indexes.set(book,{index,frame:linearFrame(book)});return index;
}
export const forgetNotebookChildIndex=book=>indexes.delete(book);
export function currentNotebookChildIndex(book){const entry=indexes.get(book);return sameFrame(entry,book)?entry.index:null;}
export function appendNotebookChildIndex(book,child,previousCount){
  const entry=indexes.get(book);if(sameFrame(entry,book)&&entry.index.size===previousCount)entry.index.put(child);else indexes.delete(book);
}
