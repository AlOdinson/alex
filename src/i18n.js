export const LANGUAGES = ['ru', 'en'];

const STORAGE_KEYS = {
  teacher: 'alex-board-language-teacher',
  student: 'alex-board-language-student',
};

const MESSAGES = {
  ru: {
    'common.language': 'Язык',
    'toolbar.pencil': 'Карандаш',
    'test.interpolation': 'Выбрано: {count}',
  },
  en: {
    'common.language': 'Language',
    'toolbar.pencil': 'Pencil',
    'test.interpolation': 'Selected: {count}',
  },
};

export function normalizeLanguage(language) {
  return LANGUAGES.includes(language) ? language : 'ru';
}

export function getLanguageStorageKey(role) {
  return STORAGE_KEYS[role === 'student' ? 'student' : 'teacher'];
}

export function getStoredLanguage(role) {
  if (typeof window === 'undefined') return 'ru';
  try {
    return normalizeLanguage(window.localStorage.getItem(getLanguageStorageKey(role)));
  } catch {
    return 'ru';
  }
}

export function setStoredLanguage(role, language) {
  const normalized = normalizeLanguage(language);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(getLanguageStorageKey(role), normalized);
    } catch {
      // Storage can be unavailable in private/restricted browser contexts.
    }
  }
  return normalized;
}

export function interpolate(template, params = {}) {
  return String(template ?? '').replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

export function translate(language, key, params = {}) {
  const normalized = normalizeLanguage(language);
  const template = MESSAGES[normalized]?.[key] ?? MESSAGES.ru?.[key] ?? key;
  return interpolate(template, params);
}

export function getDateLocale(language) {
  return normalizeLanguage(language) === 'en' ? 'en-US' : 'ru-RU';
}

export function translateUiText(language, value) {
  return String(value ?? '');
}
