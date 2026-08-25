import { useCallback, useEffect, useState } from 'react';
import { getOwnedBoards } from '../lib/boardLibrary.js';
import {
  claimOwnedBoardsForAccount,
  claimTeacherMacAgent,
  getTeacherMacStatus,
  getTeacherSession,
  onTeacherAuthChange,
  revokeTeacherMacAgent,
  sendTeacherMagicLink,
  signOutTeacher,
} from '../lib/teacherAccount.js';

export default function TeacherAccountPanel({ onBoardsClaimed }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [agents, setAgents] = useState([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refreshAgents = useCallback(async () => {
    const next = await getTeacherMacStatus();
    setAgents(next);
  }, []);

  const initializeAccount = useCallback(async (nextSession) => {
    setSession(nextSession);
    if (!nextSession) {
      setAgents([]);
      return;
    }
    const claimed = await claimOwnedBoardsForAccount(getOwnedBoards());
    await refreshAgents();
    if (claimed > 0) {
      setMessage(`Аккаунт подключён. Привязано досок: ${claimed}.`);
      onBoardsClaimed?.();
    }
  }, [onBoardsClaimed, refreshAgents]);

  useEffect(() => {
    let disposed = false;
    getTeacherSession()
      .then((next) => {
        if (!disposed) return initializeAccount(next);
        return undefined;
      })
      .catch((caught) => {
        if (!disposed) setError(caught.message || 'Не удалось проверить аккаунт');
      })
      .finally(() => { if (!disposed) setLoading(false); });
    const unsubscribe = onTeacherAuthChange((next) => {
      if (disposed) return;
      initializeAccount(next).catch((caught) => setError(caught.message));
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [initializeAccount]);

  useEffect(() => {
    if (!session) return undefined;
    const timer = window.setInterval(() => refreshAgents().catch(() => undefined), 8_000);
    return () => window.clearInterval(timer);
  }, [refreshAgents, session]);

  async function handleEmail(event) {
    event.preventDefault();
    setBusy('email');
    setError('');
    setMessage('');
    try {
      await sendTeacherMagicLink(email);
      setMessage('Письмо отправлено. Откройте ссылку в письме на этом устройстве.');
    } catch (caught) {
      setError(caught.message || 'Не удалось отправить письмо');
    } finally {
      setBusy('');
    }
  }

  async function handlePair(event) {
    event.preventDefault();
    setBusy('pair');
    setError('');
    setMessage('');
    try {
      await claimTeacherMacAgent(pairingCode);
      setPairingCode('');
      await refreshAgents();
      setMessage('Mac привязан. Теперь он доступен во всех ваших досках.');
    } catch (caught) {
      setError(caught.message || 'Не удалось привязать Mac');
    } finally {
      setBusy('');
    }
  }

  if (loading) return <section className="teacher-account-card">Проверяю аккаунт…</section>;

  return (
    <section className="teacher-account-card" aria-labelledby="teacher-account-title">
      <div className="teacher-account-heading">
        <div>
          <h2 id="teacher-account-title">Аккаунт учителя</h2>
          <p>Один аккаунт для всех досок и постоянной привязки Mac.</p>
        </div>
        {session && (
          <button type="button" className="secondary-button compact-button" onClick={() => signOutTeacher()}>
            Выйти
          </button>
        )}
      </div>

      {!session ? (
        <form className="teacher-account-form" onSubmit={handleEmail}>
          <label className="field">
            <span>Почта</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="teacher@example.com"
              autoComplete="email"
              required
            />
          </label>
          <button type="submit" className="primary-button small" disabled={busy === 'email'}>
            {busy === 'email' ? 'Отправляю…' : 'Создать аккаунт / войти'}
          </button>
        </form>
      ) : (
        <>
          <p className="teacher-account-email">Выполнен вход: <strong>{session.user.email}</strong></p>
          <form className="teacher-pair-form" onSubmit={handlePair}>
            <label className="field">
              <span>Код из Alex Browser Server на Mac</span>
              <input
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
                placeholder="AB12CD34"
                inputMode="text"
                autoComplete="one-time-code"
                required
              />
            </label>
            <button type="submit" className="primary-button small" disabled={busy === 'pair' || pairingCode.length !== 8}>
              {busy === 'pair' ? 'Привязываю…' : 'Привязать Mac'}
            </button>
          </form>
          <div className="teacher-agent-list">
            {agents.length === 0 && <span>Привязанных компьютеров пока нет.</span>}
            {agents.map((agent) => (
              <div key={agent.agentId}>
                <span className={agent.online ? 'is-online' : ''} aria-hidden="true" />
                <strong>{agent.name}</strong>
                <small>{agent.online ? 'сейчас доступен' : 'не запущен'}</small>
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={async () => {
                    if (!window.confirm(`Отвязать ${agent.name}?`)) return;
                    await revokeTeacherMacAgent(agent.agentId);
                    await refreshAgents();
                  }}
                >
                  Отвязать
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {message && <p className="account-message">{message}</p>}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
