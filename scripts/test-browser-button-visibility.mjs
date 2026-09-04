import fs from 'node:fs';

const toolbarSource = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const macBrowserHostSource = fs.readFileSync(new URL('../src/components/MacBrowserHost.jsx', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  toolbarSource.includes('const SHOW_BROWSER_BUTTON = false;'),
  'Toolbar must expose an easy one-line SHOW_BROWSER_BUTTON=false switch.',
);

assert(
  toolbarSource.includes('{SHOW_BROWSER_BUTTON && canEdit && screenShare && ('),
  'The browser navigation button must be gated behind SHOW_BROWSER_BUTTON.',
);

for (const token of [
  'screenShare.remoteBrowserActive',
  'screenShare.startRemoteBrowser',
  'screenShare.stopRemoteBrowser',
]) {
  assert(toolbarSource.includes(token), `Browser button wiring must remain in Toolbar.jsx: ${token}`);
}

assert(
  macBrowserHostSource.includes('MAX_REMOTE_BROWSER_VIEWERS')
    && macBrowserHostSource.includes('REMOTE_BROWSER_DATA_CHANNEL')
    && macBrowserHostSource.includes('SCREEN_SHARE_PROTOCOL'),
  'MacBrowserHost remote-browser implementation must remain intact.',
);

console.log('Browser button visibility regression passed.');
