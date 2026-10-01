import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const server = process.env.MEDIA_TEST_URL ? null : spawn(process.execPath, ['node_modules/vite/bin/vite.js','--host','127.0.0.1'], {stdio:'ignore'});
const base = process.env.MEDIA_TEST_URL || 'http://127.0.0.1:5173/alex';
for(let i=0;i<100;i++){try{const r=await fetch(base);if(r.ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox','--allow-loopback-in-peer-connection','--disable-features=WebRtcHideLocalIpsWithMdns']});
try {
  const page=await browser.newPage();
  await page.addInitScript(value=>window.MEDIA_SKIP_WEBRTC=value,process.env.MEDIA_SKIP_WEBRTC==='1');
  await page.goto(`${base}/scripts/board-media-fixture.html`);
  await page.waitForFunction(()=>typeof window.runMediaChecks==='function');
  console.log(JSON.stringify(await page.evaluate(()=>window.runMediaChecks()),null,2));
  console.log(JSON.stringify(await page.evaluate(()=>window.runMediaLifecycleChecks()),null,2));
  const board = await page.evaluate(async () => {
    const { createBoard } = await import('/alex/src/lib/boardRepository.js');
    return createBoard('Media integration');
  });
  page.on('pageerror',error=>console.error('APP',error.message));
  await page.goto(`${base}/board/${board.boardId}?key=${board.ownerKey}`);
  await page.waitForTimeout(2000);
  if(await page.getByRole('button',{name:'Войти на доску',exact:true}).count()) {
    await page.getByRole('textbox',{name:'Ваше имя'}).fill('Media tester');
    await page.getByRole('button',{name:'Войти на доску',exact:true}).click();
  }
  await page.locator('input[type=file][accept*="application/pdf"]').waitFor({state:'attached',timeout:20000});
  await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles('scripts/fixtures/media/pages.pdf');
  await page.locator('.pdf-page-controls').waitFor({state:'attached',timeout:20000});
  await page.locator('.pdf-page-controls button').last().click();
  await page.waitForFunction(()=>document.querySelector('.pdf-page-controls span')?.textContent==='2 / 2');
  await page.reload();
  await page.locator('input[type=file][accept*="application/pdf"]').waitFor({state:'attached',timeout:20000});
  await page.evaluate(async id=>{const {getBoardRuntime}=await import('/alex/src/lib/browserBoardRuntimeRegistry.js');window.mediaSnapshot=()=>getBoardRuntime(id)?.getSnapshot?.();},board.boardId);
  await page.waitForFunction(()=>window.mediaSnapshot()?.canvas?.objects?.some(o=>o.mediaKind==='pdf'&&o.pageNumber===2));
  await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles('scripts/fixtures/media/animated.gif');
  await page.waitForFunction(()=>window.mediaSnapshot()?.canvas?.objects?.some(o=>o.mediaKind==='gif'));
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>!window.mediaSnapshot()?.canvas?.objects?.some(o=>o.mediaKind==='gif'));
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(()=>window.mediaSnapshot()?.canvas?.objects?.some(o=>o.mediaKind==='gif'));
  for(const eventName of ['drop','paste']) {
    await page.evaluate(async eventName=>{
      const bytes=await (await fetch('/alex/scripts/fixtures/media/pages.pdf')).blob();
      const dt=new DataTransfer();dt.items.add(new File([bytes],'dropped.pdf',{type:'application/pdf'}));
      if(eventName==='drop')document.querySelector('.canvas-host').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:300,clientY:300}));
      else document.body.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));
    },eventName);
    await page.waitForFunction(()=>window.mediaSnapshot()?.canvas?.objects?.filter(o=>o.mediaKind==='pdf').length===2);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(()=>window.mediaSnapshot()?.canvas?.objects?.filter(o=>o.mediaKind==='pdf').length===1);
  }
  const copied=await page.evaluate(async board=>{const {duplicateBoard}=await import('/alex/src/lib/boardRepository.js');return duplicateBoard(board.boardId,board.ownerKey,'Media copy');},board);
  const copiedAssets=await page.evaluate(async id=>{const {boardMediaAssets}=await import('/alex/src/lib/mediaAssetStore.js');return Promise.all(window.mediaSnapshot().canvas.objects.filter(o=>o.mediaAssetId).map(o=>boardMediaAssets.get(id,o.mediaAssetId).then(Boolean)));},copied.boardId);
  assert.ok(copiedAssets.length===2&&copiedAssets.every(Boolean));
  console.log('Full board: picker, page controls, reload, GIF Undo/Redo, drop/paste, Home duplicate passed');
  const originalPdf=await page.evaluate(()=>window.mediaSnapshot().canvas.objects.find(o=>o.mediaKind==='pdf').mediaAssetId);
  const badBoard=await page.evaluate(async()=>{const {createBoard}=await import('/alex/src/lib/boardRepository.js');return createBoard('Quota failure');});
  await page.goto(`${base}/board/${badBoard.boardId}?key=${badBoard.ownerKey}`);
  await page.locator('input[type=file][accept*="application/pdf"]').waitFor({state:'attached',timeout:20000});
  await page.evaluate(()=>{const open=indexedDB.open.bind(indexedDB);window.restoreMediaStorage=()=>indexedDB.open=open;indexedDB.open=(name,...args)=>{if(name==='alex-board-media')throw new DOMException('Quota exceeded','QuotaExceededError');return open(name,...args);};});
  await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles('scripts/fixtures/media/pages.pdf');
  await page.waitForFunction(()=>document.querySelector('.toolbar-status')?.textContent.includes('Не удалось сохранить медиафайл'));
  assert.equal(await page.locator('.pdf-page-controls').count(),0);
  const storageRecovery=await page.evaluate(async ({sourceId,targetId,assetId})=>{
    window.restoreMediaStorage();const {boardMediaAssets}=await import('/alex/src/lib/mediaAssetStore.js');
    const source=await boardMediaAssets.get(sourceId,assetId),target=await boardMediaAssets.get(targetId,assetId);
    return {sourcePersisted:source?.persisted!==false,targetPersisted:target?.persisted===true};
  },{sourceId:board.boardId,targetId:badBoard.boardId,assetId:originalPdf});
  assert.equal(storageRecovery.sourcePersisted,true);assert.equal(storageRecovery.targetPersisted,false);
  console.log('Full board: quota failure reports error, preserves the source original and never inserts a saved object');
  const disabled=await page.evaluate(async()=>{
    const ReactModule=await import('/alex/node_modules/.vite/deps/react.js');const React=ReactModule.default || ReactModule;
    const client=await import('/alex/node_modules/.vite/deps/react-dom_client.js');const createRoot=client.createRoot || client.default.createRoot;
    const {default:Controls}=await import('/alex/src/components/PdfPageControls.jsx');
    const {LanguageProvider}=await import('/alex/src/components/LanguageProvider.jsx');
    const host=document.body.appendChild(document.createElement('div'));let calls=0;
    const root=createRoot(host);root.render(React.createElement(LanguageProvider,{role:'student'},React.createElement(Controls,{pageNumber:2,pageCount:3,canEdit:false,busy:false,position:{},onPageChange:()=>calls++})));
    await new Promise(ok=>setTimeout(ok,100));const buttons=[...host.querySelectorAll('button')];buttons.forEach(button=>button.click());
    const result=buttons.length===2&&buttons.every(button=>button.disabled)&&calls===0;root.unmount();host.remove();return result;
  });
  assert.ok(disabled);console.log('Read-only PDF controls cannot change pages');
} finally {await browser.close();server?.kill();}
