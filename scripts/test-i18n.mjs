import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LANGUAGES,
  getLanguageStorageKey,
  interpolate,
  translate,
  translateUiText,
  getDateLocale,
} from '../src/i18n.js';

assert.deepEqual(LANGUAGES, ['ru', 'en']);
assert.equal(getLanguageStorageKey('teacher'), 'alex-board-language-teacher');
assert.equal(getLanguageStorageKey('student'), 'alex-board-language-student');
assert.equal(translate('ru', 'common.language'), 'Язык');
assert.equal(translate('en', 'common.language'), 'Language');
assert.equal(translate('en', 'toolbar.pencil'), 'Pencil');
assert.equal(translate('ru', 'toolbar.pencil'), 'Карандаш');
assert.equal(interpolate('Delete selected ({count})', { count: 3 }), 'Delete selected (3)');
assert.equal(translate('en', 'test.interpolation', { count: 4 }), 'Selected: 4');
assert.equal(translate('xx', 'toolbar.pencil'), 'Карандаш');
assert.equal(translate('en', 'missing.translation.key'), 'missing.translation.key');
assert.equal(getDateLocale('ru'), 'ru-RU');
assert.equal(getDateLocale('en'), 'en-US');

assert.equal(
  translateUiText('en', 'Введите имя, которое увидит преподаватель.'),
  'Enter the name your teacher will see.',
);
assert.equal(
  translateUiText('en', 'Удалить доску «Algebra»? Это действие нельзя отменить.'),
  'Delete board “Algebra”? This action cannot be undone.',
);
assert.equal(
  translateUiText('en', 'Загружаю изображение 2 из 3…'),
  'Uploading image 2 of 3…',
);
assert.equal(translateUiText('en', 'Редактирует Alex'), 'Editing: Alex');
assert.equal(translateUiText('en', 'Моя личная доска'), 'Моя личная доска');
assert.equal(translateUiText('ru', 'Введите имя'), 'Введите имя');

const providerSource = fs.readFileSync('src/components/LanguageProvider.jsx', 'utf8');
const toggleSource = fs.readFileSync('src/components/LanguageToggle.jsx', 'utf8');
const appSource = fs.readFileSync('src/App.jsx', 'utf8');
const homeSource = fs.readFileSync('src/components/Home.jsx', 'utf8');
const boardSource = fs.readFileSync('src/components/Board.jsx', 'utf8');
const toolbarSource = fs.readFileSync('src/components/Toolbar.jsx', 'utf8');

assert.match(providerSource, /getStoredLanguage\(role\)/);
assert.match(providerSource, /setStoredLanguage\(role/);
assert.match(toggleSource, />RU</);
assert.match(toggleSource, />EN</);
assert.match(appSource, /LanguageProvider role="teacher"/);
assert.match(homeSource, /<LanguageToggle/);
assert.match(homeSource, /const \{[^}]*formatDate[^}]*\} = useLanguage\(\)/s);
assert.match(boardSource, /<LanguageToggle/);
assert.match(boardSource, /role=\{isOwner \? 'teacher' : 'student'\}/);
assert.match(toolbarSource, /<LanguageToggle[^>]*compact/);

console.log('i18n localization regression test passed');
