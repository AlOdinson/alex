import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

test('production build emits a standalone notebook split worker instead of a data URL with relative imports', async()=>{
  const assets=await readdir(new URL('../dist/assets/',import.meta.url));
  const worker=assets.find(name=>/^notebookSplitWorker-.*\.js$/.test(name));
  assert.ok(worker,'Vite did not emit notebookSplitWorker as a standalone worker chunk');
  const fragments=assets.find(name=>/^notebookSplitFragments-.*\.js$/.test(name));
  const source=await readFile(new URL(`../dist/assets/${fragments}`,import.meta.url),'utf8');
  assert.equal(source.includes('data:text/javascript;base64'),false,'split worker was embedded as a data URL');
});
