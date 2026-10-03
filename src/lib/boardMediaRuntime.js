import { boardMediaAssets } from './mediaAssetStore.js';
import { createMediaMemoryBudget } from './mediaMemoryBudget.js';
import { createPdfMedia } from './pdfMedia.js';
import { createGifMedia } from './gifMedia.js';
export const MEDIA_PLACEHOLDER_SRC='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
export const MEDIA_OBJECT_FIELDS=['mediaKind','mediaAssetId','mediaName','pageNumber','pageCount'];
export function isBoardMedia(object){return ['pdf','gif'].includes(object?.mediaKind) && /^[a-f0-9]{64}$/.test(object?.mediaAssetId || '');}

// Live raster pixels never become operation/history payloads.
export function attachMediaPixels(object,element){
  const width=object.width,height=object.height;
  object.setElement(element);object.set({width,height,objectCaching:false});
  object.getSrc=()=>MEDIA_PLACEHOLDER_SRC;
  object._renderFill=function(ctx){const el=this.getElement();if(el?.width && el?.height)ctx.drawImage(el,-this.width/2,-this.height/2,this.width,this.height);};
  object.dirty=true;object.setCoords?.();
}
export function createBoardMediaRuntime({canvas,boardId,store=boardMediaAssets,requestAsset,
  budget=createMediaMemoryBudget(),onError=()=>{},onReady=()=>{},onStatusChange=()=>{},
  pdfFactory=createPdfMedia,gifFactory=createGifMedia}={}){
  const states=new Map();let disposed=false,hidden=false,timer=null,running=false;
  const present=new Set();
  // Keep ready resources through a synchronous Canvas replacement/reparenting.
  // True removals release at the microtask boundary, never retain an undo cache.
  const detached=new Map();
  const identity=object=>object.boardObjectId ? `${object.boardObjectId}:${object.mediaKind}:${object.mediaAssetId}` : null;
  const release=state=>{state.controller?.abort();if(state.cacheKey)budget.pin(state.cacheKey,false);state.media?.dispose();};
  const failures=new WeakMap();
  const walk=(object,visit)=>{visit(object);for(const child of object?.getObjects?.() || [])walk(child,visit);};
  const contains=object=>!disposed && present.has(object);
  const visible=object=>!hidden && contains(object) && (typeof object.isOnScreen!=='function' || object.isOnScreen());
  const wantedWidth=object=>Math.max(256,Math.min(2000,Math.ceil((object.getScaledWidth?.() || object.width)*Math.max(0.1,canvas.getZoom?.() || 1)*2)));
  const status=(object,state,phase,details={})=>{
    if(states.get(object)!==state||disposed)return;
    Object.assign(state,{phase,...details});onStatusChange();
  };
  const failed=(object,state,error)=>{
    if(states.get(object)!==state||disposed)return;
    const attempts=(failures.get(object)||0)+1;failures.set(object,attempts);
    state.busy=false;state.error=error;
    state.retryAt=attempts>=3?Infinity:Date.now()+3000*2**(attempts-1);
    status(object,state,'error');onError(error);
  };
  const make=async(assetId,kind,onProgress=()=>{})=>{
    const record=await store.get(boardId,assetId) || await requestAsset?.(assetId,{onProgress});
    if(!record)throw new Error('Медиафайл недоступен на этом устройстве');
    if(record.metadata.kind!==kind)throw new Error('Формат медиафайла не совпадает');
    onProgress({phase:'rendering'});
    return kind==='pdf'?pdfFactory({blob:record.blob,budget}):gifFactory({blob:record.blob,budget});
  };
  const install=(object,state,result)=>{
    if(!contains(object) || states.get(object)!==state)return;
    if(state.cacheKey)budget.pin(state.cacheKey,false);
    state.cacheKey=result.cacheKey; if(state.cacheKey)budget.pin(state.cacheKey,true);
    attachMediaPixels(object,result.element);state.element=result.element;state.width=result.width;state.page=object.pageNumber || 1;
    state.busy=false;state.error=null;state.hasPixels=true;failures.delete(object);status(object,state,'ready');
    onReady(object);canvas.fire?.('media:ready',{target:object});canvas.requestRenderAll();
  };
  const update=async(object)=>{
    const state=states.get(object);if(!state || !state.media || object.mediaKind!=='pdf')return;
    const page=object.pageNumber || 1,quality=wantedWidth(object);
    if(state.page===page && state.quality>=quality && !state.error)return;
    if(state.busy && state.pendingPage===page && state.pendingQuality===quality)return;
    state.controller?.abort();const controller=new AbortController();state.controller=controller;
    state.busy=true;state.pendingPage=page;state.pendingQuality=quality;
    status(object,state,'rendering');
    try{
      const result=await state.media.renderPage(page,{pixelWidth:quality,signal:controller.signal});
      if(controller.signal.aborted || states.get(object)!==state)return;
      state.quality=quality;install(object,state,result);
    }catch(error){if(controller.signal.aborted)return;failed(object,state,error);}
  };
  const hydrate=async(object)=>{
    if(!isBoardMedia(object) || !contains(object))return;
    let state=states.get(object);
    if(!state){
      const key=identity(object),ready=key && detached.get(key);
      if(ready){
        detached.delete(key);state=ready;states.set(object,state);
        attachMediaPixels(object,state.element);
        onStatusChange();
      }
    }
    if(state){if(state.assetId!==object.mediaAssetId){remove(object);state=null;}else if(state.media){return update(object);}else return;}
    state={assetId:object.mediaAssetId,busy:true,controller:null,media:null,page:null,quality:null,nextAt:0};states.set(object,state);
    status(object,state,'loading');
    try{
      const media=await make(object.mediaAssetId,object.mediaKind,progress=>status(object,state,progress.phase,progress));
      if(states.get(object)!==state || !contains(object)){media.dispose();return;}
      state.media=media;
      if(object.mediaKind==='pdf'){state.busy=false;await update(object);}
      else {install(object,state,media);schedule(10);}
    }catch(error){failed(object,state,error);}
  };
  function remove(object,{handoff=false}={}){
    const state=states.get(object);if(!state)return;states.delete(object);state.controller?.abort();
    const key=identity(object);
    if(handoff && key && state.media && state.hasPixels && state.element?.width){
      if(detached.has(key))release(detached.get(key));
      state.busy=false;state.controller=null;detached.set(key,state);
      queueMicrotask(()=>{if(detached.get(key)===state){detached.delete(key);release(state);}});
    }else release(state);
    if(!disposed)onStatusChange();
  }
  const scan=()=>{
    if(disposed)return;
    for(const object of [...states.keys()]){
      if(!isBoardMedia(object))continue;
      const state=states.get(object);
      if(state?.error && Date.now()>state.retryAt){if(!state.media){remove(object);hydrate(object);continue;}else state.error=null;}
      if(!state)hydrate(object);
      else if(state.media && object.mediaKind==='pdf'){
        if(!state.error && state.page!==(object.pageNumber || 1))update(object);
        else if(visible(object) && !state.busy && !state.error && state.quality<wantedWidth(object)){
          if(!state.qualityAt)state.qualityAt=Date.now();
          if(Date.now()-state.qualityAt>500){state.qualityAt=0;update(object);}
        }
      }
    }
    if(states.size && !running)schedule(500);
  };
  async function tick(){
    timer=null;if(disposed || running)return;running=true;let changed=false,next=500;
    try{
      scan();const now=performance.now();
      for(const [object,state] of states){
        if(object.mediaKind!=='gif' || !state.media || state.finished || !visible(object))continue;
        if(state.nextAt>now){next=Math.min(next,state.nextAt-now);continue;}
        try{const result=await state.media.advance(now);if(!contains(object))continue;
          changed ||= result.changed;state.finished=result.nextDelayMs===null;
          state.nextAt=now+(result.nextDelayMs ?? 500);next=Math.min(next,result.nextDelayMs ?? 500);
        }catch(error){state.finished=true;onError(error);}
      }
      if(changed)canvas.requestRenderAll();
    }finally{running=false;if(states.size)schedule(Math.max(10,next));}
  }
  function schedule(delay=100){if(disposed || timer!==null)return;timer=setTimeout(tick,delay);}
  const added=({target})=>walk(target,object=>{present.add(object);hydrate(object);});
  const removed=({target})=>walk(target,object=>{present.delete(object);remove(object,{handoff:true});});
  canvas.on('object:added',added);canvas.on('object:removed',removed);canvas.on('after:render',scan);
  for(const target of canvas.getObjects())added({target});
  scan();
  return {
    hydrate,update,remove,
    isPdfReady(object){const state=states.get(object);return Boolean(!disposed && object?.mediaKind==='pdf' && state?.media && state.hasPixels && !state.busy);},
    retry(object){const state=states.get(object);if(!state||state.busy)return;failures.delete(object);remove(object);return hydrate(object);},
    getLoadStates(){return [...states].filter(([,state])=>!state.hasPixels||state.error).map(([object,state])=>({object,phase:state.phase,loaded:state.loaded||0,total:state.total||0,error:state.error?.message||''}));},
    async prepareAsset(metadata){
      const media=await make(metadata.assetId,metadata.kind);
      try {const result=metadata.kind==='pdf'?await media.renderPage(1,{pixelWidth:1200}):media;
        return {media,result,width:result.width,height:result.height,pageCount:media.pageCount || 1};
      }catch(error){media.dispose();throw error;}
    },
    adopt(object,prepared){
      remove(object);const state={assetId:object.mediaAssetId,media:prepared.media,busy:false,page:object.pageNumber || 1,quality:null,nextAt:0,hasPixels:true,phase:'ready'};states.set(object,state);
      attachMediaPixels(object,prepared.result.element);state.element=prepared.result.element;state.quality=object.mediaKind==='pdf'?prepared.result.width:null;state.cacheKey=prepared.result.cacheKey;if(state.cacheKey)budget.pin(state.cacheKey,true);
      schedule(10);
    },
    async preparePage(object,pageNumber){const state=states.get(object);if(!state?.media || object.mediaKind!=='pdf')throw new Error('PDF ещё загружается');return state.media.renderPage(pageNumber,{pixelWidth:wantedWidth(object)});},
    showPreparedPage(object,result){const state=states.get(object);if(state){state.quality=wantedWidth(object);install(object,state,result);}},
    suspend(value){hidden=Boolean(value);for(const state of states.values())state.media?.restart?.();if(!hidden)schedule(10);},
    getStats(){return {objects:states.size,memoryBytes:budget.usedBytes(),timerActive:timer!==null};},
    dispose(){if(disposed)return;disposed=true;clearTimeout(timer);timer=null;canvas.off('object:added',added);canvas.off('object:removed',removed);canvas.off('after:render',scan);for(const object of [...states.keys()])remove(object);for(const state of detached.values())release(state);detached.clear();budget.dispose();},
  };
}
