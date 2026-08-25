import { useCallback, useEffect, useMemo, useState } from 'react';
import { getOwnedBoards } from '../lib/boardLibrary.js';
import {
  claimOwnedBoardsForAccount,
  claimTeacherMacAgent,
  getTeacherMacStatus,
  getTeacherSession,
  onTeacherAuthChange,
  requestTeacherPasswordReset,
  revokeTeacherMacAgent,
  sendTeacherMagicLink,
  signInTeacherWithPassword,
  signOutTeacher,
  signUpTeacherWithPassword,
  updateTeacherPassword,
} from '../lib/teacherAccount.js';

function friendlyAuthError(caught, fallback) {
  const message = String(caught?.message ?? '');
  if (/invalid login credentials/i.test(message)) return 'Неверная почта или пароль.';
  if (/email not confirmed/i.test(message)) return 'Сначала подтвердите почту по ссылке из письма.';
  if (/password should be at least/i.test(message)) return 'Пароль должен содержать не менее 8 символов.';
  if (/rate limit/i.test(message)) return 'Слишком много попыток. Подождите немного и повторите.';
  return message || fallback;
}

export default function TeacherAccountPanel({ onBoardsClaimed }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [agents, setAgents] = useState([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const macDownloadUrl = useMemo(
    () => `${import.meta.env.BASE_URL}downloads/alex-browser-macos.zip`,
    [],
  );
  const isMacDesktop = useMemo(() => (
    /Macintosh/i.test(navigator.userAgent) && Number(navigator.maxTouchPoints || 0) < 2
  ), []);

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
    const unsubscribe = onTeacherAuthChange((next, event) => {
      if (disposed) return;
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
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

  function resetFeedback() {
    setError('');
    setMessage('');
  }

  async function handlePasswordAuth(event) {
    event.preventDefault();
    resetFeedback();
    if (authMode === 'signup' && password !== passwordConfirm) {
      setError('Пароли не совпадают.');
      return;
    }
    setBusy('auth');
    try {
      if (authMode === 'signup') {
        const result = await signUpTeacherWithPassword(email, password);
        setMessage(result.session
          ? 'Аккаунт создан, вход выполнен.'
          : 'Письмо подтверждения отправлено. Откройте его, затем войдите с паролем.');
      } else {
        await signInTeacherWithPassword(email, password);
        setMessage('Вход выполнен.');
      }
      setPassword('');
      setPasswordConfirm('');
    } catch (caught) {
      setError(friendlyAuthError(caught, 'Не удалось войти в аккаунт'));
    } finally {
      setBusy('');
    }
  }

  async function handleResetRequest(event) {
    event.preventDefault();
    resetFeedback();
    setBusy('reset');
    try {
      await requestTeacherPasswordReset(email);
      setMessage('Письмо для смены пароля отправлено. Откройте ссылку на этом устройстве.');
    } catch (caught) {
      setError(friendlyAuthError(caught, 'Не удалось отправить письмо'));
    } finally {
      setBusy('');
    }
  }

  async function handlePasswordUpdate(event) {
    event.preventDefault();
    resetFeedback();
    setBusy('password');
    try {
      await updateTeacherPassword(newPassword);
      setNewPassword('');
      setRecoveryMode(false);
      setChangePasswordOpen(false);
      setMessage('Новый пароль сохранён.');
    } catch (caught) {
      setError(friendlyAuthError(caught, 'Не удалось сохранить пароль'));
    } finally {
      setBusy('');
    }
  }

  async function handleMagicLink(event) {
    event.preventDefault();
    resetFeedback();
    setBusy('magic');
    try {
      await sendTeacherMagicLink(email);
      setMessage('Старая ссылка входа отправлена. Откройте её на этом устройстве.');
    } catch (caught) {
      setError(friendlyAuthError(caught, 'Не удалось отправить письмо'));
    } finally {
      setBusy('');
    }
  }

  async function handlePair(event) {
    event.preventDefault();
    setBusy('pair');
    resetFeedback();
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
          <p>Один аккаунт для всех досок и фонового браузера на Mac.</p>
        </div>
        {session && (
          <button
            type="button"
            className="secondary-button compact-button"
            onClick={async () => {
              setBusy('signout');
              try { await signOutTeacher(); } finally { setBusy(''); }
            }}
            disabled={busy === 'signout'}
          >
            Выйти
          </button>
        )}
      </div>

      {recoveryMode ? (
        <form className="teacher-account-form account-password-form" onSubmit={handlePasswordUpdate}>
          <label className="field">
            <span>Новый пароль</span>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              required
            />
          </label>
          <button type="submit" className="primary-button small" disabled={busy === 'password'}>
            {busy === 'password' ? 'Сохраняю…' : 'Сохранить новый пароль'}
          </button>
        </form>
      ) : !session ? (
        <div className="teacher-auth-shell">
          <div className="teacher-auth-tabs" role="tablist" aria-label="Вход или регистрация">
            <button
              type="button"
              className={authMode === 'signin' ? 'is-active' : ''}
              onClick={() => { setAuthMode('signin'); resetFeedback(); }}
            >
              Войти
            </button>
            <button
              type="button"
              className={authMode === 'signup' ? 'is-active' : ''}
              onClick={() => { setAuthMode('signup'); resetFeedback(); }}
            >
              Создать аккаунт
            </button>
          </div>
          {authMode !== 'reset' && (
            <form className="teacher-account-form teacher-password-auth" onSubmit={handlePasswordAuth}>
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
              <label className="field">
                <span>Пароль</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={authMode === 'signup' ? 8 : undefined}
                  maxLength={128}
                  autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                  required
                />
              </label>
              {authMode === 'signup' && (
                <label className="field">
                  <span>Повторите пароль</span>
                  <input
                    type="password"
                    value={passwordConfirm}
                    onChange={(event) => setPasswordConfirm(event.target.value)}
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                  />
                </label>
              )}
              <button type="submit" className="primary-button small" disabled={busy === 'auth'}>
                {busy === 'auth' ? 'Подождите…' : (authMode === 'signup' ? 'Зарегистрироваться' : 'Войти')}
              </button>
            </form>
          )}
          <div className="teacher-auth-links">
            <button
              type="button"
              onClick={() => setAuthMode((current) => (current === 'reset' ? 'signin' : 'reset'))}
            >
              {authMode === 'reset' ? 'Вернуться ко входу' : 'Забыли пароль?'}
            </button>
          </div>
          {authMode === 'reset' && (
            <form className="teacher-reset-form" onSubmit={handleResetRequest}>
              <span>Отправим на указанную почту ссылку для задания нового пароля.</span>
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
              <button type="submit" className="secondary-button compact-button" disabled={busy === 'reset'}>
                {busy === 'reset' ? 'Отправляю…' : 'Отправить письмо'}
              </button>
            </form>
          )}
          <details className="teacher-legacy-login">
            <summary>Старый вход по одноразовой ссылке</summary>
            <form onSubmit={handleMagicLink}>
              <span>Оставлен для аккаунтов, созданных до появления пароля.</span>
              <button type="submit" className="secondary-button compact-button" disabled={busy === 'magic'}>
                {busy === 'magic' ? 'Отправляю…' : 'Прислать ссылку'}
              </button>
            </form>
          </details>
        </div>
      ) : (
        <>
          <div className="teacher-account-session-row">
            <p className="teacher-account-email">Выполнен вход: <strong>{session.user.email}</strong></p>
            <button
              type="button"
              className="text-button"
              onClick={() => setChangePasswordOpen((value) => !value)}
            >
              Изменить пароль
            </button>
          </div>
          {changePasswordOpen && (
            <form className="teacher-account-form account-password-form" onSubmit={handlePasswordUpdate}>
              <label className="field">
                <span>Новый пароль</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  required
                />
              </label>
              <button type="submit" className="secondary-button compact-button" disabled={busy === 'password'}>
                {busy === 'password' ? 'Сохраняю…' : 'Сохранить'}
              </button>
            </form>
          )}

          <div className="teacher-server-download">
            <div>
              <strong>Фоновый браузер для iPad и iPhone</strong>
              <span>Работает на Mac без открытого Terminal и автоматически запускается после входа в macOS.</span>
            </div>
            {isMacDesktop ? (
              <a className="primary-button small" href={macDownloadUrl} download>
                Скачать сервер для Mac
              </a>
            ) : (
              <span className="teacher-download-hint">Откройте этот аккаунт на Mac, чтобы скачать сервер.</span>
            )}
          </div>

          <form className="teacher-pair-form" onSubmit={handlePair}>
            <label className="field">
              <span>Код из программы Alex Browser на Mac</span>
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
