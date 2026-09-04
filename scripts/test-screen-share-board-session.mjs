import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/components/ScreenShare.jsx', import.meta.url), 'utf8');

function includes(pattern, message) {
  assert.match(source, pattern, message);
}

includes(
  /screenSharePermissionCanHost/,
  'ScreenShare hook must use the shared owner/edit host permission helper.',
);
includes(
  /normalizeScreenShareBoardLayout/,
  'ScreenShare hook must normalize collaborative board layout payloads.',
);
includes(
  /getInitialBoardLayout/,
  'ScreenShare hook must accept a board-provided initial layout callback.',
);
includes(
  /if \(!canEdit \|\| startBusyRef\.current\) return;/,
  'Normal screen capture must be available to every editor, not only the owner.',
);
assert.doesNotMatch(
  source,
  /const start = useCallback\(async \(\) => \{\s*if \(!isOwner \|\| startBusyRef\.current\) return;/,
  'Normal screen capture must no longer be owner-only.',
);
includes(
  /boardLayout:\s*session\.boardLayout/,
  'host-start must announce the current board layout for late joiners.',
);
includes(
  /signal\.type === 'screen-layout'/,
  'Active sessions must consume screen-layout collaboration signals.',
);
includes(
  /sendSignal\('screen-layout',\s*\{\s*layout:/,
  'Editors must broadcast screen-layout changes through the existing screen-share channel.',
);
includes(
  /updateBoardLayout/,
  'The hook must expose an updateBoardLayout API for Fabric transforms.',
);
includes(
  /sessionId:\s*view\.sessionId/,
  'The hook must expose the active session id to the board lifecycle.',
);
includes(
  /boardLayout:\s*view\.boardLayout/,
  'The hook must expose the current scene-space board layout.',
);
includes(
  /screenSharePermissionCanHost\(signal\.permission\)/,
  'Normal host lifecycle must accept both owner and edit permissions.',
);

console.log('screen-share board session regression passed');
