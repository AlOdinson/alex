import { useCallback, useEffect, useState } from 'react';
import {
  createBoard,
  deleteBoard,
  duplicateBoard,
  getBoardAccess,
  isSupabaseConfigured,
  setBoardMetadata,
} from '../lib/boardRepository.js';
import {
  forgetOwnedBoard,
  getOwnedBoards,
  rememberOwnedBoard,
  updateOwnedBoard,
} from '../lib/boardLibrary.js';

function formatDate(value) {
  if (!value) return 'Ещё не использовалась';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Дата неизвестна';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export default function Home() {
  const [title, setTitle] = useState('Новая доска');
  const [studentName, setStudentName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [boards, setBoards] = useState([]);
  const [loadingBoards, setLoadingBoards] = useState(true);

  const refreshBoards = useCallback(async () => {
    setLoadingBoards(true);
    const entries = getOwnedBoards();
    const hydrated = await Promise.all(entries.map(async (entry) => {
      try {
        const access = await getBoardAccess(entry.boardId, entry.ownerKey);
        if (!access || access.permission !== 'owner') return null;
        return {
          ...entry,
          title: access.title,
          studentName: access.studentName ?? '',
          updatedAt: access.lastLessonAt ?? access.updatedAt,
        };
      } catch {
        return { ...entry, unavailable: true };
      }
    }));
    setBoards(hydrated.filter(Boolean));
    setLoadingBoards(false);
  }, []);

  useEffect(() => {
    refreshBoards();
  }, [refreshBoards]);

  async function handleCreate() {
    setCreating(true);
    setError('');
    try {
      const created = await createBoard(title, studentName);
      rememberOwnedBoard({
        boardId: created.boardId,
        ownerKey: created.ownerKey,
        title,
        studentName,
      });
      window.location.assign(`${import.meta.env.BASE_URL}board/${created.boardId}?key=${encodeURIComponent(created.ownerKey)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось создать доску');
      setCreating(false);
    }
  }

  async function handleRename(board) {
    const nextTitle = window.prompt('Новое название доски', board.title ?? 'Новая доска');
    if (nextTitle === null || !nextTitle.trim()) return;
    const nextStudent = window.prompt('Имя ученика', board.studentName ?? '');
    if (nextStudent === null) return;
    try {
      await setBoardMetadata(board.boardId, board.ownerKey, {
        title: nextTitle,
        studentName: nextStudent,
      });
      updateOwnedBoard(board.boardId, { title: nextTitle.trim(), studentName: nextStudent.trim() });
      await refreshBoards();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось переименовать доску');
    }
  }

  async function handleDuplicate(board) {
    const nextTitle = window.prompt('Название копии', `${board.title ?? 'Доска'} — копия`);
    if (nextTitle === null) return;
    try {
      const created = await duplicateBoard(board.boardId, board.ownerKey, nextTitle);
      rememberOwnedBoard({
        boardId: created.boardId,
        ownerKey: created.ownerKey,
        title: nextTitle,
        studentName: board.studentName ?? '',
      });
      await refreshBoards();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось скопировать доску');
    }
  }

  async function handleDelete(board) {
    if (!window.confirm(`Удалить доску «${board.title}»? Это действие нельзя отменить.`)) return;
    try {
      await deleteBoard(board.boardId, board.ownerKey);
      forgetOwnedBoard(board.boardId);
      await refreshBoards();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось удалить доску');
    }
  }

  return (
    <main className="home-page home-page-wide">
      <section className="home-card create-board-card">
        <div className="brand-mark">A</div>
        <h1>Alex Board</h1>
        <p className="lead">
          Совместная онлайн-доска для уроков с надёжной синхронизацией между компьютером,
          телефоном и планшетом.
        </p>

        {!isSupabaseConfigured && (
          <div className="notice warning">
            Сейчас включён локальный режим. Для работы через интернет подключи Supabase.
          </div>
        )}

        <div className="create-board-fields">
          <label className="field">
            <span>Название доски</span>
            <input
              value={title}
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Ученик</span>
            <input
              value={studentName}
              maxLength={120}
              placeholder="Например, Артём"
              onChange={(event) => setStudentName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !creating) handleCreate();
              }}
            />
          </label>
        </div>

        <button className="primary-button" type="button" onClick={handleCreate} disabled={creating}>
          {creating ? 'Создаю…' : 'Создать доску'}
        </button>

        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="board-library" aria-labelledby="board-library-title">
        <div className="board-library-heading">
          <div>
            <h2 id="board-library-title">Мои доски</h2>
            <p>Доски хранятся в этом браузере как ссылки владельца.</p>
          </div>
          <button type="button" className="secondary-button" onClick={refreshBoards}>
            Обновить
          </button>
        </div>

        {loadingBoards && <div className="library-empty">Загружаю список…</div>}
        {!loadingBoards && boards.length === 0 && (
          <div className="library-empty">Создай первую доску — она появится здесь.</div>
        )}

        <div className="board-library-grid">
          {boards.map((board) => (
            <article className="board-library-card" key={board.boardId}>
              <div className="board-card-main">
                <h3>{board.title || 'Новая доска'}</h3>
                <p className="board-student">{board.studentName || 'Ученик не указан'}</p>
                <p className="board-updated">Последний урок: {formatDate(board.updatedAt)}</p>
                {board.unavailable && <p className="error-text">Не удалось проверить эту доску</p>}
              </div>
              <div className="board-card-actions">
                <a
                  className="primary-button compact-button"
                  href={`${import.meta.env.BASE_URL}board/${board.boardId}?key=${encodeURIComponent(board.ownerKey)}`}
                >
                  Открыть
                </a>
                <button type="button" className="secondary-button compact-button" onClick={() => handleRename(board)}>
                  Переименовать
                </button>
                <button type="button" className="secondary-button compact-button" onClick={() => handleDuplicate(board)}>
                  Копировать
                </button>
                <button type="button" className="danger-button compact-button" onClick={() => handleDelete(board)}>
                  Удалить
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
