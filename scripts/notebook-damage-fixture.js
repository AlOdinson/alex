// Shared native-browser/Node pixel fixture. Exercises production projection;
// no test-only branch in the renderer and no tolerance for pixel differences.
import { StaticCanvas, Path, Rect, Textbox, FabricImage, util } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { applyNotebookOperation, invertNotebookOperation } from '../src/lib/notebookOperations.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
const fields=['boardObjectId','updatedAt','updatedBy','isEraserPath'];
const path=(id,x,y,options={})=>new Path(`M ${x} ${y} Q ${x+9} ${y+14} ${x+21} ${y+4}`,{
  boardObjectId:id,stroke:'rgba(40,60,70,.7)',strokeWidth:2,strokeLineJoin:'round',fill:null,...options});
const operation=changes=>({type:'notebook',version:1,id:'book',pageNumber:1,updatedAt:14,updatedBy:'writer',changes});
const pixels=canvas=>canvas.getContext().getImageData(0,0,canvas.lowerCanvasEl.width,canvas.lowerCanvasEl.height).data;
export async function runNotebookDamageCases() {
  const cases=[
    {name:'delete',kind:'delete'},
    {name:'move',kind:'move'},
    {name:'patch-color',kind:'color'},
    {name:'middle-insert',kind:'insert'},
    {name:'composite-change',kind:'batch'},
    {name:'reorder',kind:'reorder'},
    {name:'undo',kind:'undo'},
    {name:'fractional-page',kind:'move',scale:.73,zoom:1.17,opacity:.63},
    {name:'rotated-page',kind:'move',scale:.8,zoom:.9,angle:13},
    {name:'translucent-background',kind:'move',background:'rgba(40,80,100,.3)'},
    {name:'transparent-background',kind:'delete',background:''},
    {name:'erased-overlap',kind:'move',erased:true},
    {name:'partial-eraser-delete',kind:'eraser',erased:true},
    {name:'masked-overlap',kind:'color',masked:true},
    {name:'stroke-uniform',kind:'uniform',scale:.8,zoom:1.15,masked:true},
    {name:'editable-text',kind:'text'},
    {name:'image-move',kind:'image'},
    {name:'boundary-fallback',kind:'edge',fallback:true},
    {name:'shadow-fallback',kind:'shadow',fallback:true},
    {name:'nonlocal-composition',kind:'nonlocal',fallback:true},
    {name:'eviction-fallback',kind:'delete',evict:true,fallback:true},
  ];
  const output=[];
  for(const spec of cases){
    const canvas=new StaticCanvas(util.createCanvasElement(),{width:800,height:700,renderOnAddRemove:false});
    canvas.setZoom(spec.zoom??1);
    let book;
    try{
      const objects=Array.from({length:180},(_,i)=>path(`old-${i}`,-216+(i%15)*29,-180+Math.floor(i/15)*31));
      objects.push(path('target',-16,-8,{stroke:'rgba(140,20,70,.6)',opacity:.7}));
      objects.push(path('overlap',-14,-7,{opacity:.53,...(spec.masked?{clipPath:new Rect({width:18,height:25,originX:'center',originY:'center'})}:{})}));
      if(spec.erased)objects.push(path('eraser',-14,-5,{stroke:'black',strokeWidth:8,isEraserPath:true,globalCompositeOperation:'destination-out'}));
      if(spec.kind==='text')objects.push(new Textbox('hello',{boardObjectId:'text',left:-35,top:15,width:74,fontSize:19,fontStyle:'italic',fill:'#b56'}));
      if(spec.kind==='image'){
        const source=util.createCanvasElement();source.width=30;source.height=25;
        const ctx=source.getContext('2d');ctx.fillStyle='#936';ctx.fillRect(0,0,20,20);ctx.fillStyle='rgba(20,180,40,.5)';ctx.fillRect(12,7,18,18);
        objects.push(new FabricImage(source,{boardObjectId:'image',left:-25,top:20,opacity:.7}));
      }
      book=await BoardNotebook.fromObject({boardObjectId:'book',left:38,top:35,scaleX:spec.scale??1,scaleY:spec.scale??1,
        angle:spec.angle??0,opacity:spec.opacity??1,backgroundColor:spec.background??'#fff',notebookPages:[objects.map(o=>o.toObject(fields))]});
      objects.forEach(o=>o.dispose());canvas.add(book);
      // Content above the notebook must remain above it after every repaint.
      canvas.add(new Rect({left:320,top:320,width:70,height:8,fill:'rgba(20,100,200,.6)'}));canvas.renderAll();
      let renders=0,installs=0;
      for(const object of book._objects){const render=object.render;object.render=function(...args){renders++;return render.apply(this,args);};}
      const install=book.applyAddressedPageChanges;book.applyAddressedPageChanges=function(...args){const value=install.apply(this,args);if(value)installs++;return value;};
      const base=book.toObject(fields),target={...base};
      const saved=base.notebookPages[0].find(o=>o.boardObjectId==='target');
      const fresh=path('fresh',12,12,{opacity:.5}).toObject(fields);
      const choices={
        delete:[{type:'delete',id:'target'}],move:[{type:'patch',id:'target',patch:{left:28,top:18}}],
        color:[{type:'patch',id:'target',patch:{stroke:'#752',opacity:.3}}],
        insert:[{type:'insert',zIndex:80,object:fresh}],
        batch:[{type:'delete',id:'target'},{type:'insert',zIndex:90,object:fresh},{type:'patch',id:'overlap',patch:{top:22}}],
        reorder:[{type:'delete',id:'target'},{type:'insert',zIndex:181,object:saved}],
        undo:[{type:'delete',id:'target'}],eraser:[{type:'delete',id:'eraser'}],
        uniform:[{type:'patch',id:'target',patch:{strokeUniform:true,strokeWidth:7,scaleX:.7,scaleY:1.3}}],
        text:[{type:'patch',id:'text',patch:{text:'bye',left:28}}],
        image:[{type:'patch',id:'image',patch:{left:34,scaleX:1.5}}],
        edge:[{type:'patch',id:'target',patch:{left:-260}}],
        shadow:[{type:'patch',id:'target',patch:{shadow:{color:'rgba(20,20,20,.5)',blur:6,offsetX:10,offsetY:3}}}],
        nonlocal:[{type:'patch',id:'target',patch:{globalCompositeOperation:'destination-in'}}],
      };
      const action=operation(choices[spec.kind]);applyNotebookOperation(target,action);
      if(spec.evict)book.releasePageCache();
      let work=await prepareNotebookProjection(book,target);if(!work.apply())throw new Error('projection not installed');canvas.renderAll();
      if(spec.kind==='undo'){
        renders=0;const inverses=invertNotebookOperation(base,action,{clientId:'writer',actionId:'remove',afterState:target});
        for(const undo of inverses){applyNotebookOperation(target,undo);work=await prepareNotebookProjection(book,target);if(!work.apply())throw new Error('undo not installed');}
        canvas.renderAll();
      }
      const localRenders=renders,actual=pixels(canvas);
      book.dirty=true;canvas.renderAll();const expected=pixels(canvas),canonicalRenders=renders-localRenders;
      let differingChannels=0,maxDifference=0;const examples=[];
      for(let i=0;i<actual.length;i++)if(actual[i]!==expected[i]){
        differingChannels++;maxDifference=Math.max(maxDifference,Math.abs(actual[i]-expected[i]));
        if(examples.length<4)examples.push({x:Math.floor(i/4)%canvas.lowerCanvasEl.width,y:Math.floor(i/4/canvas.lowerCanvasEl.width),a:actual[i],b:expected[i]});
      }
      output.push({name:spec.name,fallback:Boolean(spec.fallback),installs,localRenders,canonicalRenders,differingChannels,maxDifference,examples,
        ...(spec.kind==='text'?{textEditable:typeof book._objects.at(-1).enterEditing==='function'}:{})});
    }catch(error){output.push({name:spec.name,error:String(error.stack??error)});}
    finally{await canvas.dispose();}
  }
  return output;
}
