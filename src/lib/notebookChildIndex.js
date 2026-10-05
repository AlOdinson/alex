import { util } from 'fabric';
import { notebookPageState } from './notebookPageModel.js';
// Ephemeral visible-page index. Nothing here is serialized into a lesson.
// Large and unsupported footprints stay in a separate set, never millions of cells.
const indexes = new WeakMap();
const CELL = 64, MAX_CELLS = 256;
const MAX_ERASER_CANDIDATES = 256;
const knownTypes = new Set(['path','rect','circle','ellipse','triangle','line','polygon','polyline','text','itext','textbox','image']);
export function notebookChildBounds(object, intendedParent = null) {
  if (!knownTypes.has(String(object?.type).toLowerCase()) || object.shadow
    || object.globalCompositeOperation && !['source-over','destination-out'].includes(object.globalCompositeOperation)) return null;
  // Rich character styles and text-on-path can paint beyond the ordinary text
  // box (for example a per-character stroke wider than the object stroke).
  if (['text','itext','textbox'].includes(String(object.type).toLowerCase())
    && (object.path || Object.keys(object.styles ?? {}).length)) return null;
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
  // Finite coordinates beyond safe integers do not advance with x++/y++.
  // Keep such footprints in the bounded global set instead of enumerating cells.
  if (![x0,x1,y0,y1].every(Number.isSafeInteger) || (x1-x0+1)*(y1-y0+1)>MAX_CELLS) return null;
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

/** Broad phase only: the caller retains the existing containsPoint AND pixel
 * transparency predicate. No opacity, selection, eraser or layer policy changes.
 * A dirty/live page may not match its last rendered spatial index: fall back to
 * the old live order until canonical drawing refreshes that index. Never rebuild
 * the page or its raster just to answer a pointer sample.
 */
export function notebookEraserCandidates(book, scenePoint) {
  const fallback = () => [...book.getPageObjects()].reverse();
  if (book._pageContentInvalid || book.dirty) return fallback();
  const index = currentNotebookChildIndex(book);
  if (!index || index.size !== book._objects.length) return fallback();
  const state = notebookPageState(book.notebookPages, book.notebookPageNumber - 1);
  if (typeof state?.rankOf !== 'function' || state.length !== index.size) return fallback();
  const frame = book.calcTransformMatrix(), viewport = book.canvas?.viewportTransform;
  const invertible = matrix => matrix?.length === 6 && matrix.every(Number.isFinite)
    && Number.isFinite(matrix[0] * matrix[3] - matrix[1] * matrix[2])
    && matrix[0] * matrix[3] - matrix[1] * matrix[2] !== 0;
  if (!invertible(frame) || !invertible(viewport)
    || !Number.isFinite(scenePoint?.x) || !Number.isFinite(scenePoint?.y)) return fallback();
  const inverseFrame = util.invertTransform(frame);
  const local = util.transformPoint(scenePoint, inverseFrame);
  const inverseScreen = util.multiplyTransformMatrices(inverseFrame, util.invertTransform(viewport));
  // Fabric's pixel test samples a viewport tolerance square, with retina rounding.
  // Transform its extent conservatively into notebook-local space. The extra
  // pixel covers rounding; it does NOT expand the final exact-hit predicate.
  const tolerance = Number(book.canvas.targetFindTolerance ?? 0);
  if (!Number.isFinite(tolerance) || tolerance < 0) return fallback();
  const pad = tolerance + 1;
  const dx = pad * (Math.abs(inverseScreen[0]) + Math.abs(inverseScreen[2]));
  const dy = pad * (Math.abs(inverseScreen[1]) + Math.abs(inverseScreen[3]));
  const rect = { left: local.x - dx, top: local.y - dy, right: local.x + dx, bottom: local.y + dy };
  if (!Object.values(rect).every(Number.isFinite)) return fallback();
  const nearby = index.query(rect);
  // In dense overlap a full live-order scan can stop at the first opaque child;
  // ranking/sorting the entire page would add work instead of removing it.
  // Fall back, never truncate the candidate list or silently miss lower ink.
  if (nearby.length > MAX_ERASER_CANDIDATES) return fallback();
  const candidates = nearby.map(({ object }) => ({ object, rank: state.rankOf(object.boardObjectId) }));
  // Only validate addressed candidates. Unknown/duplicate legacy layouts already
  // failed the index/state guards, and stale memberships must never erase a peer.
  if (candidates.some(({object, rank}) => rank < 0 || book._objects[rank] !== object || object.group !== book)) return fallback();
  candidates.sort((a, b) => b.rank - a.rank);
  return candidates.map(({object}) => object);
}
