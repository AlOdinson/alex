import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './LanguageProvider.jsx';
export default function PdfPageControls({ pageNumber, pageCount, canEdit, canNavigate = canEdit, busy, position, onPageChange }) {
  const { ui } = useLanguage();
  const [draft,setDraft]=useState(pageNumber);
  const draftRef=useRef(pageNumber),pageRef=useRef(pageNumber),pending=useRef(false);
  pageRef.current=pageNumber;
  useEffect(()=>{draftRef.current=pageNumber;setDraft(pageNumber);},[pageNumber,pageCount]);
  const commit=async()=>{
    const value=draftRef.current;
    if(!canNavigate||busy||pending.current||value===pageRef.current)return;
    pending.current=true;
    try{await onPageChange(value);}finally{pending.current=false;draftRef.current=pageRef.current;setDraft(pageRef.current);}
  };
  const cancel=()=>{draftRef.current=pageRef.current;setDraft(pageRef.current);};
  return <div className="pdf-page-controls" style={position} role="group" aria-label={ui('Страницы PDF')}
    onPointerDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}>
    <div className="pdf-page-buttons">
      <button type="button" title={ui('Предыдущая страница')} aria-label={ui('Предыдущая страница')}
        disabled={!canNavigate || busy || pageNumber <= 1} onClick={() => onPageChange(pageNumber - 1)}>‹</button>
      <span aria-live="polite">{draft} / {pageCount}</span>
      <button type="button" title={ui('Следующая страница')} aria-label={ui('Следующая страница')}
        disabled={!canNavigate || busy || pageNumber >= pageCount} onClick={() => onPageChange(pageNumber + 1)}>›</button>
    </div>
    {pageCount>1 && <input type="range" className="pdf-page-slider" min="1" max={pageCount} step="1" value={draft}
      aria-label={ui('Быстрый переход по страницам')} aria-valuetext={`${draft} / ${pageCount}`}
      disabled={!canNavigate || busy}
      onChange={event=>{draftRef.current=Number(event.target.value);setDraft(draftRef.current);}}
      onPointerUp={commit} onKeyUp={commit} onBlur={commit} onPointerCancel={cancel} />}
  </div>;
}
