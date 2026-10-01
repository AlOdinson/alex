import { useLanguage } from './LanguageProvider.jsx';
export default function MediaLoadStatus({ entries, onRetry }) {
  const { ui } = useLanguage();
  return entries.map(entry => {
    const percent=entry.total ? Math.min(100,Math.floor(entry.loaded*100/entry.total)) : null;
    const label=entry.phase==='error' ? ui('Не удалось загрузить файл')
      : entry.phase==='rendering' ? ui('Подготовка страницы…')
      : entry.phase==='verifying' ? ui('Проверка файла…')
      : percent!==null ? `${ui('Загрузка')} — ${percent}%` : ui('Загрузка файла…');
    return <div key={entry.id} className="media-load-status" style={entry.position} data-phase={entry.phase}
      onPointerDown={event=>event.stopPropagation()} onTouchStart={event=>event.stopPropagation()}>
      <strong title={entry.name}>{entry.name || 'PDF / GIF'}</strong>
      <div role="status" aria-live="polite">{label}</div>
      {entry.phase==='receiving' && <progress max="100" value={percent ?? 0} aria-label={ui('Загрузка файла…')} />}
      {entry.phase==='error' && <><small>{ui(entry.error)}</small><button type="button" onClick={()=>onRetry(entry.object)}>{ui('Повторить загрузку')}</button></>}
    </div>;
  });
}
