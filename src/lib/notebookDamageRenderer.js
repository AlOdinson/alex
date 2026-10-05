import { util } from 'fabric';
// Repair only an interior, integer-pixel region of Fabric's existing page cache.
// The page-edge mask is already baked in: never apply it twice. Unsupported
// effects, changed density and edge damage use the canonical full renderer.
import { beginNotebookCacheEdit, isNotebookCacheEditCurrent, rememberNotebookAppendCache } from './notebookAppendCache.js';
import { currentNotebookChildIndex, notebookChildBounds } from './notebookChildIndex.js';
export function beginNotebookDamage(book, changes, prepared) {
  if(changes.length>256)return null;
  const cache=beginNotebookCacheEdit(book),index=currentNotebookChildIndex(book);
  if(!cache || !index || index.size!==book._objects.length)return null;
  const fresh=new Map(prepared.map(object=>[String(object.boardObjectId),object]));
  const bounds=[];
  for(const change of changes){
    if(change.before){const entry=index.get(change.before.boardObjectId);if(!entry?.bounds)return null;bounds.push(entry.bounds);}
    if(change.after){const object=fresh.get(String(change.after.boardObjectId))??index.get(change.after.boardObjectId)?.object;
      const rect=object&&notebookChildBounds(object,book);if(!rect)return null;bounds.push(rect);}
  }
  if(!bounds.length)return null;
  const matrix=cache.context.getTransform();
  if(matrix.b!==0||matrix.c!==0||!(matrix.a>0)||!(matrix.d>0))return null;
  const x=Math.floor(Math.min(...bounds.map(b=>b.left))*matrix.a+matrix.e)-2;
  const y=Math.floor(Math.min(...bounds.map(b=>b.top))*matrix.d+matrix.f)-2;
  const right=Math.ceil(Math.max(...bounds.map(b=>b.right))*matrix.a+matrix.e)+2;
  const bottom=Math.ceil(Math.max(...bounds.map(b=>b.bottom))*matrix.d+matrix.f)+2;
  if(x<=matrix.e-book.width/2*matrix.a+2||right>=matrix.e+book.width/2*matrix.a-2
    ||y<=matrix.f-book.height/2*matrix.d+2||bottom>=matrix.f+book.height/2*matrix.d-2
    ||(right-x)*(bottom-y)>cache.surface.width*cache.surface.height*.6)return null;
  return {cache,index,matrix,afterIds:changes.filter(c=>c.after).map(c=>c.after.boardObjectId),x,y,width:right-x,height:bottom-y,
    local:{left:(x-matrix.e)/matrix.a,top:(y-matrix.f)/matrix.d,right:(right-matrix.e)/matrix.a,bottom:(bottom-matrix.f)/matrix.d}};
}
export function finishNotebookDamage(book,ticket,pageState,releaseChildSurfaces = () => {}) {
  if(!ticket||!isNotebookCacheEditCurrent(book,ticket.cache))return false;
  const {index,local,cache,matrix,x,y,width,height}=ticket;
  const entries=index.query(local);
  if(entries.length>2048||entries.some(entry=>!entry.bounds||entry.object.group!==book||pageState.rankOf(entry.object.boardObjectId)<0))return false;
  entries.sort((a,b)=>pageState.rankOf(a.object.boardObjectId)-pageState.rankOf(b.object.boardObjectId));
  // Group attachment can change strokeUniform scaling. An underestimated new
  // footprint must invalidate the repair, never leave paint outside the window.
  if(ticket.afterIds.some(id=>{const b=index.get(id)?.bounds;return !b||b.left<local.left||b.top<local.top||b.right>local.right||b.bottom>local.bottom;}))return false;
  // A hard clip through a retained curve can alter its edge antialiasing. Paint
  // complete candidate footprints into an ephemeral budgeted surface, then copy
  // integer pixels of the repair window. No pixel readback and no second full
  // persistent page cache. Large/unsupported repairs fall back safely.
  // Native browser rasterizers can round even vector coverage differently if
  // an integer origin is subtracted from the floating transform. Keep the exact
  // canonical surface origin/extent; only candidate geometry is painted and only
  // damage pixels are copied. Budget refusal uses the full renderer instead.
  const left=0,top=0,right=cache.surface.width,bottom=cache.surface.height;
  const sw=right-left,sh=bottom-top;
  const release=book._pageRenderCache?.reserveTemporary(book,sw*sh*4);
  if(!release)return false;
  let surface,ctx;const transformed=book._transformDone;
  try{
    surface=util.createCanvasElement();surface.width=sw;surface.height=sh;ctx=surface.getContext('2d');
    if(!ctx)throw new Error('Temporary notebook repair context unavailable');
    // Reproduce Fabric's original translate/scale calls. WebKit's numeric
    // getTransform() round trip can lose native precision at fractional scale.
    // Reading the matrix is useful for bounds/guards, not rebuilding the raster.
    ctx.translate(book.cacheTranslationX,book.cacheTranslationY);
    ctx.scale(book.zoomX,book.zoomY);
    ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';book._transformDone=true;
    book._renderBackground(ctx);for(const entry of entries)entry.object.render(ctx);
    if(!isNotebookCacheEditCurrent(book,cache))return false;
    const target=cache.context;target.save();
    try{target.resetTransform();target.globalAlpha=1;target.globalCompositeOperation='source-over';
      target.clearRect(x,y,width,height);target.drawImage(surface,x-left,y-top,width,height,x,y,width,height);
    }finally{target.restore();}
    book.dirty=false;rememberNotebookAppendCache(book);return true;
  }catch{
    book.releasePageCache();book.dirty=true;return false;
  }finally{book._transformDone=transformed;
    try{for(const entry of entries)releaseChildSurfaces(entry.object);}
    finally{if(surface)surface.width=surface.height=0;release();}}
}
