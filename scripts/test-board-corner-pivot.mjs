import assert from 'node:assert/strict';
import test from 'node:test';
import { ActiveSelection, Canvas, Rect, Path } from 'fabric/node';
import {
  PIVOT_CORNERS,
  captureCornerPivotGesture,
  cornerPivotAt,
  dragCornerAroundOpposite,
} from '../src/lib/boardCornerPivot.js';

const close=(a,b,eps=1e-5)=>assert.ok(Math.abs(a-b)<eps, String(a)+' should equal '+String(b));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
function rotate(v,degrees) {
 const angle=degrees*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
 return {x:v.x*c-v.y*s,y:v.x*s+v.y*c};
}
function point(o,x,y) { const p=o.getPositionByOrigin(x,y);return {x:p.x,y:p.y}; }

for(const corner of Object.keys(PIVOT_CORNERS)) {
  for(const kind of ['rectangle','path','group']) {
    test(kind+' '+corner+': pivot fixed and dragged corner follows pointer',async()=>{
      const canvas=new Canvas(null,{width:1400,height:1100,enableRetinaScaling:false});
      let o;
      if(kind==='rectangle'){
        o=new Rect({left:260,top:160,width:170,height:110,originX:'center',originY:'center',
          scaleX:1.3,scaleY:0.8,angle:26,fill:'#2563eb'});
        canvas.add(o);
      } else if(kind==='path'){
        o=new Path('M 0 0 L 140 15 L 70 120',{left:260,top:160,stroke:'#111827',fill:null,
          scaleX:1.3,scaleY:0.8,angle:26});
        canvas.add(o);
      } else {
        const a=new Rect({left:180,top:170,width:110,height:85,fill:'#2563eb'});
        const b=new Rect({left:380,top:300,width:70,height:115,fill:'#0891b2'});
        canvas.add(a,b);
        o=new ActiveSelection([a,b],{canvas,scaleX:1.2,scaleY:0.9,angle:26});
        canvas.setActiveObject(o);
      }
      const c=PIVOT_CORNERS[corner],anchor=point(o,c.pivotX,c.pivotY),start=point(o,c.dragX,c.dragY);
      const transform={corner,target:o,ex:start.x,ey:start.y};
      const vector={x:start.x-anchor.x,y:start.y-anchor.y};
      const initialAngle=o.angle,initialScaleX=o.scaleX,initialScaleY=o.scaleY;
      const gesture=captureCornerPivotGesture(transform);
      assert.ok(gesture);
      for(const [degrees,factor] of [[12,1.15],[31,1.4],[-27,0.73],[61,1.7]]) {
        const rotated=rotate(vector,degrees);
        const desired={x:anchor.x+rotated.x*factor,y:anchor.y+rotated.y*factor};
        assert.equal(dragCornerAroundOpposite({},transform,desired.x,desired.y),true);
        const fixed=point(o,c.pivotX,c.pivotY),dragged=point(o,c.dragX,c.dragY);
        assert.ok(distance(fixed,anchor)<1e-4,'opposite pivot moved');
        assert.ok(distance(dragged,desired)<1e-4,'dragged corner lost pointer');
        close(o.scaleX,initialScaleX*factor);
        close(o.scaleY,initialScaleY*factor);
        close(o.angle,initialAngle+degrees);
      }
      await canvas.dispose();
    });
  }
}

test('a corner grab preserves the initial pointer offset and causes no first-frame jump',async()=>{
 const canvas=new Canvas(null,{width:500,height:400,enableRetinaScaling:false});
 const o=new Rect({left:100,top:80,width:140,height:90,angle:18});
 canvas.add(o);
 const anchor=point(o,'left','bottom'),dragged=point(o,'right','top');
 const transform={corner:'tr',target:o,ex:dragged.x+7,ey:dragged.y-5};
 const state=captureCornerPivotGesture(transform);
 const current=cornerPivotAt(state,transform.ex,transform.ey);
 close(current.angle,o.angle);
 close(current.scaleX,o.scaleX);
 assert.equal(dragCornerAroundOpposite({},transform,transform.ex,transform.ey),false);
 assert.equal(dragCornerAroundOpposite({},transform,transform.ex+23,transform.ey-12),true);
 assert.ok(distance(point(o,'left','bottom'),anchor)<1e-5);
 assert.ok(distance(point(o,'right','top'),{x:dragged.x+23,y:dragged.y-12})<1e-5);
 await canvas.dispose();
});

test('collaboration lease locks all corner changes until they are released',async()=>{
 const canvas=new Canvas(null,{width:600,height:500,enableRetinaScaling:false});
 const o=new Rect({left:100,top:80,width:140,height:90});
 canvas.add(o);
 const drag=point(o,'right','bottom'),transform={corner:'br',target:o,ex:drag.x,ey:drag.y};
 o.lockRotation=true;
 assert.equal(dragCornerAroundOpposite({},transform,drag.x+50,drag.y+30),false);
 assert.equal(o.angle,0);
 o.lockRotation=false;
 assert.equal(dragCornerAroundOpposite({},transform,drag.x+50,drag.y+30),true);
 assert.notEqual(o.angle,0);
 await canvas.dispose();
});
