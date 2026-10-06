import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv } from 'fabric';
import { runNotebookZoomCases } from './notebook-zoom-fixture.js';
setEnv(getEnv());
test('viewport cache lifecycle, canonical quality, export and interleaved editing',async()=>{
 const results=await runNotebookZoomCases();assert.equal(results.length,10);
 for(const result of results)assert.equal(result.error,undefined,JSON.stringify(result));
 console.log(JSON.stringify(results));
});
