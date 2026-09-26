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
  /frameRate:\s*\{\s*ideal:\s*10,\s*max:\s*60\s*\}/,
  'Capture must start with the standard preference while retaining a 60 FPS Ultra envelope.',
);
includes(
  /setUltraEnabled/,
  'The host session must expose a live Ultra quality toggle.',
);
includes(
  /ULTRA_SCREEN_SHARE_TOGGLE_EVENT/,
  'The board-native Ultra checkbox must be wired to the host session.',
);
includes(
  /setResolution720Enabled/,
  'The host session must expose a live 720p quality toggle.',
);
includes(
  /HD720_SCREEN_SHARE_TOGGLE_EVENT/,
  'The board-native 720 checkbox must be wired to the host session.',
);
includes(
  /width:\s*\{\s*ideal:\s*1280,\s*max:\s*1280\s*\}[\s\S]*?height:\s*\{\s*ideal:\s*720,\s*max:\s*720\s*\}/,
  '720 mode must cap capture at 1280x720.',
);
includes(
  /width:\s*\{\s*ideal:\s*1920,\s*max:\s*1920\s*\}[\s\S]*?height:\s*\{\s*ideal:\s*1080,\s*max:\s*1080\s*\}/,
  'Ultra without 720 must request 1920x1080.',
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
  /sendSignal\('screen-layout',\s*\{\s*layout\s*\},\s*session\)/,
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