export const notebookSplitCancelled = () => Object.assign(
  new Error('Страница блокнота или доска изменилась — разрезание отменено'),
  {name:'AbortError',code:'notebook_work_cancelled'},
);
export function checkNotebookSplit({signal,isCurrent}={}) {
  if(signal?.aborted || (isCurrent && !isCurrent()))throw notebookSplitCancelled();
}
export function createNotebookSplitScope(signals=[],isCurrent) {
  const controller=new AbortController(),listeners=[];
  for(const signal of signals.filter(Boolean)){
    const abort=()=>controller.abort();
    if(signal.aborted)abort();
    else {signal.addEventListener('abort',abort,{once:true});listeners.push(()=>signal.removeEventListener('abort',abort));}
  }
  return {signal:controller.signal,isCurrent,dispose(){listeners.forEach(remove=>remove());}};
}
