let pdfBackend;
async function loadPdfBackend() {
  if (!pdfBackend) pdfBackend=Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]).then(([backend,worker])=>{backend.GlobalWorkerOptions.workerSrc=worker.default;return backend;});
  return pdfBackend;
}
const aborted=()=>new DOMException('PDF render cancelled','AbortError');
export async function createPdfMedia({blob,budget,onError=()=>{},backend,createCanvas=()=>document.createElement('canvas')}={}) {
  const lib=backend || await loadPdfBackend();
  const base=import.meta.env?.BASE_URL || '/';
  const loading=lib.getDocument({data:new Uint8Array(await blob.arrayBuffer()),
    cMapUrl:`${base}pdfjs/cmaps/`,cMapPacked:true,standardFontDataUrl:`${base}pdfjs/standard_fonts/`,
    wasmUrl:`${base}pdfjs/wasm/`,isEvalSupported:false,canvasMaxAreaInBytes:16_000_000});
  let password=false;
  loading.onPassword=()=>{password=true;loading.destroy?.();};
  let pdf;
  try{pdf=await loading.promise;}catch(error){loading.destroy?.();throw password || error.name==='PasswordException' ? new Error('PDF защищён паролем. Используйте файл без пароля') : error;}
  const cache=new Map(),tasks=new Set(),reservations=new Set();
  let serial=0;
  const owner=`pdf-${Math.random()}`;
  let disposed=false;
  return {
    pageCount:pdf.numPages,
    async renderPage(pageNumber,{pixelWidth=1200,signal}={}){
      if(disposed || signal?.aborted)throw aborted();
      if(!Number.isInteger(pageNumber) || pageNumber<1 || pageNumber>pdf.numPages)throw new Error('Некорректный номер страницы PDF');
      const page=await pdf.getPage(pageNumber);
      if(disposed || signal?.aborted)throw aborted();
      const native=page.getViewport({scale:1});
      const scale=Math.min(Math.max(128,Number(pixelWidth)||1200)/native.width,Math.sqrt(4_000_000/(native.width*native.height)));
      const viewport=page.getViewport({scale});
      const width=Math.max(1,Math.floor(viewport.width)),height=Math.max(1,Math.floor(viewport.height));
      const baseKey=`${owner}:${pageNumber}:${width}`;
      if(cache.has(baseKey)){const result=cache.get(baseKey);budget.touch(result.cacheKey);return result;}
      const key=`${baseKey}:${++serial}`;
      const element=createCanvas();element.width=width;element.height=height;
      const release=()=>{if(cache.get(baseKey)?.cacheKey===key)cache.delete(baseKey);reservations.delete(key);element.width=0;element.height=0;};
      budget.reserve(key,width*height*4,release,{pinned:true});reservations.add(key);
      let task;
      const cancel=()=>task?.cancel?.();
      try{
        task=page.render({canvasContext:element.getContext('2d'),canvas:element,viewport});
        tasks.add(task);signal?.addEventListener('abort',cancel,{once:true});
        await task.promise;
        if(disposed || signal?.aborted)throw aborted();
        if(cache.has(baseKey)){const existing=cache.get(baseKey);budget.remove(key);budget.touch(existing.cacheKey);return existing;}
        const result={element,width,height,cacheKey:key};cache.set(baseKey,result);
        budget.pin(key,false);
        while(cache.size>3){const victim=[...cache].find(([base,result])=>base!==baseKey && !budget.isPinned(result.cacheKey));if(!victim)break;budget.remove(victim[1].cacheKey);}
        return result;
      }catch(error){budget.remove(key);if(error.name!=='AbortError' && error.name!=='RenderingCancelledException')onError(error);throw error;}
      finally{signal?.removeEventListener('abort',cancel);tasks.delete(task);}
    },
    dispose(){if(disposed)return;disposed=true;for(const task of tasks)task.cancel?.();for(const key of [...reservations])budget.remove(key);Promise.resolve(loading.destroy?.()).catch(()=>{});},
  };
}
