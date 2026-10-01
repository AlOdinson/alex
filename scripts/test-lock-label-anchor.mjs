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
test('other objects retain their existing editing label position',()=>{
  const object=new Rect({width:20,height:30,left:10,top:20});object.setCoords();
  const bounds=object.getBoundingRect();assert.equal(lockLabelAnchor([object]).y,bounds.top+bounds.height/2);
});
