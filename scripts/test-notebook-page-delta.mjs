import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, Rect, Textbox, StaticCanvas, classRegistry, util } from 'fabric';
import * as notebookApi from '../src/lib/boardNotebook.js';
setEnv(getEnv());
const {createBoardNotebook,BoardNotebook,setNotebookPage}=notebookApi;
const delta=(book,op)=>{assert.equal(typeof notebookApi.applyPageDeltaToFabric,'function','missing incremental Fabric page adapter');return notebookApi.applyPageDeltaToFabric(book,op);};
const operation=(changes,pageNumber=1)=>({type:'notebook',version:1,id:'book',pageNumber,changes});
const record=(id,extra={})=>({...new Rect({left:-200,top:-180,width:40,height:25,fill:'red',strokeWidth:0,...extra}).toObject(),boardObjectId:id});
const insert=(id,extra={})=>({type:'insert',ifAbsent:true,object:record(id,extra)});
const create=options=>createBoardNotebook({boardObjectId:'book',...options});
const gates=new Map(); let disposedSlow=0;
class SlowRect extends Rect {
  static type='SlowRect';
  static async fromObject(value,options){await gates.get(value.boardObjectId)?.promise;return super.fromObject(value,options);}
  dispose(){disposedSlow++;return super.dispose();}
}
classRegistry.setClass(SlowRect);
const gate=id=>{let resolve;const promise=new Promise(r=>{resolve=r;});const result={promise,resolve};gates.set(id,result);return result;};
const slowRecord=id=>({...record(id),type:'SlowRect'});
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('one incoming child revives only that child and retains unchanged Fabric and serialized objects',async()=>{
  const book=create();for(let i=0;i<100;i++){const object=new Rect({width:5,height:5});object.boardObjectId=`old-${i}`;book.addPageObject(object);}
  const previous=book.getPageObjects(), records=book.notebookPages[0];let revived=0;
  const original=Rect.fromObject, full=BoardNotebook.fromObject;
  Rect.fromObject=function(...args){revived++;return original.apply(this,args);};
  BoardNotebook.fromObject=()=>{throw new Error('full notebook revival forbidden');};
  previous.forEach(object=>{object.toObject=()=>{throw new Error('unchanged child serialized');};});
  try{const result=await delta(book,operation([insert('new')]));assert.equal(result.changed,true);assert.equal(revived,1);
    assert.equal(book.getPageObjects().length,101);previous.forEach((object,i)=>{assert.equal(book.getPageObjects()[i],object);assert.equal(book.notebookPages[0][i],records[i]);});
    assert.equal(book.getPageObjects()[100].boardObjectId,'new');
  }finally{Rect.fromObject=original;BoardNotebook.fromObject=full;book.dispose();}
});

test('hidden-page image delta never decodes/revives an image or invalidates visible pixels',async()=>{
  const book=create({notebookPages:[[],[]],notebookPageNumber:1});const visible=book.getPageObjects();book.dirty=false;
  const op=operation([{type:'insert',object:{type:'Image',boardObjectId:'hidden-image',src:'not-a-loadable-image'},ifAbsent:true}],2);
  const result=await delta(book,op);assert.equal(result.changed,true);assert.equal(book.dirty,false);
  assert.deepEqual(book.getPageObjects(),visible);assert.equal(book.notebookPages[1][0].boardObjectId,'hidden-image');book.dispose();
});

test('a whole-text patch replaces only the affected editable text and retains other children',async()=>{
  const book=create();const text=new Textbox('before',{left:-150,top:-150,width:120,fontSize:20});text.boardObjectId='text';book.addPageObject(text);
  const other=new Rect({width:10,height:10});other.boardObjectId='other';book.addPageObject(other);
  await delta(book,operation([{type:'patch',id:'text',patch:{text:'after'}}]));
  assert.equal(book.getPageObjects()[0].type,'textbox');assert.equal(book.getPageObjects()[0].text,'after');
  assert.equal(book.getPageObjects()[1],other);assert.equal(book.notebookPages[0][0].text,'after');book.dispose();
});

test('incremental add/patch/delete pixels match a full revival including transparency and isolated erasing',async()=>{
  const book=create({left:20,top:20,width:300,height:280});
  const changes=[insert('back',{left:-100,top:-80,width:150,height:80,fill:'blue'}),insert('translucent',{left:-60,top:-60,fill:'red',opacity:.5}),
    insert('erase',{left:-90,top:-65,width:10,height:50,globalCompositeOperation:'destination-out'})];
  await delta(book,operation(changes));await delta(book,operation([{type:'patch',id:'translucent',patch:{left:-45}}]));
  await delta(book,operation([{type:'delete',id:'back'}]));await delta(book,operation([{...changes[0],zIndex:0}]));
  const reference=await BoardNotebook.fromObject(book.toObject(['boardObjectId']));
  const canvases=[book,reference].map(value=>{const canvas=new StaticCanvas(null,{width:360,height:330,enableRetinaScaling:false,renderOnAddRemove:false});canvas.add(value);canvas.renderAll();return canvas;});
  try{assert.deepEqual(Buffer.from(canvases[0].getContext().getImageData(0,0,360,330).data),Buffer.from(canvases[1].getContext().getImageData(0,0,360,330).data));}
  finally{await Promise.all(canvases.map(canvas=>canvas.dispose()));}
});

test('page flip during asynchronous preparation stores the delta on its original page only',async()=>{
  const wait=gate('slow-add'), book=create({notebookPages:[[],[]]});
  const work=delta(book,operation([{type:'insert',object:slowRecord('slow-add'),ifAbsent:true}]));await tick();
  await setNotebookPage(book,2);wait.resolve();await work;
  assert.equal(book.notebookPageNumber,2);assert.equal(book.getPageObjects().length,0);assert.equal(book.notebookPages[0][0].boardObjectId,'slow-add');
  await setNotebookPage(book,1);assert.equal(book.getPageObjects()[0].boardObjectId,'slow-add');book.dispose();
});

test('deleting a notebook during preparation discards prepared objects without attaching them',async()=>{
  const wait=gate('retired'), book=create();const before=disposedSlow;
  const work=delta(book,operation([{type:'insert',object:slowRecord('retired'),ifAbsent:true}]));await tick();book.dispose();wait.resolve();
  const result=await work;assert.equal(result.changed,false);assert.equal(book.notebookPages[0].length,0);assert.ok(disposedSlow>before);
});

test('latest page navigation wins even when the previous page finishes loading last',async()=>{
  const wait=gate('page-two'),book=create({notebookPages:[[],[slowRecord('page-two')],[record('page-three')]]});
  const old=setNotebookPage(book,2);await tick();assert.equal(await setNotebookPage(book,3),true);
  wait.resolve();assert.equal(await old,false);assert.equal(book.notebookPageNumber,3);assert.equal(book.getPageObjects()[0].boardObjectId,'page-three');book.dispose();
});

test('hidden-page delta arriving during navigation is included, not overwritten by the older hydration',async()=>{
  const wait=gate('loading-page'),book=create({notebookPages:[[],[slowRecord('loading-page')]]});
  const navigating=setNotebookPage(book,2);await tick();await delta(book,operation([insert('arrived')],2));wait.resolve();
  assert.equal(await navigating,true);assert.deepEqual(book.getPageObjects().map(o=>o.boardObjectId),['loading-page','arrived']);book.dispose();
});

test('local sibling inserted during async preparation is retained along with the incoming child',async()=>{
  const wait=gate('remote'),book=create();const work=delta(book,operation([{type:'insert',ifAbsent:true,object:slowRecord('remote')} ]));await tick();
  const local=new Rect({width:5,height:5});local.boardObjectId='local';book.addPageObject(local);wait.resolve();await work;
  assert.deepEqual(book.getPageObjects().map(o=>o.boardObjectId),['local','remote']);assert.equal(book.getPageObjects()[0],local);book.dispose();
});

test('operation target and content are captured before asynchronous queued work starts',async()=>{
  const book=create({notebookPages:[[],[]]});const op=operation([insert('immutable')]);const work=delta(book,op);
  op.pageNumber=2;op.changes[0].object.fill='purple';await work;
  assert.equal(book.notebookPages[0][0]?.boardObjectId,'immutable');assert.equal(book.notebookPages[0][0].fill,'red');
  assert.equal(book.notebookPages[1].length,0);book.dispose();
});

test('removal and reattachment cancels old preparation but allows subsequent new deltas',async()=>{
  const book=create(),canvas=new StaticCanvas(null,{width:600,height:500,renderOnAddRemove:false});canvas.add(book);
  const wait=gate('removed-view');const work=delta(book,operation([{type:'insert',ifAbsent:true,object:slowRecord('removed-view')}]));await tick();
  canvas.remove(book);canvas.add(book);wait.resolve();assert.equal((await work).changed,false);assert.equal(book.notebookPages[0].length,0);
  await delta(book,operation([insert('fresh-view')]));assert.equal(book.notebookPages[0][0].boardObjectId,'fresh-view');await canvas.dispose();
});
