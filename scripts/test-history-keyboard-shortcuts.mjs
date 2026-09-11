import assert from 'node:assert/strict';
import { normalizeHistoryShortcutKey } from '../src/historyKeyboardShortcuts.js';

assert.equal(
  normalizeHistoryShortcutKey({ ctrlKey: true, metaKey: false, code: 'KeyZ', key: 'я' }),
  'z',
  'Ctrl+physical-Z must normalize to undo on a Russian keyboard layout',
);
assert.equal(
  normalizeHistoryShortcutKey({ ctrlKey: false, metaKey: true, code: 'KeyZ', key: 'я' }),
  'z',
  'Command+physical-Z must normalize to undo on a Russian keyboard layout',
);
assert.equal(
  normalizeHistoryShortcutKey({ ctrlKey: true, metaKey: false, code: 'KeyY', key: 'н' }),
  'y',
  'Ctrl+physical-Y must normalize to redo on a Russian keyboard layout',
);
assert.equal(
  normalizeHistoryShortcutKey({
    ctrlKey: true,
    metaKey: false,
    code: 'KeyZ',
    key: 'я',
    target: { tagName: 'INPUT', isContentEditable: false },
  }),
  null,
  'Text inputs must keep the browser native undo behavior',
);
assert.equal(
  normalizeHistoryShortcutKey({ ctrlKey: true, metaKey: false, code: 'KeyZ', key: 'z' }),
  null,
  'Already-normalized Latin shortcuts must be left to Board.jsx to avoid duplicate undo',
);
assert.equal(
  normalizeHistoryShortcutKey({ ctrlKey: false, metaKey: false, code: 'KeyZ', key: 'я' }),
  null,
  'Plain typing must never be converted into a history shortcut',
);

console.log('layout-independent history shortcuts: ok');
