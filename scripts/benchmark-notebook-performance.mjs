import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const port=5197, base=`http://127.0.0.1:${port}/alex/`;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore'});
const engine=process.env.VERIFICATION_BROWSER==='webkit'?webkit:chromium;
let browser;
try {
  browser=await engine.launch({headless:true,...(engine===chromium?{args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const page=await browser.newPage();
  await page.goto(base+'scripts/board-media-fixture.html');
  const report=await page.evaluate(async incremental=>{const {benchmarkNotebooks}=await import('./notebook-performance-fixture.js');return benchmarkNotebooks({incremental});},process.argv.includes('--stage-b'));
  const output=process.env.NOTEBOOK_BENCHMARK_OUTPUT||'/tmp/notebook-performance.json';
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(!process.argv.includes('--baseline')) {
    const checks=[];
    for(const r of report.results.filter(r=>r.scenario.pages)) {
      checks.push([`linear hydration ${JSON.stringify(r.scenario)}`,r.hydrationVisits<=r.scenario.strokes*2]);
      if(!process.argv.includes('--stage-a')) {
        checks.push([`compact forward ${JSON.stringify(r.scenario)}`,r.forwardBytes<=16384]);
        checks.push([`compact inverse ${JSON.stringify(r.scenario)}`,r.inverseBytes<=16384]);
        checks.push([`hidden pages untouched ${JSON.stringify(r.scenario)}`,r.hiddenPageChanges===0]);
        const first=report.results.find(s=>s.scenario.pages===1&&s.scenario.strokes===r.scenario.strokes);
        checks.push([`page-count independent payload ${JSON.stringify(r.scenario)}`,r.forwardBytes/first.forwardBytes<=1.05&&r.inverseBytes/first.inverseBytes<=1.05]);
      }
    }
    checks.push(['no repeated image encoding',report.results.find(r=>r.scenario.images)?.imageEncodes===0]);
    assert.deepEqual(checks.filter(([,pass])=>!pass),[],`Performance gates failed. Full results: ${output}`);
  }
} finally {await browser?.close();server.kill();}
