import { useLanguage } from './LanguageProvider.jsx';
export default function PdfPageControls({ pageNumber, pageCount, canEdit, busy, position, onPageChange }) {
  const { ui } = useLanguage();
  return <div className="pdf-page-controls" style={position} role="group" aria-label={ui('Страницы PDF')}
    onPointerDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}>
    <button type="button" title={ui('Предыдущая страница')} aria-label={ui('Предыдущая страница')}
      disabled={!canEdit || busy || pageNumber <= 1} onClick={() => onPageChange(pageNumber - 1)}>‹</button>
    <span aria-live="polite">{pageNumber} / {pageCount}</span>
    <button type="button" title={ui('Следующая страница')} aria-label={ui('Следующая страница')}
      disabled={!canEdit || busy || pageNumber >= pageCount} onClick={() => onPageChange(pageNumber + 1)}>›</button>
  </div>;
}
