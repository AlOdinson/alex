import assert from 'node:assert/strict';
import test from 'node:test';
import { historyDockPlacement } from '../src/lib/historyDockLayout.js';

const overlap = (a,b) => a.left < b.left+b.width && a.left+a.width > b.left && a.top < b.top+b.height && a.top+a.height > b.top;
for (const width of [320, 390, 430, 768, 820]) {
  for (const mode of ['1','2']) {
    test(`history buttons do not cover ${width}px dock or contextual controls, mode ${mode}`, () => {
      const dock = {left:6, top:mode==='1'?744:64, width:width-12, height:64};
      const context = {left:10,top:mode==='1'?700:135,width:150,height:36};
      const placed=historyDockPlacement({dock,mode,viewport:{width,height:844},context:[context]});
      assert.ok(placed);
      assert.ok(!overlap(placed,dock));
      assert.ok(!overlap(placed,context));
      assert.ok(placed.left>=6 && placed.left+placed.width<=width-6);
      assert.ok(placed.top>=6 && placed.top+placed.height<=838);
    });
  }
}
test('desktop keeps its approved side-by-side placement', () => {
  assert.equal(historyDockPlacement({dock:{left:300,top:700,width:480,height:64},mode:'1',viewport:{width:1280,height:800}}),null);
});
test('vertical layout keeps its existing above-dock history placement', () => {
  assert.equal(historyDockPlacement({dock:{left:12,top:200,width:64,height:400},mode:'3',viewport:{width:390,height:844}}),null);
});
