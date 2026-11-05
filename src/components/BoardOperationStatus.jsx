import { useLanguage } from './LanguageProvider.jsx';
export default function BoardOperationStatus({ notice, onDismiss, uploads = [], onRetry, onClear }) {
  const { language } = useLanguage();
  const en=language==='en';
  const labels=en?{queued:'Queued',uploading:'Uploading',waiting:'Waiting for connection',failed:'Failed',done:'Saved'}:{queued:'В очереди',uploading:'Загружается',waiting:'Ожидает соединения',failed:'Ошибка',done:'Сохранено'};
  return <div className="board-operation-status" data-i18n-skip>
    {notice&&<div className={`board-operation-notice ${notice.tone||''}`} role={notice.tone==='error'?'alert':'status'}>
      <span>{notice.message}</span><button type="button" aria-label={en?'Close':'Закрыть'} onClick={onDismiss}>×</button>
    </div>}
    {uploads.length>0&&<section className="board-upload-status" aria-label={en?'File uploads':'Загрузка файлов'}>
      <header><strong>{en?'Files':'Файлы'}: {uploads.filter(x=>x.status==='done').length}/{uploads.length}</strong><button type="button" onClick={onClear}>{en?'Hide saved':'Убрать сохранённые'}</button></header>
      <div className="board-upload-items">{uploads.map(job=><div className={`board-upload-item ${job.status}`} key={job.id}>
        <span className="board-upload-name" title={job.name}>{job.name}</span><span role="status">{labels[job.status]}</span>
        {job.error&&<small>{job.error}</small>}
        {job.status==='failed'&&<button type="button" onClick={()=>onRetry(job.id)}>{en?'Retry':'Повторить'}</button>}
      </div>)}</div>
      {uploads.some(x=>x.status==='waiting')&&<small>{en?'Keep this tab open. Uploads resume when editing reconnects.':'Не закрывайте вкладку. Загрузка продолжится после восстановления соединения.'}</small>}
    </section>}
  </div>;
}
