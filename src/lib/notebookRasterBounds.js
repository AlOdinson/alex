import { checkNotebookSplit } from './notebookSplitCancellation.js';

// Fallback for unavailable OffscreenCanvas/ImageBitmap: bounded readback, not one
// enormous getImageData followed by a superficially sliced JavaScript loop.
export async function scanNotebookAlphaBounds(ctx,width,height,options={}) {
  const edge=256;let x0=width,y0=height,x1=-1,y1=-1,tiles=0,started=performance.now();
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<0||height<0)throw new TypeError('Invalid raster bounds');
  for(let top=0;top<height;top+=edge)for(let left=0;left<width;left+=edge){
    checkNotebookSplit(options);
    if(tiles>=4||performance.now()-started>=4){
      await new Promise(resolve=>setTimeout(resolve,0));checkNotebookSplit(options);tiles=0;started=performance.now();
    }
    const w=Math.min(edge,width-left),h=Math.min(edge,height-top),data=ctx.getImageData(left,top,w,h).data;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(data[(y*w+x)*4+3]){
      x0=Math.min(x0,left+x);x1=Math.max(x1,left+x);y0=Math.min(y0,top+y);y1=Math.max(y1,top+y);
    }
    tiles++;
  }
  checkNotebookSplit(options);
  return x1<0?{empty:true}:{x0,y0,x1,y1};
}
