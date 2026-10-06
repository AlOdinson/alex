import { splitVectorPaintsTask } from './notebookSplitGeometryCore.js';
import { checkNotebookSplit, notebookSplitCancelled } from './notebookSplitCancellation.js';
const DEFAULT_TIMEOUT_MS=15000;
const defaultWorker=()=>new Worker(new URL('./notebookSplitWorker.js',import.meta.url),{type:'module'});
const timeoutError=()=>Object.assign(new Error('Разрезание не завершено; исходный объект сохранён. Повторите действие.'),{name:'TimeoutError'});
const deadline=options=>Number.isFinite(options.timeoutMs)&&options.timeoutMs>0?options.timeoutMs:DEFAULT_TIMEOUT_MS;
const close=bitmap=>{try{bitmap?.close?.();}catch{}};

function request(worker,message,options={},transfer=[]) {
  return new Promise((resolve,reject)=>{
    let done=false,timer;
    const finish=(fn,value)=>{
      if(done)return;done=true;clearTimeout(timer);
      options.signal?.removeEventListener('abort',onAbort);
      worker.onmessage=worker.onerror=worker.onmessageerror=null;
      try{worker.terminate();}catch{}
      fn(value);
    };
    const onAbort=()=>finish(reject,notebookSplitCancelled());
    options.signal?.addEventListener('abort',onAbort,{once:true});
    worker.onmessage=({data})=>{
      if(done||data?.id!==1)return;
      try{checkNotebookSplit(options);if(data.error)throw new Error(data.error);finish(resolve,data.result);}
      catch(error){finish(reject,error);}
    };
    worker.onerror=event=>{event?.preventDefault?.();finish(reject,new Error(event?.message||'Notebook split worker failed'));};
    worker.onmessageerror=()=>finish(reject,new Error('Notebook split worker response could not be decoded'));
    timer=setTimeout(()=>finish(reject,timeoutError()),deadline(options));
    try{checkNotebookSplit(options);worker.postMessage({id:1,...message},transfer);}
    catch(error){finish(reject,error);}
  });
}

export async function runNotebookVectorSplit(payload,options={}){
  checkNotebookSplit(options);
  let worker;
  // A browser lacking Worker keeps a compatibility route, entered on a new task.
  // Runtime/serialization failures after launch reject, NEVER replay heavy work
  // synchronously on the UI thread. The original source remains untouched.
  if(options.workerFactory||typeof Worker==='function'){
    try{worker=options.workerFactory?options.workerFactory():defaultWorker();}
    catch{checkNotebookSplit(options);}
  }
  if(!worker){
    await new Promise(resolve=>setTimeout(resolve,0));checkNotebookSplit(options);
    return splitVectorPaintsTask(payload);
  }
  const result=await request(worker,{type:'vector-split',payload},options);
  if(!Array.isArray(result)||result.some(row=>!row||!Array.isArray(row.inside)||!Array.isArray(row.outside))) {
    throw new Error('Invalid notebook split worker result');
  }
  return result;
}

function acquireBitmap(surface,createBitmap,options){
  return new Promise((resolve,reject)=>{
    let settled=false,timer;
    const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);fn(value);};
    const abort=()=>finish(reject,notebookSplitCancelled());
    options.signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>finish(reject,timeoutError()),deadline(options));
    try{
      checkNotebookSplit(options);
      Promise.resolve(createBitmap(surface)).then(bitmap=>{
        if(settled){close(bitmap);return;}
        try{checkNotebookSplit(options);finish(resolve,bitmap);}catch(error){close(bitmap);finish(reject,error);}
      },error=>finish(reject,error));
    }catch(error){finish(reject,error);}
  });
}
export async function runNotebookRasterBounds(surface,options={}){
  checkNotebookSplit(options);
  // Keep extra transferable + worker surfaces below 32 MiB of raw RGBA.
  // Bigger fragments use tiled readback of their existing canvas, without downsampling.
  if(surface.width*surface.height>4*1024*1024)return undefined;
  const createBitmap=options.createBitmap??globalThis.createImageBitmap;
  if((!options.workerFactory&&typeof Worker!=='function')||typeof createBitmap!=='function')return undefined;
  let bitmap;
  try{
    bitmap=await acquireBitmap(surface,createBitmap,options);checkNotebookSplit(options);
    const worker=options.workerFactory?options.workerFactory():defaultWorker();
    const result=await request(worker,{type:'raster-bounds',bitmap,width:surface.width,height:surface.height},options,[bitmap]);
    if(result?.empty===true)return result;
    if(!result||![result.x0,result.y0,result.x1,result.y1].every(Number.isSafeInteger)
      || result.x0<0 || result.y0<0 || result.x1<result.x0 || result.y1<result.y0
      || result.x1>=surface.width || result.y1>=surface.height)return undefined;
    return result;
  }catch(error){checkNotebookSplit(options);if(error?.name==='AbortError')throw error;return undefined;}
  finally{close(bitmap);}
}
