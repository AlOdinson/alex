import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const start = source.indexOf('    function handleTouchMove(event) {');
const end = source.indexOf('    function handleTouchEnd(event)', start);
const handler = source.slice(start, end);
for (const [label, distance, midpoint] of [['zoom in', 200, {x:240,y:160}], ['zoom out',50,{x:120,y:80}], ['pan',100,{x:320,y:220}]]) {
  test(`gesture cursor follows midpoint after ${label}`, () => {
    let viewport = [1,0,0,1,20,30];
    const sent=[];
    const context = {
      consumeEyedropperStylusTouch:()=>false, moveStylusTouchFallback:()=>false,
      shouldSuppressTouchEvent:()=>false, unsuppressedFingerTouches:t=>t,
      moveMobileGameLibraryTouchStage:()=>false, rejectTouchEvent:()=>{},
      touchGestureRef:{current:{active:true,startZoom:1,startDistance:100,scenePoint:{x:100,y:60}}},
      touchMetrics:()=>({distance,midpoint}),touchTarget:{},
      clamp:(v,min,max)=>Math.max(min,Math.min(max,v)),MIN_ZOOM:.1,MAX_ZOOM:10,
      canvas:{setViewportTransform:v=>{viewport=v;},requestRenderAll:()=>{}},
      util:{invertTransform:([a,b,c,d,e,f])=>[1/a,0,0,1/d,-e/a,-f/d],transformPoint:(p,v)=>({x:p.x*v[0]+v[4],y:p.y*v[3]+v[5]})},
      lastPointerSceneRef:{current:null}, sendCursorThrottled:p=>sent.push(p),
      setZoom:()=>{}, updateBackgroundTransform:()=>{},sendTeacherViewThrottled:()=>{},
    };
    vm.runInNewContext(`${handler}; handleTouchMove({touches:[{},{}]});`,context);
    assert.equal(sent.length,1);
    assert.equal(sent[0].x*viewport[0]+viewport[4],midpoint.x);
    assert.equal(sent[0].y*viewport[3]+viewport[5],midpoint.y);
    assert.equal(context.lastPointerSceneRef.current,sent[0]);
  });
}
