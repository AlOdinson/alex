import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rect, Group, Point, util } from 'fabric/node';
import { lockLabelAnchor } from '../src/lib/lockLabelAnchor.js';

test('PDF editing label follows the top of rotated/scaled pages and PDF groups at any viewport zoom', () => {
  const pdf=new Rect({width:200,height:300,left:100,top:80,angle:35,scaleX:2,scaleY:1.5});
  pdf.mediaKind='pdf';pdf.setCoords();
  for(const object of [pdf,new Group([pdf],{left:50,top:70,angle:20})]) {
    object.setCoords();const anchor=lockLabelAnchor([object]);const bounds=object.getBoundingRect();
    assert.equal(anchor.y,bounds.top);assert.equal(anchor.x,bounds.left+bounds.width/2);
    const zoom=[2,0,0,2,50,-70];const screen=util.transformPoint(new Point(anchor.x,anchor.y),zoom);
    assert.equal(screen.y,bounds.top*2-70);
  }
});
test('all drawings and pictures show the editing label above the selection instead of its center',()=>{
  for(const kind of ['pencil','shape','image','notebook']) {
    const o=new Rect({width:100,height:60,left:35,top:42,angle:19});
    o.objectKind=kind;
    o.setCoords();
    const bounds=o.getBoundingRect();
    assert.equal(lockLabelAnchor([o]).y,bounds.top, kind);
    assert.equal(lockLabelAnchor([o]).x,bounds.left+bounds.width/2,kind);
  }
});
test('multi-object editing labels sit above the full visible group',()=>{
  const a=new Rect({width:100,height:90,left:80,top:40,angle:45});
  const b=new Rect({width:60,height:70,left:200,top:170,angle:-25});
  a.setCoords();b.setCoords();
  const y=Math.min(a.getBoundingRect().top,b.getBoundingRect().top);
  const anchor=lockLabelAnchor([a,b]);
  assert.equal(anchor.y,y);
  assert.equal(lockLabelAnchor([]),null);
});
