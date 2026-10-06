import { StaticCanvas, Path, Rect, FabricText } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { notebookRenderCacheFor } from '../src/lib/notebookRenderCache.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const pixels = canvas => canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
function samePixels(a,b) {
  assert(a.length === b.length,'pixel size differs'); let mismatches=0;
  for(let i=0;i<a.length;i++) if(a[i]!==b[i]) mismatches++;
  assert(!mismatches,`canonical pixel channels differ: ${mismatches}`);
}
function fixture({ zoom=1, retina=1, count=1 }={}) {
  const canvas=new StaticCanvas(null,{width:800,height:650,renderOnAddRemove:false,enableRetinaScaling:false});
  canvas.getRetinaScaling=()=>retina;canvas.setZoom(zoom);
  const books=[];let renders=0;
  for(let b=0;b<count;b++){
    const book=new BoardNotebook({width:count===1?520:220,height:count===1?480:240,left:30+b*240,top:40,boardObjectId:`book-${b}`});
    for(let i=0;i<80;i++)book.addPageObject(new Path(`M -80 ${-90+i*2} Q 0 ${-82+i*2} 80 ${-88+i*2}`,{
      boardObjectId:`b${b}-${i}`,stroke:'rgba(23,44,81,.7)',strokeWidth:1.5,fill:null}));
    book.addPageObject(new FabricText('x² + y² = 25',{left:-70,top:70,fontSize:20,fill:'#142858',boardObjectId:`text-${b}`}));
    canvas.add(book);books.push(book);
  }
  canvas.renderAll();
  for(const book of books)for(const child of book._objects){const render=child.render;child.render=function(...args){renders++;return render.apply(this,args);};}
  return {canvas,books,get renders(){return renders;},reset(){renders=0;},close:()=>canvas.dispose()};
}
function zoomStep(e,factor=1.002){
  e.canvas.setZoom(e.canvas.getZoom()*factor);e.canvas.fire('notebook:viewport-changed');
  e.canvas.cancelRequestedRender();e.canvas.renderAll();
}
const checkCanonical=e=>{
  const actual=new Uint8ClampedArray(pixels(e.canvas.lowerCanvasEl));
  for(const book of e.books)book.dirty=true;e.canvas.renderAll();
  samePixels(actual,pixels(e.canvas.lowerCanvasEl));
};
export async function runNotebookZoomCases(){
  const results=[];
  async function run(name,fn){try{results.push({name,...await fn()});}catch(error){results.push({name,error:error.stack??error.message});}}
  for(const options of [{zoom:1,retina:1},{zoom:.7,retina:2},{zoom:1.33,retina:2}])
  await run(`quiet-exact-${options.zoom}-${options.retina}`,async()=>{
    const e=fixture(options);try{for(let i=0;i<40;i++)zoomStep(e);
      const during=e.renders;assert(during===0,'smooth zoom re-rendered old geometry');
      await wait(260);e.canvas.renderAll();assert(e.renders===81,'quiet page not canonically refined once');checkCanonical(e);
      return {steps:40,oldRendersDuringZoom:during,quietRenders:81};
    }finally{await e.close();}
  });
  await run('edit-during-zoom-is-immediate-and-exact',async()=>{
    const e=fixture();try{zoomStep(e);assert(!e.renders,'first small step redrew content');
      const before=JSON.stringify(e.books[0].notebookPages);
      e.books[0].addPageObject(new Rect({left:-30,top:0,width:20,height:30,fill:'rgba(220,60,40,.6)',boardObjectId:'new'}));
      e.canvas.renderAll();assert(e.renders===81,'content mutation was delayed with viewport quality');
      assert(JSON.stringify(e.books[0].notebookPages)!==before,'new source missing');checkCanonical(e);const atRest=e.renders;
      await wait(220);assert(e.renders===atRest,'obsolete refinement survived a canonical content render');return {immediate:true};
    }finally{await e.close();}
  });
  await run('export-never-uses-interpolated-cache',async()=>{
    const e=fixture();try{zoomStep(e,1.09);
      const exported=e.canvas.toCanvasElement(1.7),actual=new Uint8ClampedArray(pixels(exported));
      e.books[0].dirty=true;const expected=e.canvas.toCanvasElement(1.7);samePixels(actual,pixels(expected));
      exported.width=exported.height=expected.width=expected.height=0;
      e.canvas.renderAll();checkCanonical(e);return {pixelMismatch:0};
    }finally{await e.close();}
  });
  await run('pan-only-does-not-repaint-or-refine',async()=>{
    const e=fixture();try{
      for(let i=0;i<30;i++){const v=[...e.canvas.viewportTransform];v[4]+=1;v[5]+=.5;e.canvas.setViewportTransform(v);e.canvas.fire('notebook:viewport-changed');e.canvas.cancelRequestedRender();e.canvas.renderAll();}
      await wait(220);assert(e.renders===0,'pan invalidated the page image');return {oldRenders:0};
    }finally{await e.close();}
  });
  await run('multiple-pages-refine-one-per-frame',async()=>{
    const e=fixture({count:3});try{const frameCounts=[];let last=0;
      const off=e.canvas.on('after:render',()=>{frameCounts.push(e.renders-last);last=e.renders;});
      for(let i=0;i<20;i++)zoomStep(e);assert(!e.renders,'multiple warm pages re-rendered during zoom');
      await wait(320);e.canvas.renderAll();off();
      const active=frameCounts.filter(n=>n>0);assert(active.length===3&&active.every(n=>n===81),`refinement burst ${active}`);
      checkCanonical(e);return {refinementFrames:active};
    }finally{await e.close();}
  });
  await run('offscreen-pending-page-is-not-recreated',async()=>{
    const e=fixture();try{zoomStep(e);const v=[...e.canvas.viewportTransform];v[4]=5000;e.canvas.setViewportTransform(v);
      e.canvas.fire('notebook:viewport-changed');e.canvas.renderAll();await wait(220);
      assert(e.renders===0,'refinement rebuilt an offscreen page');
      e.canvas.setViewportTransform([1,0,0,1,0,0]);e.canvas.renderAll();checkCanonical(e);return {hiddenRenders:0};
    }finally{await e.close();}
  });
  await run('removed-pending-page-does-not-schedule-new-frames',async()=>{
    const e=fixture();try{zoomStep(e);let requested=0;const original=e.canvas.requestRenderAll;
      e.canvas.requestRenderAll=function(...args){requested++;return original.apply(this,args);};
      const book=e.books[0];e.canvas.remove(book);book.dispose();await wait(220);
      assert(requested===0,'removed notebook kept refinement work alive');assert(notebookRenderCacheFor(e.canvas).bytesUsed()===0,'removed page retained pixels');
      return {lateRequests:0,retainedBytes:0};
    }finally{await e.close();}
  });
  await run('large-zoom-jump-and-retina-change-are-canonical',async()=>{
    const e=fixture();try{zoomStep(e,1.7);assert(e.renders===81,'large scale jump stretched undersized cache');checkCanonical(e);
      e.reset();e.canvas.getRetinaScaling=()=>2;e.canvas.fire('notebook:viewport-changed');e.canvas.renderAll();assert(e.renders===81,'retina change borrowed old density');checkCanonical(e);
      return {largeJumpExact:true,retinaExact:true};
    }finally{await e.close();}
  });
  return results;
}
