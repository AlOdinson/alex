import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotNotebookGesturePages,bindNotebookGestureTarget,consumeNotebookGesturePage} from '../src/lib/notebookGestureTarget.js';
function canvasFixture() {
 let reads=0;const events=new Map();const objects=Array.from({length:5000},(_,i)=>({type:'path',boardObjectId:`path${i}`}));
 const canvas={getObjects(){reads++;return objects.slice();},on(name,fn){const set=events.get(name)??new Set();set.add(fn);events.set(name,set);return()=>set.delete(fn);},
  fire(name,target){for(const fn of events.get(name)??[])fn({target});},add(object){objects.push(object);this.fire('object:added',object);},
  remove(object){objects.splice(objects.indexOf(object),1);this.fire('object:removed',object);}};
 return{canvas,get reads(){return reads;}};
}
const book=id=>({type:'boardnotebook',boardObjectId:id,width:520,height:480,notebookPageNumber:1,calcTransformMatrix:()=>[1,0,0,1,260,240]});

test('fifty pencil contact starts reuse the frame registry instead of enumerating 5000 board objects',()=>{
 const f=canvasFixture();const a=book('a');f.canvas.add(a);
 for(let i=0;i<50;i++)assert.equal(snapshotNotebookGesturePages(f.canvas).get('a').notebook,a);
 assert.equal(f.reads,1,'every contact enumerated the entire board');
});
test('frame registry tracks add/remove and captures fresh page and geometry at every contact',()=>{
 const f=canvasFixture(),a=book('a'),b=book('b');f.canvas.add(a);
 const pages=snapshotNotebookGesturePages(f.canvas);a.notebookPageNumber=2;f.canvas.add(b);f.canvas.remove(a);
 const next=snapshotNotebookGesturePages(f.canvas);
 assert.equal(pages.get('a').pageNumber,1);assert.equal(next.has('a'),false);assert.equal(next.get('b').notebook,b);
 b.notebookPageNumber=3;assert.equal(snapshotNotebookGesturePages(f.canvas).get('b').pageNumber,3);assert.equal(f.reads,1);
 const stroke={};bindNotebookGestureTarget(stroke,next);assert.throws(()=>consumeNotebookGesturePage(stroke,b),/изменилась/);
});
test('non-observable adapters are read fresh rather than retaining an unmaintainable index',()=>{
 const a=book('a'),b=book('b');let current=[a];const canvas={getObjects:()=>current};
 assert.ok(snapshotNotebookGesturePages(canvas).has('a'));current=[b];assert.deepEqual([...snapshotNotebookGesturePages(canvas).keys()],['b']);
});
