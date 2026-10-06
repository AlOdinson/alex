import { splitVectorPaintsTask } from './notebookSplitGeometryCore.js';
import { scanNotebookAlphaBounds } from './notebookRasterBounds.js';
async function alphaBounds(bitmap,width,height){
  let canvas;
  try {
    if(typeof OffscreenCanvas!=='function')throw new Error('OffscreenCanvas unavailable');
    canvas=new OffscreenCanvas(width,height);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    if(!ctx)throw new Error('Raster worker context unavailable');
    ctx.drawImage(bitmap,0,0);
    return await scanNotebookAlphaBounds(ctx,width,height);
  } finally {bitmap?.close?.();if(canvas)canvas.width=canvas.height=0;}
}
self.onmessage=async({data})=>{
  const {id,type,payload}=data??{};
  try {
    if(type==='vector-split')self.postMessage({id,result:splitVectorPaintsTask(payload)});
    else if(type==='raster-bounds')self.postMessage({id,result:await alphaBounds(data.bitmap,data.width,data.height)});
    else self.postMessage({id,error:'Unsupported notebook split task'});
  } catch(error){self.postMessage({id,error:error?.message||String(error)});}
};
