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

const cases = [
  ['Введите имя, которое увидит преподаватель.', 'Enter the name your teacher will see.'],
  ['Удалить доску «Algebra»? Это действие нельзя отменить.', 'Delete board “Algebra”? This action cannot be undone.'],
  ['Загружаю изображение 2 из 3…', 'Uploading image 2 of 3…'],
  ['Редактирует Alex', 'Editing: Alex'],
  ['Редактирует', 'Editing:'],
  ['Открываю игротеку для участников…', 'Opening games for participants…'],
  ['Safari приостановил передачу, пока устройство ведущего находится в фоне.', 'Safari paused sharing while the host device is in the background.'],
  ['Письмо для смены пароля отправлено. Откройте ссылку на этом устройстве.', 'Password reset email sent. Open the link on this device.'],
  ['Mac подключён · браузер ожидает запуска', 'Mac connected · browser waiting to start'],
  ['Сервер слишком долго подтверждает очередь изменений', 'The server is taking too long to confirm the change queue'],
  ['Загрузка изображения…', 'Loading image…'],
  ['До ', 'Up to '],
  [' досок на этом устройстве. При создании новой удаляется самая старая.', ' boards on this device. Creating a new one removes the oldest.'],
  ['Последний урок: ', 'Last lesson: '],
];
for (const [source, expected] of cases) {
  assert.equal(translateUiText('en', source), expected, `English translation missing for: ${source}`);
}

// Arbitrary user content must never be guessed/translated by the raw UI translator.
assert.equal(translateUiText('en', 'Моя личная доска'), 'Моя личная доска');
assert.equal(translateUiText('en', 'Александр'), 'Александр');
assert.equal(translateUiText('ru', 'Введите имя'), 'Введите имя');

const providerSource = fs.readFileSync('src/components/LanguageProvider.jsx', 'utf8');
const toggleSource = fs.readFileSync('src/components/LanguageToggle.jsx', 'utf8');
const appSource = fs.readFileSync('src/App.jsx', 'utf8');
const homeSource = fs.readFileSync('src/components/Home.jsx', 'utf8');
const boardSource = fs.readFileSync('src/components/Board.jsx', 'utf8');
const toolbarSource = fs.readFileSync('src/components/Toolbar.jsx', 'utf8');
const gameLibrarySource = fs.readFileSync('src/components/GameLibrary.jsx', 'utf8');

assert.match(providerSource, /getStoredLanguage\(role\)/);
assert.match(providerSource, /setStoredLanguage\(role/);
assert.match(providerSource, /\[data-i18n-skip\]/);
assert.match(toggleSource, />RU</);
assert.match(toggleSource, />EN</);
assert.match(appSource, /LanguageProvider role="teacher"/);
assert.match(homeSource, /<LanguageToggle/);
assert.match(homeSource, /const \{[^}]*formatDate[^}]*\} = useLanguage\(\)/s);
assert.match(homeSource, /data-i18n-skip[^>]*>\{board\.title/);
assert.match(boardSource, /<LanguageToggle/);
assert.match(boardSource, /role=\{isOwner \? 'teacher' : 'student'\}/);
assert.match(boardSource, /titleIsUserContent=\{!isOwner\}/);
assert.match(toolbarSource, /<LanguageToggle[^>]*compact/);
assert.match(gameLibrarySource, /data-i18n-skip>\{participantName\}/);
assert.match(gameLibrarySource, /data-i18n-skip>\{boardTitle\}/);

console.log('i18n localization regression test passed');
