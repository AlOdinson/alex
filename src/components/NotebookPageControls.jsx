import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createNotebookNavigationTap, installNotebookNavigationInput } from '../lib/notebookNavigation.js';
import { useLanguage } from './LanguageProvider.jsx';

const stopPropagation = (event) => event.stopPropagation();

function NotebookArrow({ label, disabled, direction, onActivate, inputRef }) {
  const latest = useRef(null);
  latest.current = { disabled, onActivate };
  const tap = useMemo(() => createNotebookNavigationTap({
    canActivate: () => !latest.current.disabled && (inputRef.current?.allowsActivation() ?? false),
    activate: () => latest.current.onActivate(),
  }), [inputRef]);
  return <button type="button" title={label} aria-label={label} disabled={disabled}
    onPointerDown={tap.down} onPointerMove={tap.move} onPointerUp={tap.up}
    onPointerCancel={tap.cancel} onLostPointerCapture={tap.cancel} onClick={tap.click}>
    {direction < 0 ? '‹' : '›'}
  </button>;
}

export default function NotebookPageControls({ notebooks = [], canEdit, canNavigate = canEdit, readOnly = false, busy = false, onPageChange }) {
  const { ui } = useLanguage();
  const layerRef = useRef(null), inputRef = useRef(null);
  useEffect(() => {
    const input = installNotebookNavigationInput(layerRef.current);
    inputRef.current = input;
    return () => { input.dispose(); if (inputRef.current === input) inputRef.current = null; };
  }, []);
  const disabled = !canNavigate || busy;
  return (
    <div className="notebook-navigation-layer" ref={layerRef}>
      {notebooks.map(({ id, pageNumber, pageCount, position }) => (
        <div key={id} className="notebook-page-controls" data-notebook-id={id} style={position}
          role="group" aria-label={ui('Страницы блокнота')}
          onPointerDown={stopPropagation} onPointerUp={stopPropagation}
          onMouseDown={stopPropagation} onMouseUp={stopPropagation}
          onTouchStart={stopPropagation} onTouchEnd={stopPropagation}
          onClick={stopPropagation} onDoubleClick={stopPropagation} onKeyDown={stopPropagation}>
          <div className="notebook-nav-island notebook-nav-previous">
            <NotebookArrow label={ui('Предыдущая страница')} disabled={disabled || pageNumber <= 1} direction={-1}
              inputRef={inputRef} onActivate={() => onPageChange(-1, id, true)} />
          </div>
          <span className="notebook-nav-island notebook-page-number" aria-live="polite" aria-atomic="true"
            onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}>
            {pageNumber}
          </span>
          <div className="notebook-nav-island notebook-nav-next">
            <NotebookArrow label={ui('Следующая страница')} disabled={disabled || (readOnly && pageNumber >= pageCount)} direction={1}
              inputRef={inputRef} onActivate={() => onPageChange(1, id, true)} />
          </div>
        </div>
      ))}
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
