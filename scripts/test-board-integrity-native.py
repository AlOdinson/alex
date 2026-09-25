"""Native browser tests. Only Ably discovery/signaling is replaced by a local bus;
React Board, Fabric, IndexedDB, history, WebRTC/DataChannel and integrity are real.
Run with a Vite server: python scripts/test-board-integrity-native.py
"""
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ.get('INTEGRITY_TEST_URL', 'http://127.0.0.1:5173/alex/')
OUT = Path(os.environ.get('INTEGRITY_RESULTS', '/mnt/data/integrity-native-results'))
OUT.mkdir(parents=True, exist_ok=True)
BUS = r"""
const NativePeerConnection = globalThis.RTCPeerConnection;
globalThis.RTCPeerConnection = class extends NativePeerConnection {
  constructor(config) { super({...config, iceServers:[]}); }
};
globalThis.__integrityTestTransport = (o) => {
  const bc = new BroadcastChannel(`integrity-test:${o.boardId}:${o.roomKey}`);
  const me = { clientId:o.clientId, name:o.name, permission:o.permission, color:o.color };
  const members = new Map([[me.clientId, me]]);
  let closed=false;
  const users = () => { o.onUsers([...members.values()]); return [...members.values()]; };
  bc.onmessage = ({data:d}) => {
    if(closed) return;
    if(d.kind==='hello') {
      const fresh=!members.has(d.me.clientId); members.set(d.me.clientId,d.me); users();
      if(fresh) bc.postMessage({kind:'hello',me});
    } else if(d.kind==='bye') {members.delete(d.id);users();}
    else if(d.kind==='event') Promise.resolve(o.onEvent(d.event,d.payload)).catch(o.onError);
  };
  return {
    async start(){users();bc.postMessage({kind:'hello',me});o.onStatus('SUBSCRIBED');},
    async publish(event,payload){bc.postMessage({kind:'event',event,payload});return 'ok';},
    async refreshUsers(){bc.postMessage({kind:'hello',me});return users();},
    async disconnect(){closed=true;bc.postMessage({kind:'bye',id:me.clientId});bc.close();}
  };
};
"""

def configure(context):
    context.add_init_script(BUS)
    def route_local(route):
        url=route.request.url
        if not url.startswith(BASE.split('/alex/')[0]):
            route.fulfill(status=200, content_type='text/javascript', body='')
            return
        if '/src/lib/browserAuthorityRealtime.js' in url:
            resp=route.fetch(); body=resp.text()
            assert 'dependencies.createTransport ?? createAblyBrowserTransport' in body
            body=body.replace('dependencies.createTransport ?? createAblyBrowserTransport','dependencies.createTransport ?? globalThis.__integrityTestTransport ?? createAblyBrowserTransport')
            body=body.replace('  core = createCore({','  globalThis.__integrityTestSession = session;\n  core = createCore({',1)
            route.fulfill(response=resp,body=body)
        elif '/src/components/Board.jsx' in url:
            resp=route.fetch(); body=resp.text()
            assert 'fabricCanvasRef.current = canvas;' in body
            body=body.replace('fabricCanvasRef.current = canvas;','fabricCanvasRef.current = canvas; globalThis.__integrityTestCanvas = canvas;',1)
            route.fulfill(response=resp,body=body)
        else: route.continue_()
    context.route('**/*',route_local)


def enter(page, name):
    page.wait_for_function("document.querySelector('canvas.upper-canvas') || document.querySelector('#board-access-name')")
    if not page.locator('canvas.upper-canvas').count():
        label=page.get_by_label('Ваше имя')
        if label.count():
            label.fill(name); page.get_by_role('button',name='Войти на доску',exact=True).click()
    page.locator('canvas.upper-canvas').wait_for(state='visible',timeout=15000)
    page.wait_for_function("globalThis.__integrityTestSession?.getRuntimeState()==='ready'",timeout=15000)


def wait_idle(page):
    page.wait_for_function("""() => { const s=globalThis.__integrityTestSession?.getIntegrityStatus();
      return s && !s.running && !s.timerPending && s.pending===0 && !s.rescan && !s.paused; }""",timeout=20000)


def main():
  with sync_playwright() as p:
    engine=os.environ.get('INTEGRITY_ENGINE','chromium')
    browser=(p.webkit.launch(headless=True) if engine=='webkit' else p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage']))
    ctx=browser.new_context(viewport={'width':1280,'height':900})
    configure(ctx)
    owner=ctx.new_page(); errors=[]; console=[]
    owner.on('pageerror',lambda e: errors.append(str(e)))
    owner.on('console',lambda e: console.append([e.type,e.text]) if e.type in ['error','warning'] else None)
    try:
      owner.goto(BASE,wait_until='domcontentloaded')
      owner.locator('.create-board-fields input').first.fill('Integrity native verification')
      owner.locator('.create-board-card .primary-button').click()
      owner.wait_for_url('**/board/**',timeout=15000)
      enter(owner,'Teacher')
      board_id=owner.url.split('/board/')[1].split('?')[0]
      record=owner.evaluate("async id => (await import('/alex/src/lib/browserAuthorityStore.js')).getAuthorityBoard(id)",board_id)
      assert record['integrityVersion']==1
      wait_idle(owner)
      student=ctx.new_page()
      student.on('pageerror',lambda e: errors.append(str(e)))
      student.on('console',lambda e: console.append([e.type,e.text]) if e.type in ['error','warning'] else None)
      student.goto(BASE+'board/'+board_id+'?key='+record['shareKey'],wait_until='domcontentloaded')
      enter(student,'Student');wait_idle(student)
      print('Native two-page Board startup ready',flush=True)
      canvas=owner.locator('canvas.upper-canvas'); box=canvas.bounding_box()
      owner.mouse.move(box['x']+160,box['y']+180);owner.mouse.down()
      owner.mouse.move(box['x']+240,box['y']+215,steps=8);owner.mouse.up()
      owner.wait_for_function("globalThis.__integrityTestSession.getRevision()>=1")
      student.wait_for_function("globalThis.__integrityTestSession.getRevision()>=1")
      wait_idle(owner);wait_idle(student)
      print('Native stroke and audit completed',flush=True)
      # Inject model drift, a missing/duplicate visible object and a ghost at the
      # SAME revision. A real negotiated owner hint starts the existing audit.
      target=student.evaluate("__integrityTestCanvas.getObjects().find(x=>x.boardObjectId).boardObjectId")
      student.evaluate("""async ({id,boardId}) => {
        const module=await import('/alex/src/lib/browserReplicaStore.js');
        const source=module.getReplicaIntegritySource(boardId);
        source.snapshot.canvas.objects.find(o=>o.boardObjectId===id).stroke='#ff0000';
        const canvas=__integrityTestCanvas;
        const object=canvas.getObjects().find(o=>o.boardObjectId===id);
        object.set({stroke:'#ff00ff',left:object.left+60});object.setCoords();
        const duplicate=await object.clone(['boardObjectId']); canvas.add(duplicate);
        const ghost=await object.clone(['boardObjectId']);ghost.boardObjectId='integrity-ghost';canvas.add(ghost);
        canvas.requestRenderAll();
      }""",{'id':target,'boardId':board_id})
      owner.evaluate("id => __integrityTestSession.getRuntime().broadcastIntegrityHint([id,'integrity-ghost'],__integrityTestSession.getRevision())",target)
      student.wait_for_function('''id => {
        const objects=__integrityTestCanvas.getObjects().filter(o=>o.boardObjectId);
        return objects.length===1 && objects[0].boardObjectId===id
          && !['#ff0000','#ff00ff'].includes(objects[0].stroke);
      }''',arg=target,timeout=20000)
      wait_idle(student)
      repaired=student.evaluate("""async boardId=>{
        const module=await import('/alex/src/lib/browserReplicaStore.js');
        const objects=__integrityTestCanvas.getObjects().filter(o=>o.boardObjectId);
        return {visible:objects.map(o=>({id:o.boardObjectId,stroke:o.stroke,left:o.left})),
          model:module.getReplicaIntegritySource(boardId).snapshot.canvas.objects,
          revision:__integrityTestSession.getRevision()};
      }""",board_id)
      assert len(repaired['visible'])==1,repaired
      assert repaired['visible'][0]['stroke']==repaired['model'][0]['stroke']
      assert abs(repaired['visible'][0]['left']-repaired['model'][0]['left'])<=0.002
      assert repaired['revision']==1,'an audit must not append history/commit'
      print('Same-revision model/Canvas/ghost repair passed',flush=True)
      # 100 separate trusted mouse strokes through actual React/Fabric handlers.
      for i in range(100):
        x=box['x']+80+(i%10)*28;y=box['y']+270+(i//10)*12
        owner.mouse.move(x,y);owner.mouse.down();owner.mouse.move(x+12,y+5,steps=2);owner.mouse.up()
      owner.wait_for_function('__integrityTestSession.getRevision()>=101',timeout=30000)
      student.wait_for_function('__integrityTestSession.getRevision()>=101',timeout=30000)
      wait_idle(owner);wait_idle(student)
      count=lambda page: page.evaluate('__integrityTestCanvas.getObjects().filter(o=>o.boardObjectId&&!o.transientPreview).length')
      assert count(owner)==101 and count(student)==101
      for name,expected in [(r'Отменить —',71),(r'Вернуть —',101)]:
        owner.get_by_role('button',name=re.compile(name)).evaluate('(b)=>{for(let i=0;i<30;i++)b.click()}')
        owner.wait_for_function('(n)=>__integrityTestCanvas.getObjects().filter(o=>o.boardObjectId&&!o.transientPreview).length===n',arg=expected,timeout=30000)
        student.wait_for_function('(n)=>__integrityTestCanvas.getObjects().filter(o=>o.boardObjectId&&!o.transientPreview).length===n',arg=expected,timeout=30000)
        wait_idle(owner);wait_idle(student)
      print('100 strokes and 30 rapid undo/redo passed',flush=True)
      (OUT/'repair.json').write_text(json.dumps(repaired,indent=2))
      facts=owner.evaluate("""() => ({version:__integrityTestSession.getRuntime().getIntegritySource().version,
        revision:__integrityTestSession.getRevision(), status:__integrityTestSession.getIntegrityStatus(),
        objects:__integrityTestCanvas.getObjects().map(x=>({id:x.boardObjectId,type:x.type,left:x.left,top:x.top}))})""")
      (OUT/'startup.json').write_text(json.dumps({'facts':facts,'errors':errors,'console':console},indent=2))
      owner.screenshot(path=str(OUT/'owner.png'))
      student.screenshot(path=str(OUT/'student.png'))
      assert not errors,errors
    except Exception:
      (OUT/'failure.json').write_text(json.dumps({'url':owner.url,'errors':errors,'console':console,'body':owner.locator('body').inner_text()[:5000], 'diagnostics':owner.evaluate('({status:globalThis.__integrityTestSession?.getIntegrityStatus?.(),revision:globalThis.__integrityTestSession?.getRevision?.(),objects:globalThis.__integrityTestCanvas?.getObjects?.().map(x=>({id:x.boardObjectId,type:x.type,left:x.left,top:x.top}))})')},indent=2))
      owner.screenshot(path=str(OUT/'failure.png'))
      if 'student' in locals():
        (OUT/'student-failure.json').write_text(json.dumps(student.evaluate('({status:globalThis.__integrityTestSession?.getIntegrityStatus?.(),revision:globalThis.__integrityTestSession?.getRevision?.(),objects:globalThis.__integrityTestCanvas?.getObjects?.().map(x=>({id:x.boardObjectId,type:x.type,left:x.left,top:x.top,stroke:x.stroke}))})'),indent=2))
        student.screenshot(path=str(OUT/'student-failure.png'))
      raise
    finally: browser.close()

if __name__=='__main__':main()
