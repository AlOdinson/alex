import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorityBoard, deleteAuthorityBoard, listAuthorityBoards, getAuthorityBoard } from '../src/lib/browserAuthorityStore.js';
import { boardMediaAssets } from '../src/lib/mediaAssetStore.js';

test('board deletion releases media and list recovery finishes interrupted cleanup', async () => {
  await createAuthorityBoard({boardId:'delete-media-a'});
  await createAuthorityBoard({boardId:'delete-media-b'});
  const asset=await boardMediaAssets.importFile('delete-media-a',Object.assign(new Blob(['%PDF-1.7\ncleanup']),{name:'a.pdf'}));
  await boardMediaAssets.register('delete-media-b',asset.assetId);
  await deleteAuthorityBoard('delete-media-a');
  assert.equal(await boardMediaAssets.get('delete-media-a',asset.assetId),null);
  assert.ok(await boardMediaAssets.get('delete-media-b',asset.assetId));
  const original=boardMediaAssets.deleteBoard;
  boardMediaAssets.deleteBoard=async()=>{throw new Error('simulated storage interruption');};
  try { assert.equal(await deleteAuthorityBoard('delete-media-b'),true); }
  finally { boardMediaAssets.deleteBoard=original; }
  assert.equal(await getAuthorityBoard('delete-media-b'),null);
  assert.ok(await boardMediaAssets.get('delete-media-b',asset.assetId));
  await listAuthorityBoards();
  for(let attempt=0;attempt<50 && await boardMediaAssets.get('delete-media-b',asset.assetId);attempt++) {
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  assert.equal(await boardMediaAssets.get('delete-media-b',asset.assetId),null);
  await assert.rejects(boardMediaAssets.register('another-board',asset.assetId),/сохран/);
});

test('a stalled media cleanup cannot block opening the board library', async()=>{
  await createAuthorityBoard({boardId:'stalled-cleanup'});
  const original=boardMediaAssets.deleteBoard;
  boardMediaAssets.deleteBoard=async()=>{throw new Error('leave pending cleanup');};
  await deleteAuthorityBoard('stalled-cleanup');
  let release;
  const stalled=new Promise(resolve=>{release=resolve;});
  boardMediaAssets.deleteBoard=()=>stalled;
  try {
    const boards=await Promise.race([listAuthorityBoards(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('library blocked by cleanup')),100))]);
    assert.ok(Array.isArray(boards));
  }finally{boardMediaAssets.deleteBoard=original;release();}
});
