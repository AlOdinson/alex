import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  return source.replace(before, after);
}

const toolbarPath = new URL('../src/components/Toolbar.jsx', import.meta.url);
let toolbar = fs.readFileSync(toolbarPath, 'utf8');
toolbar = replaceOnce(
  toolbar,
  `          {isOwner && screenShare && (\n            <span className="desktop-screen-share">`,
  `          {canEdit && screenShare && (\n            <span className="desktop-screen-share">`,
  'editor ShareScreen control',
);
fs.writeFileSync(toolbarPath, toolbar);

const overlayPath = new URL('../src/components/ScreenShare.jsx', import.meta.url);
let overlay = fs.readFileSync(overlayPath, 'utf8');
overlay = replaceOnce(
  overlay,
  `  const remoteBrowser = sourceMode === 'remote-browser';\n  const hasRemoteControl = remoteBrowser`,
  `  const remoteBrowser = sourceMode === 'remote-browser';\n  const boardScreenLivesOnCanvas = !remoteBrowser\n    && ['hosting', 'viewing', 'connecting'].includes(phase);\n  const hasRemoteControl = remoteBrowser`,
  'board-hosted normal screen state',
);
overlay = replaceOnce(
  overlay,
  `  if (phase === 'idle') return null;\n  const present = role === 'host';`,
  `  if (phase === 'idle') return null;\n  if (boardScreenLivesOnCanvas) return null;\n  const present = role === 'host';`,
  'hide legacy active screen overlay',
);
overlay = replaceOnce(
  overlay,
  `  const simpleNotice = phase === 'unsupported'\n    || phase === 'remote-unavailable'\n    || phase === 'error'\n    || phase === 'requesting';`,
  `  const simpleNotice = phase === 'unsupported'\n    || phase === 'remote-unavailable'\n    || phase === 'error'\n    || phase === 'requesting'\n    || (!remoteBrowser && phase === 'paused');`,
  'paused normal screen notice',
);
fs.writeFileSync(overlayPath, overlay);
