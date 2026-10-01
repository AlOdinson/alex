import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from './LanguageProvider.jsx';

const stopPropagation = (event) => event.stopPropagation();

export default function NotebookPageControls({ pageNumber = 1, canEdit, busy = false, position, onPageChange, onEditText }) {
  const { ui } = useLanguage();
  const disabled = !canEdit || busy;
  return (
    <div className="notebook-page-controls" style={position} role="group" aria-label={ui('Страницы блокнота')}
      onPointerDown={stopPropagation} onPointerUp={stopPropagation} onPointerMove={stopPropagation}
      onTouchStart={stopPropagation} onTouchEnd={stopPropagation} onClick={stopPropagation}
      onDoubleClick={stopPropagation} onKeyDown={stopPropagation}>
      <div className="notebook-page-buttons">
        {pageNumber > 1 ? (
          <button type="button" title={ui('Предыдущая страница')} aria-label={ui('Предыдущая страница')}
            disabled={disabled} onClick={() => onPageChange(pageNumber - 1)}>‹</button>
        ) : <span className="notebook-page-arrow-space" aria-hidden="true" />}
        <span className="notebook-page-number" aria-live="polite" aria-atomic="true">{pageNumber}</span>
        <button type="button" title={ui('Следующая страница')} aria-label={ui('Следующая страница')}
          disabled={disabled} onClick={() => onPageChange(pageNumber + 1)}>›</button>
      </div>
      {onEditText && <button type="button" className="notebook-edit-text" disabled={disabled} onClick={onEditText}>{ui('Редактировать текст')}</button>}
    </div>
  );
}

export function NotebookTextEditor({ value = '', onSave, onCancel, busy = false }) {
  const { ui } = useLanguage();
  const [text, setText] = useState(value ?? '');
  const titleId = useId();
  const textareaRef = useRef(null);
  const dialogRef = useRef(null);
  useEffect(() => { setText(value ?? ''); }, [value]);
  useEffect(() => {
    const previousFocus = document.activeElement;
    textareaRef.current?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus?.(); };
  }, []);
  function handleKeyDown(event) {
    event.stopPropagation();
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
    }
    if (event.key === 'Tab') {
      const elements = [...dialogRef.current.querySelectorAll('textarea:not(:disabled), button:not(:disabled)')];
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  return createPortal(
    <div className="notebook-text-editor-backdrop" onPointerDown={stopPropagation} onPointerUp={stopPropagation}
      onTouchStart={stopPropagation} onTouchEnd={stopPropagation} onClick={stopPropagation} onKeyDown={handleKeyDown}>
      <form ref={dialogRef} className="notebook-text-editor" role="dialog" aria-modal="true" aria-labelledby={titleId}
        aria-busy={busy} onSubmit={(event) => { event.preventDefault(); if (!busy) onSave(text); }}>
        <h2 id={titleId}>{ui('Редактировать текст')}</h2>
        <textarea ref={textareaRef} autoFocus aria-label={ui('Текст')} value={text} disabled={busy}
          onChange={(event) => setText(event.target.value)} rows={10} />
        <div className="notebook-text-editor-actions">
          <button type="button" disabled={busy} onClick={onCancel}>{ui('Отмена')}</button>
          <button type="submit" disabled={busy}>{ui('Сохранить')}</button>
        </div>
      </form>
    </div>, document.body,
  );
}
