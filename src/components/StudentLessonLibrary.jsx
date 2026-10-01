import { useEffect, useState } from 'react';
import { studentLessonLibrary } from '../lib/studentLessonLibrary.js';

export default function StudentLessonLibrary() {
  const [lessons, setLessons] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    studentLessonLibrary.list().then(rows => { if (active) setLessons(rows); })
      .catch(() => { if (active) setError('Не удалось прочитать сохранённые уроки. Обновите страницу, чтобы повторить.'); });
    return () => { active = false; };
  }, []);
  const remove = async lesson => {
    if (!window.confirm('Удалить локальную копию урока с этого устройства? Общие файлы других уроков сохранятся. Доска учителя не изменится.')) return;
    setBusy(lesson.key); setError('');
    try {
      await studentLessonLibrary.remove(lesson);
      setLessons(await studentLessonLibrary.list());
    } catch { setError('Не удалось завершить удаление. Повторите попытку или обновите страницу.'); }
    finally { setBusy(null); }
  };
  if (!lessons.length && !error) return null;
  return <section className="board-library" aria-label="Сохранённые уроки">
    <div className="board-library-heading"><div>
      <h2>Сохранённые уроки на этом устройстве</h2>
      <p>Локальные копии для просмотра без учителя. Общий файл занимает место один раз и удаляется вместе с последним использующим его уроком.</p>
    </div></div>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="board-library-grid">{lessons.map(lesson => <article className="board-library-card" key={lesson.key}>
      <div className="board-card-main"><h3>{lesson.title || 'Сохранённый урок'}</h3>
        <p className="board-updated">{new Date(lesson.savedAt).toLocaleString()}</p>
        {lesson.boardId ? <p className="board-updated" data-i18n-skip>{lesson.boardId}</p> : <p className="board-updated">Копия из предыдущей версии. Общие PDF/GIF старых копий будут очищены после удаления или обновления последней из них.</p>}
      </div>
      <div className="board-card-actions"><button type="button" className="danger-button compact-button" disabled={busy !== null} onClick={() => remove(lesson)}>
        {busy === lesson.key ? 'Удаляю…' : 'Удалить локальную копию'}
      </button></div>
    </article>)}</div>
  </section>;
}
