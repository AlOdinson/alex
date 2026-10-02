import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookRenderCache } from '../src/lib/notebookRenderCache.js';
const surface=(w,h)=>({width:w,height:h});
test('page cache bounds aggregate bytes and evicts the least recently used page',()=>{
 const cache=createNotebookRenderCache({maxNotebookBytes:128,maxBoardBytes:192});let evicted=[];
 cache.acquire('a',{surfaces:[surface(4,4),surface(4,4)],onEvict:()=>evicted.push('a')});
 cache.acquire('b',{surfaces:[surface(4,4)],onEvict:()=>evicted.push('b')});
 assert.equal(cache.bytesUsed(),192);
 cache.acquire('a');
 cache.acquire('c',{surfaces:[surface(4,4)],onEvict:()=>evicted.push('c')});
 assert.deepEqual(evicted,['b']);assert.equal(cache.bytesUsed(),192);
 cache.release('a');assert.equal(cache.bytesUsed(),64);
 cache.dispose();assert.equal(cache.bytesUsed(),0);
});
test('oversized pages and excess surfaces are not retained; invalidation releases resources',()=>{
 const cache=createNotebookRenderCache({maxNotebookBytes:128,maxBoardBytes:192});let evictions=0;
 assert.equal(cache.acquire('a',{surfaces:[surface(10,10)],onEvict:()=>evictions++}),false);
 assert.equal(cache.acquire('b',{surfaces:[surface(1,1),surface(1,1),surface(1,1)],onEvict:()=>evictions++}),false);
 assert.equal(cache.bytesUsed(),0);assert.equal(evictions,2);
 cache.acquire('c',{surfaces:[surface(4,4)],onEvict:()=>evictions++});cache.invalidate('c');
 assert.equal(cache.bytesUsed(),0);assert.equal(evictions,3);
});
