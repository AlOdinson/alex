import assert from 'node:assert/strict';
import {
  LANGUAGES,
  getLanguageStorageKey,
  interpolate,
  translate,
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

console.log('i18n core regression test passed');
