from pathlib import Path
p=Path('target/scripts/test-notebook-drop-browser.mjs')
s=p.read_text()
old=" window.notebook=()=>window.testCanvas.getObjects().find(o=>o.type==='boardnotebook');"
assert old in s
s=s.replace(old,""" window.nativeHistoryEvents=[];
 window.nativeHistoryState=()=>{
  let root=document.querySelector('.toolbar-shell');root=root[Object.keys(root).find(k=>k.startsWith('__reactFiber'))];while(root&&root.type?.name!=='BoardWorkspace')root=root.return;
  const values=[];for(let h=root?.memoizedState;h;h=h.next){const v=h.memoizedState?.current;
   if(Array.isArray(v)&&v.some(a=>a?.nextHistoryOps||a?.type==='transform'))values.push({kind:'stack',entries:v});
   if(v?.availability&&v?.pendingCount)values.push({kind:'historyQueue',pending:v.pendingCount(),availability:v.availability()});
   if(v?.getConfirmedState&&v?.exportPending)values.push({kind:'notebookModel',confirmed:v.getConfirmedState(),pending:v.exportPending()});
  }return values;
 };
 for(let h=f?.memoizedState;h;h=h.next){const v=h.memoizedState?.current;if(v?.apply&&v?.prepare){
  const apply=v.apply;v.apply=async(...args)=>{window.nativeHistoryEvents.push({stage:'apply',direction:args[1],action:structuredClone(args[0])});const result=await apply(...args);window.nativeHistoryEvents.push({stage:'result',direction:args[1],result:structuredClone(result)});return result;};
 }}
 document.addEventListener('click',event=>{const button=event.target.closest?.('button');if(button?.title.includes('Command'))window.nativeHistoryEvents.push({stage:'click',title:button.title,disabled:button.disabled,trusted:event.isTrusted});},true);
 window.notebook=()=>window.testCanvas.getObjects().find(o=>o.type==='boardnotebook');""",1)
old='({body:document.body?.innerText,objects:'
assert old in s
s=s.replace(old,'({history:window.nativeHistoryState?.(),historyEvents:window.nativeHistoryEvents,body:document.body?.innerText,objects:',1)
p.write_text(s)
print('Added diagnostic observers to test fixture only; runtime unchanged')
