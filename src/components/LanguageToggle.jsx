import { useLanguage } from './LanguageProvider.jsx';

export default function LanguageToggle({ compact = false, className = '' }) {
  const { language, setLanguage, t } = useLanguage();
  return (
    <div
      className={`language-toggle ${compact ? 'language-toggle-compact' : ''} ${className}`.trim()}
      role="group"
      aria-label={t('common.language')}
    >
      <button
        type="button"
        className={language === 'ru' ? 'active' : ''}
        aria-pressed={language === 'ru'}
        onClick={() => setLanguage('ru')}
      >RU</button>
      <button
        type="button"
        className={language === 'en' ? 'active' : ''}
        aria-pressed={language === 'en'}
        onClick={() => setLanguage('en')}
      >EN</button>
    </div>
  );
}
