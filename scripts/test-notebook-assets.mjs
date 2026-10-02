import test from 'node:test';
import assert from 'node:assert/strict';
import {getEnv} from 'fabric/node';
import {setEnv, FabricImage, Textbox, Rect} from 'fabric';
import {BoardNotebook,captureNotebookObject} from '../src/lib/boardNotebook.js';
setEnv(getEnv());
const api=await import('../src/lib/notebookAssets.js').catch(()=>({}));
test('clipped editable text encodes its bitmap exactly once for both fragments and subsequent strokes',async()=>{
 const book=new BoardNotebook({boardObjectId:'book',left:20,top:20,width:300,height:300});
 const text=new Textbox('Crossing boundary',{left:0,top:60,width:220,fontSize:24});text.boardObjectId='text';
 const proto=getEnv().document.defaultView.HTMLCanvasElement.prototype,original=proto.toDataURL;let encodes=0;
 proto.toDataURL=function(...args){encodes++;return original.apply(this,args);};let prepared;
 try {prepared=await captureNotebookObject(book,text);assert.equal(prepared.split,true);assert.ok(prepared.inside instanceof FabricImage);book.addPageObject(prepared.inside);
  for(let i=0;i<100;i++){book.addPageObject(Object.assign(new Rect({width:3,height:3}),{boardObjectId:`ink-${i}`}));book.toObject();}
  prepared.outside.toObject();book.toObject();assert.equal(encodes,1);
 }finally{proto.toDataURL=original;prepared?.outside?.dispose();text.dispose();book.dispose();}
});
test('immutable sources are inline-compatible and replacing the image source invalidates its memo',()=>{
 assert.equal(typeof api.getImmutableNotebookImageSource,'function');
 const document=getEnv().document,a=document.createElement('canvas'),b=document.createElement('canvas');a.width=b.width=4;a.height=b.height=4;let ac=0,bc=0;
 const oldA=a.toDataURL.bind(a),oldB=b.toDataURL.bind(b);a.toDataURL=(...args)=>{ac++;return oldA(...args);};b.toDataURL=(...args)=>{bc++;return oldB(...args);};
 const image=new FabricImage(a);
 try {const first=api.getImmutableNotebookImageSource(image);assert.equal(first.kind,'inline');assert.ok(first.src.startsWith('data:image/png'));
 image.toObject();image.toObject();assert.equal(ac,1);image.setElement(b);image.toObject();assert.equal(bc,1);image.toObject();assert.equal(bc,1);
 }finally{image.dispose();}
});
