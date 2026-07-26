import { useEffect, useMemo, useState } from 'react';

const GAMES = [
  {
    id: 'percentage-ladybug-maze',
    title: 'Жучок и процентный лабиринт',
    description: 'Проведи божью коровку через лабиринт, решай задачи на проценты и успей добраться до мёда раньше воды.',
    tags: ['Проценты', 'Лабиринт', 'WASD и стрелки'],
    icon: '🐞',
    path: 'games/percentage-ladybug-maze/index.html?embedded=1',
  },
];

export default function GameLibrary({ boardTitle, participantName, onExit }) {
  const [selectedGameId, setSelectedGameId] = useState(null);
  const [gameStatus, setGameStatus] = useState('Загрузка…');
  const selectedGame = useMemo(
    () => GAMES.find((game) => game.id === selectedGameId) ?? null,
    [selectedGameId],
  );

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.classList.add('game-viewport-locked');
    body.classList.add('game-viewport-locked');
    return () => {
      root.classList.remove('game-viewport-locked');
      body.classList.remove('game-viewport-locked');
    };
  }, []);

  useEffect(() => {
    function handleMessage(event) {
      if (event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || message.source !== 'alex-board-game') return;
      if (message.gameId !== selectedGameId) return;

      if (message.type === 'GAME_READY') setGameStatus('Готово');
      if (message.type === 'GAME_STARTED') setGameStatus('Игра идёт');
      if (message.type === 'GAME_FINISHED') {
        setGameStatus(message.payload?.result === 'won' ? 'Победа' : 'Игра окончена');
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [selectedGameId]);

  if (selectedGame) {
    const gameUrl = `${import.meta.env.BASE_URL}${selectedGame.path}`;
    return (
      <main className="game-player-page">
        <header className="game-player-header">
          <button
            type="button"
            className="game-back-button"
            onClick={() => {
              setSelectedGameId(null);
              setGameStatus('Загрузка…');
            }}
          >
            ← Игротека
          </button>

          <div className="game-player-title">
            <strong>{selectedGame.title}</strong>
            <span>{participantName} · {boardTitle}</span>
          </div>

          <span className="game-status-pill">{gameStatus}</span>

          <button type="button" className="game-exit-button" onClick={onExit}>
            На доску
          </button>
        </header>

        <section className="game-frame-wrap" aria-label={selectedGame.title}>
          <iframe
            key={selectedGame.id}
            className="game-frame"
            src={gameUrl}
            title={selectedGame.title}
            allow="fullscreen"
            sandbox="allow-scripts allow-same-origin"
          />
        </section>
      </main>
    );
  }

  return (
    <main className="game-library-page">
      <header className="game-library-header">
        <div className="game-library-header-copy">
          <h1>Игротека</h1>
          <p>{participantName} · {boardTitle}</p>
        </div>
        <button type="button" className="game-exit-button" onClick={onExit}>
          Вернуться на доску
        </button>
      </header>

      <section className="game-library-content">
        <p className="game-library-intro">
          Сейчас доступна первая одиночная игра. При её запуске доска полностью выгружается,
          поэтому не обрабатывает клавиатуру, не рисует Fabric canvas и не расходует realtime-трафик.
        </p>

        <div className="game-card-grid">
          {GAMES.map((game) => (
            <article className="game-card" key={game.id}>
              <div className="game-card-preview">
                <div>
                  <span className="game-card-preview-icon" aria-hidden="true">{game.icon}</span>
                  <strong>Доберись до мёда</strong>
                </div>
              </div>
              <div className="game-card-body">
                <h2>{game.title}</h2>
                <p>{game.description}</p>
                <div className="game-card-tags">
                  {game.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
                <button
                  type="button"
                  className="game-start-button"
                  onClick={() => {
                    setGameStatus('Загрузка…');
                    setSelectedGameId(game.id);
                  }}
                >
                  Играть
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
