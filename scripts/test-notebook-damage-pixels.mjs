import test from 'node:test';
import assert from 'node:assert/strict';
import {getEnv} from 'fabric/node';
import {setEnv} from 'fabric';
import {runNotebookDamageCases} from './notebook-damage-fixture.js';
setEnv(getEnv());
test('all shared damage scenarios match canonical pixels without tolerances',async()=>{
 const results=await runNotebookDamageCases();assert.equal(results.length,22);
 for(const result of results){assert.equal(result.error,undefined,JSON.stringify(result));assert.equal(result.differingChannels,0,JSON.stringify(result));
 assert.ok(result.installs>=1,JSON.stringify(result));
 if(result.fallback)assert.ok(result.localRenders>=175,JSON.stringify(result));else assert.ok(result.localRenders<result.canonicalRenders,JSON.stringify(result));}
});
