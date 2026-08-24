import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createBoard,
  deleteBoard,
  deleteOwnedBoards,
  duplicateBoard,
  getOwnedBoardSummaries,
  isSupabaseConfigured,
  setBoardMetadata,
} from '../lib/boardRepository.js';
import {
  forgetOwnedBoard,
  forgetOwnedBoards,
  getOwnedBoards,
  getOwnedBoardsOverLimit,
  OWNED_BOARD_LIMIT,
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
  const [duplicatingBoardId, setDuplicatingBoardId] = useState(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedBoardIds, setSelectedBoardIds] = useState(() => new Set());
  const [deletingSelected, setDeletingSelected] = useState(false);
  const refreshSequenceRef = useRef(0);
  const libraryRefreshRef = useRef(Promise.resolve());

  const refreshBoards = useCallback(async () => {
    const refreshSequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = refreshSequence;
    setLoadingBoards(true);
    const entries = getOwnedBoards();
    // Show the cached library immediately; server validation no longer blocks the page.
    setBoards(entries);
    if (!entries.length) {
      setLoadingBoards(false);
      return;
    }
    try {
      const summaries = await getOwnedBoardSummaries(entries);
      if (refreshSequenceRef.current !== refreshSequence) return;
      const summariesById = new Map(summaries.map((summary) => [summary.boardId, summary]));
      const hydrated = entries.map((entry) => {
        const summary = summariesById.get(entry.boardId);
        if (!summary) return { ...entry, unavailable: true };
        const metadata = {
          title: summary.title,
          studentName: summary.studentName ?? '',
          createdAt: summary.createdAt ?? entry.createdAt ?? null,
          updatedAt: summary.lastLessonAt ?? summary.updatedAt,
        };
        updateOwnedBoard(entry.boardId, metadata);
        return { ...entry, ...metadata, unavailable: false };
      });
      setBoards(hydrated);
    } catch {
      if (refreshSequenceRef.current === refreshSequence) {
        setBoards(entries.map((entry) => ({ ...entry, unavailable: true })));
      }
    } finally {
      if (refreshSequenceRef.current === refreshSequence) setLoadingBoards(false);
    }
  }, []);

  useEffect(() => {
    libraryRefreshRef.current = refreshBoards();
  }, [refreshBoards]);

  useEffect(() => {
    const visibleIds = new Set(boards.map((board) => board.boardId));
    setSelectedBoardIds((current) => {
      const next = new Set([...current].filter((boardId) => visibleIds.has(boardId)));
      return next.size === current.size ? current : next;
    });
  }, [boards]);

  async function enforceOwnedBoardLimit(preserveBoardId) {
    const overflow = getOwnedBoardsOverLimit(OWNED_BOARD_LIMIT, preserveBoardId);
    if (!overflow.length) return;
    const result = await deleteOwnedBoards(overflow, { clearCaches: false });
    forgetOwnedBoards(result.deletedBoardIds);
    if (result.failedBoardIds.length) {
      throw new Error(
        `Новая доска создана, но ${result.failedBoardIds.length} старых досок не удалось удалить. Повторите удаление из списка.`,
      );
    }
  }

  async function handleCreate() {
    setCreating(true);
    setError('');
    let created = null;
    try {
      created = await createBoard(title, studentName);
      rememberOwnedBoard({
        boardId: created.boardId,
        ownerKey: created.ownerKey,
        title,
        studentName,
        createdAt: created.createdAt,
      });
      // The metadata request starts together with the page and normally finishes before
      // creation. Waiting here makes the oldest-board choice exact without serializing
      // the two network requests.
      await libraryRefreshRef.current;
      await enforceOwnedBoardLimit(created.boardId);
      window.location.assign(`${import.meta.env.BASE_URL}board/${created.boardId}?key=${encodeURIComponent(created.ownerKey)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось создать доску');
      setCreating(false);
      if (created) await refreshBoards();
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
    if (duplicatingBoardId) return;
    const nextTitle = window.prompt('Название копии', `${board.title ?? 'Доска'} — копия`);
    if (nextTitle === null) return;
    setDuplicatingBoardId(board.boardId);
    setError('');
    try {
      const created = await duplicateBoard(board.boardId, board.ownerKey, nextTitle);
      rememberOwnedBoard({
        boardId: created.boardId,
        ownerKey: created.ownerKey,
        title: nextTitle,
        studentName: board.studentName ?? '',
        createdAt: created.createdAt ?? new Date().toISOString(),
      });
      await enforceOwnedBoardLimit(created.boardId);
      await refreshBoards();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось скопировать доску');
    } finally {
      setDuplicatingBoardId(null);
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

  function toggleBoardSelection(boardId) {
    setSelectedBoardIds((current) => {
      const next = new Set(current);
      if (next.has(boardId)) next.delete(boardId);
      else next.add(boardId);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedBoardIds((current) => (
      current.size === boards.length
        ? new Set()
        : new Set(boards.map((board) => board.boardId))
    ));
  }

  async function handleDeleteSelected() {
    const selectedBoards = boards.filter((board) => selectedBoardIds.has(board.boardId));
    if (!selectedBoards.length || deletingSelected) return;
    if (!window.confirm(
      `Удалить выбранные доски (${selectedBoards.length})? Это действие нельзя отменить.`,
    )) return;

    setDeletingSelected(true);
    setError('');
    try {
      const result = await deleteOwnedBoards(selectedBoards);
      forgetOwnedBoards(result.deletedBoardIds);
      setSelectedBoardIds(new Set(result.failedBoardIds));
      if (result.failedBoardIds.length) {
        setError(`Не удалось удалить ${result.failedBoardIds.length} досок. Остальные удалены.`);
      } else {
        setSelectionMode(false);
      }
      await refreshBoards();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось удалить выбранные доски');
    } finally {
      setDeletingSelected(false);
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
            <p>До {OWNED_BOARD_LIMIT} досок на этом устройстве. При создании новой удаляется самая старая.</p>
          </div>
          <div className="board-library-heading-actions">
            {selectionMode ? (
              <>
                <button type="button" className="secondary-button" onClick={toggleSelectAll} disabled={deletingSelected}>
                  {selectedBoardIds.size === boards.length && boards.length ? 'Снять выделение' : 'Выделить все'}
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={handleDeleteSelected}
                  disabled={!selectedBoardIds.size || deletingSelected}
                >
                  {deletingSelected ? 'Удаляю…' : `Удалить выбранные (${selectedBoardIds.size})`}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setSelectionMode(false);
                    setSelectedBoardIds(new Set());
                  }}
                  disabled={deletingSelected}
                >
                  Отмена
                </button>
              </>
            ) : (
              <>
                {boards.length > 0 && (
                  <button type="button" className="secondary-button" onClick={() => setSelectionMode(true)}>
                    Выбрать
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    libraryRefreshRef.current = refreshBoards();
                  }}
                  disabled={loadingBoards}
                >
                  {loadingBoards ? 'Проверяю…' : 'Обновить'}
                </button>
              </>
            )}
          </div>
        </div>

        {loadingBoards && boards.length === 0 && <div className="library-empty">Загружаю список…</div>}
        {!loadingBoards && boards.length === 0 && (
          <div className="library-empty">Создай первую доску — она появится здесь.</div>
        )}

        <div className="board-library-grid">
          {boards.map((board) => (
            <article
              className={`board-library-card${selectedBoardIds.has(board.boardId) ? ' is-selected' : ''}`}
              key={board.boardId}
            >
              {selectionMode && (
                <label className="board-card-selector">
                  <input
                    type="checkbox"
                    checked={selectedBoardIds.has(board.boardId)}
                    onChange={() => toggleBoardSelection(board.boardId)}
                  />
                  <span>Выбрать доску</span>
                </label>
              )}
              <div className="board-card-main">
                <h3>{board.title || 'Новая доска'}</h3>
                <p className="board-student">{board.studentName || 'Ученик не указан'}</p>
                <p className="board-updated">Последний урок: {formatDate(board.updatedAt)}</p>
                {board.unavailable && <p className="error-text">Не удалось проверить эту доску</p>}
              </div>
              {!selectionMode && <div className="board-card-actions">
                <a
                  className="primary-button compact-button"
                  href={`${import.meta.env.BASE_URL}board/${board.boardId}?key=${encodeURIComponent(board.ownerKey)}`}
                >
                  Открыть
                </a>
                <button type="button" className="secondary-button compact-button" onClick={() => handleRename(board)}>
                  Переименовать
                </button>
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() => handleDuplicate(board)}
                  disabled={Boolean(duplicatingBoardId)}
                >
                  {duplicatingBoardId === board.boardId ? 'Копирую…' : 'Копировать'}
                </button>
                <button type="button" className="danger-button compact-button" onClick={() => handleDelete(board)}>
                  Удалить
                </button>
              </div>}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
