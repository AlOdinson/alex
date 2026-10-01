import test from 'node:test';
import assert from 'node:assert/strict';
import { withLocalFileLifecycle } from '../src/lib/localFileLifecycle.js';
import { createStudentLessonLibrary } from '../src/lib/studentLessonLibrary.js';
function setup({ owned = false, fail = false } = {}) {
 const rows = new Map([['a',{scope:'a',boardId:'lesson',savedAt:1}],['b',{scope:'b',boardId:'lesson',savedAt:2}],['c',{scope:'c',boardId:'other',savedAt:3}]]);
 const pending = new Map(); const released = [];
 const storage = { async list(){return [...rows.values()];},async remove(scope){const row=rows.get(scope);pending.set(row.boardId,{boardId:row.boardId,...(!row.boardId?{legacy:true}:{})});rows.delete(scope);},async pendingMediaCleanup(){return [...pending.values()];},async finishMediaCleanup(id){pending.delete(id);} };
 const media = {async listBoardIds(){return ['legacy','owned','other'];},async releaseBoard(id){if(fail)throw Error('storage blocked');released.push(id);} };
 return {rows,pending,released,media,storage,library:createStudentLessonLibrary({storage,media,getOwned:async()=>owned?{}:null,listOwned:async()=>[{boardId:'owned'}],listCached:async()=>['legacy','owned','other'],clearCache:async()=>{}})};
}
test('groups multiple access scopes and removes only that lesson before releasing files',async()=>{
 const x=setup();const lessons=await x.library.list();assert.equal(lessons.length,2);
 await x.library.remove(lessons.find(l=>l.boardId==='lesson'));
 assert.deepEqual([...x.rows.keys()],['c']);assert.deepEqual(x.released,['lesson']);assert.equal(x.pending.size,0);
});
test('retains media when a locally owned board still uses it',async()=>{
 const x=setup({owned:true});await x.library.remove((await x.library.list()).find(l=>l.boardId==='lesson'));assert.deepEqual(x.released,[]);
});
test('failed cleanup is journaled and retried on the next library visit',async()=>{
 const x=setup({fail:true});await assert.rejects(x.library.remove((await x.library.list()).find(l=>l.boardId==='lesson')));
 assert.ok(x.pending.has('lesson'));x.media.releaseBoard=async id=>x.released.push(id);
 await x.library.list();assert.deepEqual(x.released,['lesson']);assert.equal(x.pending.size,0);
});

test('old lesson cleanup waits for the last unidentified archive and preserves owned/known boards',async()=>{
 const x=setup();x.rows.get('a').boardId=null;x.rows.get('b').boardId=null;
 await x.library.remove({scopes:['a']});assert.deepEqual(x.released,[]);assert.ok(x.pending.has(null));
 await x.library.remove({scopes:['b']});assert.deepEqual(x.released,['legacy']);assert.equal(x.pending.size,0);
});
test('lesson cleanup holds the shared lifecycle lock until release finishes',async()=>{
 const x=setup();let signal,finish;const entered=new Promise(r=>signal=r),gate=new Promise(r=>finish=r);let writerRan=false;
 x.media.releaseBoard=async()=>{signal();await gate;assert.equal(writerRan,false);};
 const removal=x.library.remove({boardId:'lesson',scopes:['a','b']});await entered;
 const writer=withLocalFileLifecycle(async()=>{writerRan=true;});
 await Promise.resolve();assert.equal(writerRan,false);finish();await removal;await writer;assert.equal(writerRan,true);
});
