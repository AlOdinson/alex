// Native browser fixture: same broad phase, unchanged exact pixel predicate.
import { Canvas, Rect, Path, Point, Textbox, Shadow, util } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { notebookEraserCandidates, currentNotebookChildIndex, forgetNotebookChildIndex } from '../src/lib/notebookChildIndex.js';
import { notebookPageState } from '../src/lib/notebookPageModel.js';
import { applyNotebookOperation } from '../src/lib/notebookOperations.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
const fields=['boardObjectId','updatedAt','updatedBy','isEraserPath'];
const rect=(id,left=0,top=0,extra={})=>new Rect({boardObjectId:id,left,top,width:18,height:18,
  originX:'center',originY:'center',fill:'#134',strokeWidth:0,...extra}).toObject(fields);
const check=(condition,message)=>{if(!condition)throw new Error(message);};
async function fixture(records,options={}){
  const canvas=new Canvas(document.createElement('canvas'),{width:800,height:700,renderOnAddRemove:false});
  const book=await BoardNotebook.fromObject({boardObjectId:'book',left:25,top:30,...options,notebookPages:[records]});
  canvas.add(book);canvas.renderAll();notebookPageState(book.notebookPages,0);
  const at=(x,y)=>util.transformPoint(new Point(x,y),book.calcTransformMatrix());
  const pick=(children,p)=>{const v=util.transformPoint(p,canvas.viewportTransform);
    return children.find(o=>!o.isEraserPath&&o.containsPoint(p)&&!canvas.isTargetTransparent(o,v.x,v.y))?.boardObjectId;};
  const old=p=>pick([...book.getPageObjects()].reverse(),p),next=p=>pick(notebookEraserCandidates(book,p),p);
  return {canvas,book,at,old,next,close:()=>canvas.dispose()};
}
async function project(f,changes){const target={...f.book.toObject(fields)};
  applyNotebookOperation(target,{type:'notebook',version:1,id:'book',pageNumber:1,updatedAt:12,updatedBy:'writer',changes});
  const work=await prepareNotebookProjection(f.book,target);check(work.apply(),'projection rejected');}
export async function runNotebookEraserCases(){
  const results=[];
  async function run(name,work){try{results.push({name,...await work()});}catch(error){results.push({name,error:error.stack??error.message});}}
  await run('warm 5000-child hit and empty space',async()=>{
    const f=await fixture([rect('hit'),...Array.from({length:5000},(_,i)=>rect(`far-${i}`,-180,-180))]);
    try{check(currentNotebookChildIndex(f.book),'missing warm index');let checks=0,copies=0;
      for(const o of f.book._objects){const contains=o.containsPoint;o.containsPoint=function(p){checks++;return contains.call(this,p);};}
      const get=f.book.getPageObjects;f.book.getPageObjects=function(){copies++;return get.call(this);};
      check(f.old(f.at(0,0))==='hit','baseline missed target');const before={checks,copies};checks=copies=0;
      check(f.next(f.at(0,0))==='hit','index missed target');const after={checks,copies};
      check(after.copies===0&&after.checks<=2,'full page enumerated during indexed hit');
      checks=copies=0;check(f.next(f.at(100,100))===undefined,'empty space selected ink');
      check(checks===0&&copies===0,'empty space traversed children');return{before,after};
    }finally{await f.close();}
  });
  await run('transparent interior, ignored eraser, tolerance and rank',async()=>{
    const ring=rect('ring',0,0,{width:100,height:100,stroke:'red',strokeWidth:3,fill:null});
    const f=await fixture([rect('bottom'),ring,rect('erase',0,0,{isEraserPath:true,globalCompositeOperation:'destination-out'})]);
    try{let samples=0;for(const tolerance of [0,1,6]){f.canvas.setTargetFindTolerance(tolerance);
      for(const [x,y] of [[0,0],[50,0],[48,2],[8.9,0],[9.2,0],[120,120]]){check(f.next(f.at(x,y))===f.old(f.at(x,y)),'hit predicate mismatch');samples++;}}
      check(f.next(f.at(0,0))==='bottom','eraser/ring hides lower target');return{samples};
    }finally{await f.close();}
  });
  await run('transform and strokeUniform equivalence',async()=>{
    const f=await fixture([rect('hit',25,12,{stroke:'blue',strokeWidth:3,strokeUniform:true}),rect('other',-130,80)]);
    try{let samples=0;
      for(const frame of [{left:50,top:30,scaleX:.61,scaleY:.61,angle:0},
        {left:90,top:60,scaleX:.84,scaleY:1.13,angle:31,skewX:12},
        {left:180,top:50,scaleX:1.1,scaleY:.7,angle:-20,flipX:true,skewX:-7}]){
        f.book.set(frame);f.book.setCoords();f.book.dirty=true;f.canvas.renderAll();
        for(const zoom of [.57,1,1.73]){f.canvas.setViewportTransform([zoom,0,0,zoom,11,-7]);
          for(const [x,y] of [[25,12],[31,18],[35,12],[-130,80],[160,120]]){
            check(f.next(f.at(x,y))===f.old(f.at(x,y)),`transform mismatch ${JSON.stringify({frame,zoom,x,y})}`);samples++;
          }
        }
      }return{samples};
    }finally{await f.close();}
  });
  await run('addressed remove insert and move update candidates',async()=>{
    const f=await fixture([rect('bottom'),rect('top')]);
    try{check(f.next(f.at(0,0))==='top','wrong initial order');
      await project(f,[{type:'delete',id:'top'}]);check(f.next(f.at(0,0))==='bottom','deleted target retained');
      await project(f,[{type:'insert',zIndex:0,object:rect('under')}]);check(f.next(f.at(0,0))==='bottom','wrong inserted layer');
      await project(f,[{type:'patch',id:'bottom',patch:{left:90}}]);
      check(f.next(f.at(0,0))==='under'&&f.next(f.at(90,0))==='bottom','moved index stale');return{checks:4};
    }finally{await f.close();}
  });
  await run('dirty or absent index retains live page selection',async()=>{
    const f=await fixture([rect('old',-100,0)]);
    try{f.book.replacePageObjects([new Rect({boardObjectId:'new',left:100,top:0,width:20,height:20,originX:'center',originY:'center',fill:'black'})]);
      check(f.next(f.at(100,0))==='new','same-length replacement used stale index');
      check(f.next(f.at(-100,0))===undefined,'old child survived replacement');
      f.canvas.renderAll();forgetNotebookChildIndex(f.book);check(f.next(f.at(100,0))==='new','missing index lost child');return{checks:3};
    }finally{await f.close();}
  });
  await run('unsupported paint footprints remain global candidates',async()=>{
    const styled=new Textbox('X',{boardObjectId:'styled',left:-100,top:0,width:50,fontSize:24,styles:{0:{0:{stroke:'red',strokeWidth:20}}}}).toObject(fields);
    const f=await fixture([rect('shadow',80,0,{shadow:new Shadow({color:'red',blur:3,offsetX:4})}),styled]);
    try{let samples=0;for(const o of f.book._objects){const p=o.getCenterPoint();check(f.next(p)===f.old(p),'global footprint lost');samples++;}return{samples};}
    finally{await f.close();}
  });
  await run('dense overlap uses full live order without per-child ranking',async()=>{
    const f=await fixture(Array.from({length:1000},(_,i)=>rect(`overlap-${i}`)));
    try{let idReads=0;for(const o of f.book._objects){const id=o.boardObjectId;
      Object.defineProperty(o,'boardObjectId',{configurable:true,get(){idReads++;return id;}});}
      check(f.next(f.at(0,0))==='overlap-999','dense fallback selected wrong layer');
      check(idReads<32,`dense hit ranked ${idReads} records`);return{idReads};
    }finally{await f.close();}
  });
  return results;
}
