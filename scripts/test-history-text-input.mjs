import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const board=fs.readFileSync(new URL('../src/components/Board.jsx',import.meta.url),'utf8');
const start=board.indexOf('    function handleKeyDown(event) {');
const end=board.indexOf('\n    function handleKeyUp',start);
assert.ok(start>0 && end>start);
function run({marked=false,editing=true,permission=true}={}) {
  class IText {isEditing=editing;}
  const called=[];
  const scope={IText,HTMLInputElement:class{},HTMLTextAreaElement:class{},HTMLSelectElement:class{},
    canvas:{getActiveObject:()=>new IText()},isOwner:false,canEditRef:{current:permission},undo:()=>called.push('undo'),redo:()=>called.push('redo')};
  const handle=new Function('scope',`with(scope){${board.slice(start,end)};return handleKeyDown;}`)(scope);
  handle({key:'z',code:'KeyZ',ctrlKey:true,alexBoardHistoryCommand:marked,preventDefault(){}});
  return called;
}
test('visible undo button commits active text editing before board undo instead of ignoring the tap',()=>{
  assert.deepEqual(run({marked:true}),['undo']);
});
test('physical Ctrl/Cmd+Z remains native inside a text editor',()=>{
  assert.deepEqual(run(),[]);
});
test('a history button cannot bypass read-only permission',()=>{
  assert.deepEqual(run({marked:true,permission:false}),[]);
});
