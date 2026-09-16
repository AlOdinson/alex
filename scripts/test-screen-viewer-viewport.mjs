import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as screen from '../src/lib/screenShare.js';

for (const [width, height] of [[1280,800], [390,844], [820,1180]]) {
  test(`remote screen is visible at ${width}x${height} even when the host has panned far away`, () => {
    assert.equal(typeof screen.screenShareViewportForLayout, 'function');
    const layout = {left: 10000, top: -8000, width: 720, height: 405};
    const next = screen.screenShareViewportForLayout(layout, [1,0,0,1,0,0], width, height);
    assert.ok(next);
    const [z,,,zy,tx,ty] = next;
    assert.equal(z, zy);
    assert.ok(layout.left*z+tx >= 15);
    assert.ok(layout.top*z+ty >= 15);
    assert.ok((layout.left+layout.width)*z+tx <= width-15);
    assert.ok((layout.top+layout.height)*zy+ty <= height-15);
  });
}
test('already visible screen does not move the viewer camera', () => {
  assert.equal(typeof screen.screenShareViewportForLayout, 'function');
  assert.equal(screen.screenShareViewportForLayout({left:100,top:100,width:200,height:120}, [1,0,0,1,0,0], 1280,800), null);
});
test('malformed or not-yet-measured viewports do not produce a camera jump', () => {
  assert.equal(typeof screen.screenShareViewportForLayout, 'function');
  assert.equal(screen.screenShareViewportForLayout(null,[1,0,0,1,0,0],1280,800),null);
  assert.equal(screen.screenShareViewportForLayout({left:1,top:1,width:100,height:100},[1,0,0,1,0,0],0,0),null);
});
test('a viewer is brought to a new screen once; later panning and snapshots cannot pull them back', () => {
  const source = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
  const body = source.split('  const reconcileBoardScreenShare = useCallback(() => {')[1].split('\n  }, []);')[0];
  let viewport = [1,0,0,1,0,0], moves = 0;
  const objects = [], layout = {left:10000,top:8000,width:640,height:360};
  const canvas = { getObjects: () => objects, getWidth: () => 390, getHeight: () => 844,
    get viewportTransform() { return viewport; }, setViewportTransform: (v) => { viewport=v; moves++; },
    add: (o) => { objects.push(o); o.canvas=canvas; }, requestRenderAll() {} };
  const object = {screenShareSessionId:'share-1'}, controller = {object,setInteractive(){},setStream(){},setLayout(){},dispose(){}};
  const state = {sessionId:'share-1',sourceMode:'screen',role:'viewer',boardLayout:layout};
  const deps = {fabricCanvasRef:{current:canvas},screenShareRef:{current:state},canEditRef:{current:true},
    boardReadyRef:{current:true},boardScreenShareRef:{current:controller},screenShareViewportSessionRef:{current:''},
    screenShareViewportForLayout:screen.screenShareViewportForLayout,screenShareLayoutFromFabricObject:()=>layout,
    createBoardScreenShareMedia:()=>controller,setZoom(){},updateBackgroundTransform(){} };
  const run = new Function(...Object.keys(deps),body);
  run(...Object.values(deps)); assert.equal(moves,1);
  viewport=[1,0,0,1,123,456]; run(...Object.values(deps));
  assert.equal(moves,1); assert.deepEqual(viewport,[1,0,0,1,123,456]);
  objects.length=0; delete object.canvas; run(...Object.values(deps));
  assert.deepEqual(objects,[object]); assert.equal(moves,1);
});
