import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotebookRenderCache} from '../src/lib/notebookRenderCache.js';
test('temporary repair bytes count against owner and board limits and release on completion',()=>{
 const cache=createNotebookRenderCache({maxNotebookBytes:100,maxBoardBytes:150}),book={};
 cache.acquire(book,{surfaces:[{width:4,height:4}]});
 assert.equal(typeof cache.reserveTemporary,'function','repair needs budgeted temporary surfaces');
 const release=cache.reserveTemporary(book,32);assert.equal(typeof release,'function');assert.equal(cache.bytesUsed(),96);
 assert.equal(cache.reserveTemporary(book,8),null);release();release();assert.equal(cache.bytesUsed(),64);
});
test('temporary reservation cannot evict the cache being repaired or other active pages',()=>{
 const cache=createNotebookRenderCache({maxNotebookBytes:200,maxBoardBytes:140}),a={},b={};
 let evicted=0;for(const owner of[a,b])cache.acquire(owner,{surfaces:[{width:4,height:4}],onEvict:()=>evicted++});
 assert.equal(typeof cache.reserveTemporary,'function');assert.equal(cache.reserveTemporary(a,16),null);assert.equal(evicted,0);assert.equal(cache.bytesUsed(),128);
});
