import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, StaticCanvas, Path, Rect, Textbox, FabricImage, Circle, Group, util } from 'fabric';
import { createBoardNotebook, captureNotebookObject } from '../src/lib/boardNotebook.js';
setEnv(getEnv());
const book = (o={}) => createBoardNotebook({left:100,top:100,width:200,height:200,...o});
function unmasked(o) { assert.equal(o.clipPath, undefined, 'fragments must not retain clipping masks'); for(const c of o.getObjects?.()??[])unmasked(c); }
async function pixels(o, points) {
 const c=new StaticCanvas(null,{width:700,height:500,enableRetinaScaling:false,renderOnAddRemove:false});
 c.add(o);c.renderAll();const data=points.map(([x,y])=>[...c.getContext().getImageData(x,y,1,1).data]);
 c.remove(o);await c.dispose();return data;
}
function picture(w=400,h=100) {const c=util.createCanvasElement();c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle='#ff0000';x.fillRect(0,0,w,h);return new FabricImage(c,{left:0,top:140,originX:'left',originY:'top'});}

test('a crossing stroke has real vector remnants, no concealed center in the outside object',async()=>{
 const b=book(),p=new Path('M 20 150 L 380 150',{fill:null,stroke:'red',strokeWidth:8,strokeLineCap:'round'});
 const saved=JSON.stringify(p.toObject());const r=await captureNotebookObject(b,p);assert.ok(r?.split);
 unmasked(r.inside);unmasked(r.outside);assert.ok(!(r.inside instanceof FabricImage));
 assert.ok(r.inside.width<=200.01,'only the 200px intersection belongs inside');
 assert.equal((await pixels(r.outside,[[180,150]]))[0][3],0);
 assert.ok((await pixels(r.outside,[[40,150],[360,150]])).every(p=>p[0]>240&&p[3]>240));
 b.addPageObject(r.inside);assert.ok((await pixels(b,[[180,150]]))[0][0]>240);
 assert.equal(JSON.stringify(p.toObject()),saved);await b.dispose();r.outside.dispose();p.dispose();
});
test('bounding-box overlap with no actual painted overlap does not capture an outside stroke',async()=>{
 const b=book(),p=new Path('M 50 60 L 350 60 L 350 350',{stroke:'black',strokeWidth:4,fill:null});
 assert.equal(await captureNotebookObject(b,p),null);await b.dispose();p.dispose();
});
test('cut image owns new cropped pixels and the removed center is physically transparent',async()=>{
 const b=book({left:180,width:40}),p=picture();p.storagePath='old/source.png';const original=p.getSrc();
 const r=await captureNotebookObject(b,p);assert.ok(r?.split);unmasked(r.inside);unmasked(r.outside);
 assert.ok(r.inside instanceof FabricImage);assert.ok(r.inside.width<=42);assert.notEqual(r.inside.getSrc(),original);assert.notEqual(r.outside.getSrc(),original);
 assert.equal(r.inside.storagePath,undefined);assert.equal(r.outside.storagePath,undefined);
 const e=r.outside.getElement();assert.equal(e.getContext('2d').getImageData(200,20,1,1).data[3],0);
 assert.equal((await pixels(r.outside,[[200,160]]))[0][3],0);assert.equal(p.getSrc(),original);
 await b.dispose();r.inside.dispose();r.outside.dispose();p.dispose();
});
test('partial text is independently cropped bitmap fragments; whole text remains editable',async()=>{
 const b=book(),whole=new Textbox('AB',{left:140,top:140,width:60,fontSize:32,originX:'left',originY:'top'});
 const w=await captureNotebookObject(b,whole);assert.equal(w.split,false);assert.equal(w.inside.type,'textbox');
 const p=new Textbox('MMMMMMMM',{left:280,top:150,width:320,fontSize:40,originX:'left',originY:'top'});
 const r=await captureNotebookObject(b,p);assert.ok(r?.split);unmasked(r.inside);unmasked(r.outside);
 assert.ok(r.inside instanceof FabricImage);assert.ok(r.outside instanceof FabricImage);
 assert.ok(r.inside.width<r.outside.width/2,'small text fragment cannot retain the full line bitmap');
 await b.dispose();w.inside.dispose();r.inside.dispose();r.outside.dispose();whole.dispose();p.dispose();
});
test('a filled compound path hole is not an intersection',async()=>{
 const b=book({left:160,top:160,width:60,height:60});
 const p=new Path('M 0 0 L 400 0 L 400 400 L 0 400 Z M 100 100 L 300 100 L 300 300 L 100 300 Z',{fill:'red',fillRule:'evenodd',stroke:null});
 assert.equal(await captureNotebookObject(b,p),null);await b.dispose();p.dispose();
});
test('an old inverted rectangle mask is baked when its visible remnant is captured again',async()=>{
 const b=book({left:80,width:100}),p=picture();p.clipPath=new Rect({width:200,height:100,left:0,top:0,originX:'center',originY:'center',inverted:true});
 const r=await captureNotebookObject(b,p);assert.ok(r);unmasked(r.inside);if(r.outside)unmasked(r.outside);
 b.addPageObject(r.inside);const pix=await pixels(b,[[150,160],[280,160]]);assert.equal(pix[0][0],255); // page background, not red
 assert.equal(pix[0][1],255,'previously removed pixels stay absent');
 await b.dispose();r.outside?.dispose();p.dispose();
});

async function render(o){const c=new StaticCanvas(null,{width:700,height:500,enableRetinaScaling:false,renderOnAddRemove:false});c.add(...(Array.isArray(o)?o:[o]));c.renderAll();const d=c.getContext().getImageData(0,0,700,500).data;c.remove(...c.getObjects());await c.dispose();return d;}
async function compareCut(source,b,label){
 // Compare native geometry, not unrelated source cache interpolation at fractional zoom.
 const noCache=o=>{o.objectCaching=false;for(const c of o.getObjects?.()??[])noCache(c);};noCache(source);
 const original=JSON.stringify(source.toObject());const before=await render(source),r=await captureNotebookObject(b,source);assert.ok(r?.inside,label+' intersects actual paint');
 unmasked(r.inside);if(r.outside)unmasked(r.outside);
 util.applyTransformToObject(r.inside,util.multiplyTransformMatrices(b.calcTransformMatrix(),r.inside.calcOwnMatrix()));
 noCache(r.inside);if(r.outside)noCache(r.outside);
 const after=await render([r.inside,r.outside].filter(Boolean));let bad=0,active=0;const back=util.invertTransform(b.calcTransformMatrix());
 for(let y=0;y<500;y++)for(let x=0;x<700;x++){
  const local=new (awaitPoint)(x+.5,y+.5).transform(back);
  if(Math.abs(Math.abs(local.x)-b.width/2)<2||Math.abs(Math.abs(local.y)-b.height/2)<2)continue;
  const i=(y*700+x)*4;if(before[i+3]||after[i+3]){active++;let d=0;for(let k=0;k<4;k++)d=Math.max(d,Math.abs(before[i+k]-after[i+k]));if(d>20)bad++;}
 }
 assert.ok(bad/Math.max(active,1)<0.025,`${label}: ${bad}/${active} pixels changed away from cut boundaries`);
 assert.equal(JSON.stringify(source.toObject()),original,'cut preparation leaves original intact');
 r.inside.dispose();r.outside?.dispose();await b.dispose();source.dispose();
}
const {Point:awaitPoint,Ellipse,Polygon}=await import('fabric');
for(const [label,factory] of [
 ['rotated circle',()=>new Circle({left:140,top:170,radius:85,fill:'red',stroke:'blue',strokeWidth:7,angle:37,scaleX:1.3,scaleY:.8})],
 ['ellipse',()=>new Ellipse({left:170,top:160,rx:100,ry:30,fill:null,stroke:'red',strokeWidth:5,angle:24})],
 ['rounded rectangle',()=>new Rect({left:160,top:200,width:160,height:110,rx:30,ry:15,angle:28,fill:'blue',stroke:'red',strokeWidth:7,opacity:.4})],
 ['bezier stroke',()=>new Path('M 20 190 C 90 10 260 360 350 180 Q 400 30 500 190',{fill:null,stroke:'black',strokeWidth:9,strokeLineCap:'round',strokeLineJoin:'round'})],
 ['uniform stroke',()=>new Path('M 20 150 L 150 190 L 280 120',{fill:null,stroke:'red',strokeWidth:7,strokeUniform:true,scaleX:1.6,scaleY:.8,skewX:15})],
 ['dashed stroke',()=>new Path('M 20 190 L 450 190',{fill:null,stroke:'red',strokeWidth:8,strokeDashArray:[19,13],strokeDashOffset:7,strokeLineCap:'butt'})],
 ['group opacity',()=>new Group([new Rect({left:130,top:180,width:150,height:80,fill:'red',opacity:.5}),new Rect({left:400,top:180,width:100,height:80,fill:'blue',opacity:.7})],{opacity:.5})],
 ['rotated bitmap',()=>{const p=picture(360,90);p.set({left:200,top:200,angle:27,scaleX:.8,scaleY:1.3,flipX:true});return p;}],
 ['bevel acute join',()=>new Path('M 20 160 L 230 160 L 50 190',{fill:null,stroke:'red',strokeWidth:15,strokeLineJoin:'bevel'})],
 ['limited miter join',()=>new Path('M 20 160 L 230 160 L 50 190',{fill:null,stroke:'red',strokeWidth:15,strokeLineJoin:'miter',strokeMiterLimit:2})],
])test(`true cut preserves pixels: ${label}`,()=>compareCut(factory(),book(),label));
test('a round pen dot crossing the boundary survives integer quantization',async()=>{
 const b=book(),p=new Path('M 99.999999 150 L 100.000001 150',{fill:null,stroke:'red',strokeWidth:10,strokeLineCap:'round'});
 const r=await captureNotebookObject(b,p);assert.ok(r?.inside);assert.ok(r.outside);unmasked(r.inside);unmasked(r.outside);
 const outside=await pixels(r.outside,[[97,150],[102,150]]);assert.equal(outside[0][0],255);assert.equal(outside[0][3],255);assert.equal(outside[1][3],0);
 await b.dispose();r.inside.dispose();r.outside.dispose();p.dispose();
});
test('bevel and limited-miter joins do not gain a square protrusion',async()=>{
 for(const join of ['bevel','miter']){
  const b=book(),p=new Path('M 20 160 L 230 160 L 50 190',{fill:null,stroke:'red',strokeWidth:15,strokeLineJoin:join,strokeMiterLimit:2,objectCaching:false});
  const r=await captureNotebookObject(b,p);assert.ok(r?.inside);util.applyTransformToObject(r.inside,util.multiplyTransformMatrices(b.calcTransformMatrix(),r.inside.calcOwnMatrix()));
  const a=await pixels(p,[[235,159]]),d=await pixels(r.inside,[[235,159]]);assert.equal(d[0][3],a[0][3],'a bevel is not a square join');
  await b.dispose();r.inside.dispose();r.outside?.dispose();p.dispose();
 }
});
test('dash gaps and transparent pixels cannot produce an invisible inside copy',async()=>{
 const b=book({left:150,width:50}),p=new Path('M 0 150 L 400 150',{fill:null,stroke:'black',strokeWidth:5,strokeDashArray:[100,300]});
 assert.equal(await captureNotebookObject(b,p),null);
 const image=picture();image.getElement().getContext('2d').clearRect(100,0,200,100);
 assert.equal(await captureNotebookObject(b,image),null);await b.dispose();p.dispose();image.dispose();
});
test('text shadow pixels are retained in the actual two fragments',async()=>{
 const {Shadow}=await import('fabric');return compareCut(new Textbox('MMMM',{left:70,top:150,width:200,fontSize:45,originX:'left',originY:'top',shadow:new Shadow({color:'red',offsetX:10,offsetY:8,blur:0})}),book(),'text shadow');
});

test('nested legacy masks are materialized even when the complete group fits inside',async()=>{
 const b=book({left:0,top:0,width:500,height:450});
 const p=new Rect({left:100,top:150,width:120,height:80,fill:'red',strokeWidth:0});
 p.clipPath=new Rect({width:40,height:80,inverted:true,originX:'center',originY:'center'});
 const g=new Group([p]);const saved=JSON.stringify(g.toObject());
 const r=await captureNotebookObject(b,g);assert.ok(r);unmasked(r.inside);assert.equal(r.outside,null);
 util.applyTransformToObject(r.inside,util.multiplyTransformMatrices(b.calcTransformMatrix(),r.inside.calcOwnMatrix()));
 const output=await pixels(r.inside,[[100,150],[50,150]]);assert.equal(output[0][3],0);assert.ok(output[1][3]>240);
 assert.equal(JSON.stringify(g.toObject()),saved);await b.dispose();r.inside.dispose();g.dispose();
});
test('an external member of a split group retains only its actual paint',async()=>{
 const b=book();const near=new Rect({left:100,top:150,width:80,height:60,fill:'red',strokeWidth:0});
 const far=new Rect({left:550,top:170,width:80,height:60,fill:'blue',strokeWidth:0});
 far.clipPath=new Rect({width:20,height:60,inverted:true,originX:'center',originY:'center'});
 const g=new Group([near,far]);const r=await captureNotebookObject(b,g);assert.ok(r?.split);unmasked(r.inside);unmasked(r.outside);
 const px=await pixels(r.outside,[[550,170],[520,170],[125,150]]);assert.equal(px[0][3],0);assert.ok(px[1][2]>240);assert.equal(px[2][3],0);
 await b.dispose();r.inside.dispose();r.outside.dispose();g.dispose();
});
test('closed dashed contours preserve the uninterrupted dash over their seam',()=>compareCut(new Path('M 120 160 L 260 160 L 260 280 L 120 280 Z',{fill:null,stroke:'red',strokeWidth:15,strokeDashArray:[70,20],strokeDashOffset:15,strokeLineJoin:'round',strokeLineCap:'round'}),book({left:200,width:200}),'closed dash'));
test('vector object background retains its stroke-expanded native dimensions',()=>compareCut(new Rect({left:175,top:160,width:140,height:70,strokeWidth:20,fill:null,stroke:null,backgroundColor:'red'}),book(),'stroke-expanded background'));
test('transparent and invisible objects are not captured',async()=>{
 const b=book(),p=new Path('M 120 150 L 280 150',{fill:null,stroke:'black',strokeWidth:3,opacity:0});
 assert.equal(await captureNotebookObject(b,p),null);p.opacity=1;p.visible=false;assert.equal(await captureNotebookObject(b,p),null);await b.dispose();p.dispose();
});

test('group shadow survives a true cut instead of being silently discarded',async()=>{
 const {Shadow}=await import('fabric');
 return compareCut(new Group([new Rect({left:70,top:150,width:300,height:100,fill:'blue',strokeWidth:0})],
  {shadow:new Shadow({color:'red',offsetX:18,offsetY:15,blur:0})}),book(),'group shadow');
});

test('cutting a vector remnant again cannot resurrect the first removed region',async()=>{
 const a=book({left:180,top:100,width:40}),b=book({left:80,top:100,width:40});
 const p=new Path('M 20 150 L 380 150',{fill:null,stroke:'red',strokeWidth:8});
 const first=await captureNotebookObject(a,p);assert.ok(first?.split);
 const second=await captureNotebookObject(b,first.outside);assert.ok(second?.split);
 unmasked(second.inside);unmasked(second.outside);
 assert.ok(second.inside.width<=40.01);
 const d=await pixels(second.outside,[[100,150],[200,150],[50,150],[300,150]]);
 assert.equal(d[0][3],0);assert.equal(d[1][3],0);assert.ok(d[2][3]>240&&d[3][3]>240);
 assert.equal(await captureNotebookObject(a,second.outside),null);
 for(const o of [first.inside,first.outside,second.inside,second.outside,p])o.dispose();await a.dispose();await b.dispose();
});

test('cutting an image remnant again keeps previous pixel holes actually empty',async()=>{
 const a=book({left:180,width:40}),b=book({left:80,width:40}),p=picture();
 const first=await captureNotebookObject(a,p),second=await captureNotebookObject(b,first.outside);
 assert.ok(second?.split);unmasked(second.inside);unmasked(second.outside);
 const d=await pixels(second.outside,[[100,160],[200,160],[50,160],[300,160]]);
 assert.equal(d[0][3],0);assert.equal(d[1][3],0);assert.ok(d[2][3]>240&&d[3][3]>240);
 assert.equal(await captureNotebookObject(a,second.outside),null);
 for(const o of [first.inside,first.outside,second.inside,second.outside,p])o.dispose();await a.dispose();await b.dispose();
});

test('oversized raster fragments reject before replacing or mutating the original',async()=>{
 const b=book({left:100,top:100,width:50}),p=picture(18000,10);
 const saved=JSON.stringify(p.toObject());
 await assert.rejects(captureNotebookObject(b,p),/слишком большой/);
 assert.equal(JSON.stringify(p.toObject()),saved);assert.equal(b.getPageObjects().length,0);
 await b.dispose();p.dispose();
});

async function splitVerificationFixture() {
 const {readFileSync}=await import('node:fs');
 const {createBoundedCanvasVerifier}=await import('../src/lib/boundedCanvasVerifier.js');
 const {createVerificationBudget}=await import('../src/lib/boundedVerificationDigest.js');
 const source=readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
 const begin=source.indexOf('const canVerifyCanvas = '),end=source.indexOf('\n    const getBoundedCanvasVerifier =',begin);
 assert.ok(begin>=0&&end>begin);
 const ref=current=>({current}),stroke={boardObjectId:'fresh-stroke',type:'path'},canvas={_objects:[stroke]};
 const scope={canvas,canReadDocumentsRef:ref(false),boardReadyRef:ref(true),fabricCanvasRef:ref(canvas),revisionRef:ref(7),
  applyingRemoteRef:ref(false),historyCommandBusyRef:ref(false),notebookMutationActiveRef:ref(false),pendingServerWritesRef:ref(0),
  notebookControllerRef:ref({pendingCount:()=>0}),pendingLocalObjectMutationCountsRef:ref(new Map()),pendingLocalBackgroundMutationCountRef:ref(0),
  localLockIdsRef:ref([]),remoteLocksRef:ref(new Map()),activePencilRef:ref(null),shapeDraftRef:ref(null),lineRef:ref(null),
  touchGestureRef:ref(null),localSelectionTransactionRef:ref(null),textBeforeRef:ref(new Map()),liveDrawSendRef:ref(null),liveTransformSendRef:ref(null)};
 const canCheck=new Function('scope',`with(scope){${source.slice(begin,end)};return canVerifyCanvas;}`)(scope);
 let onRegistry=()=>{};const repairs=[];
 const verifier=createBoundedCanvasVerifier({getCanvas:()=>canvas,getRegistry:()=>{onRegistry();return new Map([[stroke.boardObjectId,new Set([stroke])]]);},
  getRevision:()=>7,getBackground:()=> 'blank',canCheck,placementMatches:()=>true,
  apply:async(records,context)=>{if(!context.isCurrent())return false;repairs.push(records);canvas._objects=[];return true;}});
 return {scope,canvas,canCheck,repairs,verifier,onRegistry:fn=>{onRegistry=fn;},
  records:[{id:stroke.boardObjectId,object:null,zIndex:-1}],context:()=>({revision:7,background:'blank',isCurrent:()=>true,budget:createVerificationBudget()})};
}

test('fresh stroke awaiting notebook split is not a removable Canvas ghost',async()=>{
 const f=await splitVerificationFixture();assert.equal(f.canCheck(),true);
 f.scope.notebookMutationActiveRef.current=true;
 assert.equal(await f.verifier.check(f.records,f.context()),false,'preparation precedes outbox/lease but already owns the visible stroke');
 assert.equal(f.repairs.length,0);assert.equal(f.canvas._objects.length,1);
 f.scope.notebookMutationActiveRef.current=false;
 assert.equal(await f.verifier.check(f.records,f.context()),true,'ordinary genuine ghost repair is not disabled after preparation ends');
 assert.equal(f.repairs.length,1);
});

test('in-flight Canvas repair rechecks notebook preparation before removing a new stroke',async()=>{
 const f=await splitVerificationFixture();
 f.onRegistry(()=>{f.scope.notebookMutationActiveRef.current=true;});
 assert.equal(await f.verifier.check(f.records,f.context()),false);
 assert.equal(f.repairs.length,0);assert.equal(f.canvas._objects.length,1);
});
