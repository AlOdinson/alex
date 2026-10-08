import test from 'node:test';
import assert from 'node:assert/strict';
import { createStylusMenuTapController } from '../src/lib/stylusMenuTaps.js';

function make() {
 const records=[];let time=1000;
 const machine=createStylusMenuTapController({
  activate:e=>records.push(e?.inputType || 'click'),now:()=>time,
 });
 const evt=(props={})=>({
  pointerType:'pen',pointerId:1,
  stopPropagation(){},preventDefault(){this.defaultPrevented=true},...props,
 });
 const touch=(id,kind='stylus')=>evt({changedTouches:[{identifier:id,touchType:kind}]});
 return {records,machine,evt,touch,advance:ms=>{time+=ms;}};
}

test('160 immediate consecutive pencil pointers never encounter a per-button cooldown',()=>{
 const f=make();
 for(let n=0;n<160;n++){
  f.machine.onPointerDown(f.evt({pointerId:7}));
  f.machine.onPointerUp(f.evt({pointerId:7}));
  assert.equal(f.records.length,n+1);
  f.advance(2);
 }
});
test('paired pen PointerEvent/TouchEvent activates once, compatibility click is swallowed',()=>{
 const f=make();
 f.machine.onPointerDown(f.evt({pointerId:6}));
 f.machine.onTouchStart(f.touch(9));
 f.machine.onPointerUp(f.evt({pointerId:6}));
 f.machine.onTouchEnd(f.touch(9));
 assert.deepEqual(f.records,['stylus-pointerup']);
 const ghost=f.evt({detail:1});
 assert.equal(f.machine.onClick(ghost),false);
 assert.equal(ghost.defaultPrevented,true);
});
test('pointerup activates when WebKit skips stylus touchend, with no gap before next tap',()=>{
 const f=make();
 f.machine.onTouchStart(f.touch(4));
 f.machine.onPointerDown(f.evt({pointerId:1}));
 f.machine.onPointerUp(f.evt({pointerId:1}));
 f.advance(1);
 f.machine.onPointerDown(f.evt({pointerId:1}));
 f.machine.onPointerUp(f.evt({pointerId:1}));
 assert.equal(f.records.length,2);
});
test('touchend activates when WebKit lacks pointerup and reuses touch identifier',()=>{
 const f=make();
 for(let i=0;i<20;i++){
  f.machine.onTouchStart(f.touch(0));f.machine.onTouchEnd(f.touch(0));
  f.advance(2);
 }
 assert.equal(f.records.length,20);
});
test('Safari detail=2 click can recover second tap with no touch or pointer events',()=>{
 const f=make();
 f.machine.onTouchStart(f.touch(3));
 f.machine.onTouchEnd(f.touch(3));
 assert.equal(f.machine.onClick(f.evt({detail:1})),false);
 f.advance(10);
 assert.equal(f.machine.onClick(f.evt({detail:2})),true);
 assert.deepEqual(f.records,['stylus-touchend','click']);
});
test('finger and mouse presses are not swallowed by an earlier stylus',()=>{
 const f=make();
 f.machine.onTouchStart(f.touch(3));
 f.machine.onTouchEnd(f.touch(3));
 f.advance(1);
 f.machine.onPointerDown(f.evt({pointerType:'touch',pointerId:9}));
 assert.equal(f.machine.onClick(f.evt({detail:1})),true);
 assert.deepEqual(f.records,['stylus-touchend','click']);
});
test('rapid distinct stylus taps consume only their own compatibility clicks',()=>{
 const f=make();
 for(let i=0;i<4;i++){
  f.machine.onPointerDown(f.evt({pointerId:i+1}));
  f.machine.onTouchStart(f.touch(i+1));
  f.machine.onPointerUp(f.evt({pointerId:i+1}));
  f.machine.onTouchEnd(f.touch(i+1));
  f.advance(1);
 }
 for(let i=0;i<4;i++)assert.equal(f.machine.onClick(f.evt({detail:1})),false);
 assert.equal(f.records.length,4);
});
test('cancel and disabled block a pending pen press',()=>{
 const records=[];let disabled=true;
 const controller=createStylusMenuTapController({activate:v=>records.push(v),isDisabled:()=>disabled});
 const e={pointerType:'pen',pointerId:2};
 controller.onPointerDown(e);controller.onPointerUp(e);
 assert.deepEqual(records,[]);
 disabled=false;
 controller.onPointerDown(e);controller.onCancel(e);controller.onPointerUp(e);
 assert.deepEqual(records,[]);
});
