import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const name=process.env.VERIFICATION_BROWSER==='webkit'?'webkit':'chromium';
const port=5252,base=`http://127.0.0.1:${port}/alex/`,output='notebook-preparation-results';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore'});
let browser;const report={name,commit:process.env.GITHUB_SHA,results:[],errors:[]};
try{
 await mkdir(output,{recursive:true});let ready=false;
 for(let i=0;i<150;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'Vite did not start');
 browser=await(name==='webkit'?webkit:chromium).launch({headless:true,...(name==='chromium'?{args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
 const page=await browser.newPage();page.on('pageerror',error=>report.errors.push(error.message));
 await page.goto(base+'scripts/board-media-fixture.html');
 report.results=await page.evaluate(async()=>{const{runNotebookPreparationCases}=await import('/alex/scripts/notebook-preparation-fixture.js');return runNotebookPreparationCases();});
 assert.equal(report.results.length,9);
 for(const result of report.results)assert.equal(result.error,undefined,JSON.stringify(result));
 assert.deepEqual(report.errors,[]);
 console.log(`${name}: 9 bounded preparation, atomic installation, abort and queue ordering cases passed`);
}catch(error){report.failure=error.stack??error.message;throw error;}
finally{await writeFile(`${output}/${name}.json`,JSON.stringify(report,null,2));await browser?.close();server.kill();}
