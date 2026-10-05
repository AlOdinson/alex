import {chromium,webkit} from 'playwright-core';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const name=process.env.VERIFICATION_BROWSER==='webkit'?'webkit':'chromium';
const port=5237,base=`http://127.0.0.1:${port}/alex/`,output='notebook-damage-results';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore'});
let browser;
try{
 await mkdir(output,{recursive:true});let ready=false;
 for(let i=0;i<120;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'Vite did not start');
 browser=await(name==='webkit'?webkit:chromium).launch({headless:true,...(name==='chromium'?{args:['--no-sandbox']}:{} )});
 const page=await browser.newPage({viewport:{width:900,height:800},deviceScaleFactor:2}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'scripts/board-media-fixture.html');
 const results=await page.evaluate(async()=>{const {runNotebookDamageCases}=await import('/alex/scripts/notebook-damage-fixture.js');return runNotebookDamageCases();});
 await writeFile(`${output}/${name}.json`,JSON.stringify({name,commit:process.env.GITHUB_SHA,results,errors},null,2));
 assert.equal(results.length,21);
 for(const result of results){assert.equal(result.error,undefined,JSON.stringify(result));assert.equal(result.differingChannels,0,JSON.stringify(result));
  assert.ok(result.installs>=1,JSON.stringify(result));assert.ok(result.canonicalRenders>=175,JSON.stringify(result));
  if(result.fallback)assert.ok(result.localRenders>=175,JSON.stringify(result));else assert.ok(result.localRenders<result.canonicalRenders,JSON.stringify(result));
  if(result.textEditable!==undefined)assert.equal(result.textEditable,true);
 }
 assert.deepEqual(errors,[]);console.log(`${name}: all 21 damage, order, undo, text, image and fallback pixel cases passed`);
}finally{await browser?.close();server.kill();}
