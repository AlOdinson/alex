import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPdfMedia } from '../src/lib/pdfMedia.js';
import { createMediaMemoryBudget } from '../src/lib/mediaMemoryBudget.js';
test('PDF page dimensions, limits, caching and disposal',async()=>{
  let destroyed=0,rendered=0;
  const backend={getDocument:()=>({promise:Promise.resolve({numPages:2,getPage:async n=>({getViewport:({scale})=>({width:100*scale,height:(n===1?200:100)*scale}),render:()=>{rendered++;return {promise:Promise.resolve(),cancel(){}};}}),}) ,destroy(){destroyed++;}})};
  const budget=createMediaMemoryBudget();
  const pdf=await createPdfMedia({blob:new Blob(['%PDF-']),budget,backend,createCanvas:()=>({width:0,height:0,getContext:()=>({})})});
  assert.equal(pdf.pageCount,2);
  const first=await pdf.renderPage(1,{pixelWidth:500});assert.equal(first.height,1000);
  await pdf.renderPage(1,{pixelWidth:500});assert.equal(rendered,1);
  const second=await pdf.renderPage(2,{pixelWidth:10000});assert.ok(second.width*second.height<=4_000_000);
  await assert.rejects(pdf.renderPage(3),/страниц/);
  pdf.dispose();assert.equal(destroyed,1);assert.equal(budget.usedBytes(),0);
});
test('cancelled PDF render releases its canvas and rejects stale output',async()=>{
  let reject,cancelled=0;
  const backend={getDocument:()=>({promise:Promise.resolve({numPages:1,getPage:async()=>({getViewport:({scale})=>({width:100*scale,height:100*scale}),render:()=>({promise:new Promise((_,no)=>reject=no),cancel(){cancelled++;reject(new Error('cancelled'));}})}),}),destroy(){}})};
  const budget=createMediaMemoryBudget(); const pdf=await createPdfMedia({blob:new Blob(['%PDF-']),budget,backend,createCanvas:()=>({getContext:()=>({})})});
  const controller=new AbortController();const rendering=pdf.renderPage(1,{signal:controller.signal});
  await new Promise(ok=>setTimeout(ok,0));controller.abort();await assert.rejects(rendering);
  assert.equal(cancelled,1);pdf.dispose();assert.equal(budget.usedBytes(),0);
});
test('concurrent matching PDF renders never invalidate returned canvases and pinned pages survive cache trim',async()=>{
 const finishes=[];
 const backend={getDocument:()=>({promise:Promise.resolve({numPages:5,getPage:async n=>({getViewport:({scale})=>({width:100*scale,height:100*scale}),render:()=>({promise:new Promise(ok=>finishes.push(ok)),cancel(){}})})}),destroy(){}})};
 const budget=createMediaMemoryBudget();const pdf=await createPdfMedia({blob:new Blob(['%PDF-']),budget,backend,createCanvas:()=>({width:0,height:0,getContext:()=>({})})});
 try {
  const a=pdf.renderPage(1,{pixelWidth:500}),b=pdf.renderPage(1,{pixelWidth:500});await new Promise(ok=>setTimeout(ok,0));finishes.splice(0).forEach(ok=>ok());
  const results=await Promise.all([a,b]);assert.ok(results.every(result=>result.element.width===500));budget.pin(results[0].cacheKey,true);
  for(let page=2;page<=5;page++){const next=pdf.renderPage(page,{pixelWidth:500});await new Promise(ok=>setTimeout(ok,0));finishes.splice(0).forEach(ok=>ok());await next;}
  assert.equal(results[0].element.width,500);
 }finally{pdf.dispose();}assert.equal(budget.usedBytes(),0);
});
