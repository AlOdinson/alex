import { useEffect, useState } from 'react';
import { deriveShareKey } from '../lib/ids.js';

const MODES = [
  {
    id: 'edit',
    title: 'Редактирование',
    description: 'Ученик может рисовать, двигать и удалять объекты.',
  },
  {
    id: 'view',
    title: 'Только просмотр',
    description: 'Ученик видит доску и изменения, но не может редактировать.',
  },
  {
    id: 'closed',
    title: 'Закрыто',
    description: 'Гостевая ссылка временно не открывает доску.',
  },
];

export default function ShareDialog({ boardId, ownerKey, guestMode, onChangeMode, onClose }) {
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [macCopied, setMacCopied] = useState(false);
  const [changing, setChanging] = useState(false);

  const macServerUrl = `${window.location.origin}${import.meta.env.BASE_URL}board/${boardId}?key=${encodeURIComponent(ownerKey)}`;

  useEffect(() => {
    deriveShareKey(ownerKey).then((shareKey) => {
      setShareUrl(`${window.location.origin}${import.meta.env.BASE_URL}board/${boardId}?key=${encodeURIComponent(shareKey)}`);
    });
  }, [boardId, ownerKey]);

  async function copyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function copyMacServerLink() {
    try {
      await navigator.clipboard.writeText(macServerUrl);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = macServerUrl;
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setMacCopied(true);
    window.setTimeout(() => setMacCopied(false), 1600);
  }

  async function changeMode(mode) {
    setChanging(true);
    try {
      await onChangeMode(mode);
    } finally {
      setChanging(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-card share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2 id="share-title">Доступ к доске</h2>
            <p>Одна гостевая ссылка, а режим можно менять в любой момент.</p>
          </div>
          <button type="button" className="close-button" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="mode-list">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`mode-option ${guestMode === mode.id ? 'selected' : ''}`}
              disabled={changing}
              onClick={() => changeMode(mode.id)}
            >
              <span className="mode-radio" aria-hidden="true" />
              <span>
                <strong>{mode.title}</strong>
                <small>{mode.description}</small>
              </span>
            </button>
          ))}
        </div>

        <label className="field">
          <span>Ссылка для ученика</span>
          <div className="copy-row">
            <input readOnly value={shareUrl} />
            <button type="button" className="primary-button small" onClick={copyLink} disabled={!shareUrl}>
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
        </label>

        <p className="security-note">
          Не отправляй ученику адрес из своей строки браузера: это ссылка владельца.
        </p>

        <label className="field">
          <span>Локальный браузер на Mac</span>
          <button type="button" className="secondary-button" onClick={copyMacServerLink}>
            {macCopied ? 'Ссылка скопирована' : 'Скопировать ссылку для Mac-сервера'}
          </button>
        </label>
        <p className="security-note">
          Это секретная ссылка владельца. Вставляй её только в Alex Browser Server на своём Mac и не отправляй участникам.
        </p>
      </section>
    </div>
  );
}
