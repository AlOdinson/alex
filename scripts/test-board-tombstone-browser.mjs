import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engineName = process.env.VERIFICATION_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const engine = engineName === 'webkit' ? webkit : chromium;
const port = 5218, base = `http://127.0.0.1:${port}/alex/`, output = process.env.NOTEBOOK_TOMBSTONE_OUTPUT || 'notebook-tombstone-results';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
let browser;
try {
  await mkdir(output, { recursive: true });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Vite did not start');
  browser = await engine.launch({ headless: true, ...(engineName === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + 'scripts/board-media-fixture.html');
  const preparation = await page.evaluate(async () => {
    const store = await import('/alex/src/lib/browserAuthorityStore.js');
    const req = r => new Promise((yes, no) => { r.onsuccess = () => yes(r.result); r.onerror = () => no(r.error); });
    const done = tx => new Promise((yes, no) => { tx.oncomplete = yes; tx.onabort = tx.onerror = () => no(tx.error); });
    const opening = indexedDB.open('alex-board-authority', 3);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      db.createObjectStore('boards', { keyPath: 'boardId' });
      db.createObjectStore('snapshots', { keyPath: 'boardId' });
      const commits = db.createObjectStore('commits', { keyPath: 'actionKey' });
      commits.createIndex('boardRevision', ['boardId', 'revision'], { unique: true }); commits.createIndex('boardId', 'boardId');
      db.createObjectStore('assets', { keyPath: 'assetKey' }).createIndex('boardId', 'boardId');
      db.createObjectStore('notebookTombstones', { keyPath: ['boardId', 'childKey'] }).createIndex('boardId', 'boardId');
      const outbox = db.createObjectStore('notebookOutbox', { keyPath: 'sequence', autoIncrement: true });
      outbox.createIndex('pendingAction', ['boardId', 'clientId', 'actionId'], { unique: true });
      outbox.createIndex('boardClient', ['boardId', 'clientId']); outbox.createIndex('boardId', 'boardId');
    };
    const db = await req(opening), tx = db.transaction(['boards','snapshots','notebookOutbox'], 'readwrite'), saved = done(tx);
    const tombstones = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`old-${i}`, { clientId: 'writer', actionId: `deleted-${i}`, mutationId: `m-${i}`, revision: i }]));
    const snapshot = { version: 2, background: 'blank', canvas: { objects: [{ type: 'Path', boardObjectId: 'line', path: [['M',1,2], ['L',3,4]] }] } };
    tx.objectStore('boards').add({ boardId: 'legacy', revision: 0, snapshotRevision: 0, title: 'Saved lesson', tombstones });
    tx.objectStore('snapshots').add({ boardId: 'legacy', snapshot });
    tx.objectStore('notebookOutbox').add({ boardId: 'legacy', clientId: 'writer', actionId: 'pending', action: { ops: [] } });
    await saved; db.close();
    const controller = new AbortController(); let aborted = false;
    try { await store.migrateAuthorityBoardTombstones('legacy', { signal: controller.signal, onProgress: () => controller.abort() }); }
    catch (error) { aborted = error.name === 'AbortError'; }
    const unchanged = await store.getAuthorityBoard('legacy');
    return { aborted, oldCount: Object.keys(unchanged.tombstones).length,
      originalPresent: Object.hasOwn(await store.getAuthorityBoardMetadata('legacy'), 'tombstones'), snapshot: unchanged.snapshot };
  });
  assert.equal(preparation.aborted, true); assert.equal(preparation.oldCount, 10000); assert.equal(preparation.originalPresent, true);
  // A real navigation releases all JS state and database handles; retry must use
  // durable migration progress, not the previous in-memory source table.
  await page.reload();
  const report = await page.evaluate(async () => {
    const store = await import('/alex/src/lib/browserAuthorityStore.js');
    const req = r => new Promise((yes, no) => { r.onsuccess = () => yes(r.result); r.onerror = () => no(r.error); });
    const migrations = await Promise.all([store.migrateAuthorityBoardTombstones('legacy'), store.migrateAuthorityBoardTombstones('legacy', { batchSize: 51 })]);
    const calls = [], put = IDBObjectStore.prototype.put, get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.put = function(value, ...args) { calls.push({ kind:'put', store:this.name, oldTable:Object.hasOwn(value,'tombstones'), bytes:JSON.stringify(value).length }); return put.call(this,value,...args); };
    IDBObjectStore.prototype.get = function(key) { calls.push({ kind:'get', store:this.name }); return get.call(this,key); };
    try { await store.persistAuthorityCommit('legacy', { actionId:'after-migration', clientId:'writer', revision:1, ops:[{type:'delete',id:'new-source'}] }); }
    finally { IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.get = get; }
    const loaded = await store.getAuthorityBoard('legacy'), meta = await store.getAuthorityBoardMetadata('legacy');
    const db = await req(indexedDB.open('alex-board-authority'));
    const outbox = await req(db.transaction('notebookOutbox').objectStore('notebookOutbox').getAll());
    const backup = await req(db.transaction('boardTombstoneBackups').objectStore('boardTombstoneBackups').get('legacy'));
    db.close();
    let legacyRejected = false;
    try { const old = await req(indexedDB.open('alex-board-authority',3)); old.close(); } catch(error) { legacyRejected = error.name === 'VersionError'; }
    const { openBrowserBoardAuthority } = await import('/alex/src/lib/browserBoardAuthority.js');
    const authority = await openBrowserBoardAuthority({boardId:'legacy',enableNotebookOperations:true});
    const restored = await authority.commitAction({actionId:'restore-new-source',clientId:'writer',baseRevision:1,ops:[{
      type:'upsert',object:{type:'Path',boardObjectId:'new-source',path:[['M',0,0],['L',2,4]]},
      ifDeletedBy:'writer',ifDeletedMutationId:'after-migration',restore:true,
    }]});
    const undone = await authority.commitAction({actionId:'undo-restore',clientId:'writer',baseRevision:2,ops:restored.historyInverseOps});
    const reopened = await openBrowserBoardAuthority({boardId:'legacy',enableNotebookOperations:true});
    const history = {restored:restored.changed,undone:undone.changed,revision:reopened.getRevision(),
      objects:reopened.getSnapshot().canvas.objects.length,cloneableTombstones:structuredClone(reopened.getTombstones())['new-source']};
    return { migrations, calls, history, count:Object.keys(loaded.tombstones).length, oldLast:loaded.tombstones['old-9999'], newDeletion:loaded.tombstones['new-source'],
      metadataHasTable:Object.hasOwn(meta,'tombstones'), revision:loaded.revision, snapshot:loaded.snapshot,
      pending:outbox.length, backupCount:Object.keys(backup.tombstones).length, legacyRejected };
  });
  assert.equal(report.count,10001); assert.equal(report.revision,1); assert.equal(report.pending,1); assert.equal(report.backupCount,10000);
  assert.equal(report.oldLast.mutationId,'m-9999'); assert.equal(report.newDeletion.actionId,'after-migration');
  assert.deepEqual(report.snapshot,preparation.snapshot); assert.equal(report.legacyRejected,true); assert.equal(report.metadataHasTable,false);
  assert.equal(report.calls.filter(c=>c.store==='boardTombstones'&&c.kind==='put').length,1);
  assert.equal(report.calls.some(c=>c.oldTable || ['snapshots','boardTombstoneBackups'].includes(c.store)),false);
  assert.equal(report.history.restored,true); assert.equal(report.history.undone,true);
  assert.equal(report.history.revision,3); assert.equal(report.history.objects,1);
  assert.equal(report.history.cloneableTombstones.actionId,'undo-restore');
  assert.deepEqual(errors,[]);
  await writeFile(`${output}/${engineName}.json`, JSON.stringify({ engine:engineName, commit:process.env.GITHUB_SHA, preparation, report, errors,
    scope:'Real IndexedDB v3->v4 interrupted/reloaded/concurrent migration, one-row commit and preserved outbox/backup; no physical-device or latency claim' },null,2));
  console.log(`${engineName}: interrupted migration, durable resume, parallel callers and addressed commit passed`);
} finally { await browser?.close(); server.kill(); }
