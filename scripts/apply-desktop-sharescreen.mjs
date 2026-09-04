import fs from 'node:fs';

const toolbarPath = new URL('../src/components/Toolbar.jsx', import.meta.url);
const stylesPath = new URL('../src/styles.css', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);

let toolbar = fs.readFileSync(toolbarPath, 'utf8');
const oldBlock = `          {isOwner && screenShare && (\n            <NavigationActionButton\n              active={screenShare.isHosting}\n              disabled={screenShare.buttonDisabled}\n              title={screenShare.activeRemoteSession\n                ? 'На этой доске уже идёт демонстрация экрана'\n                : (screenShare.isHosting\n                  ? 'Остановить демонстрацию экрана'\n                  : 'Показать экран или вкладку участникам')}\n              onClick={screenShare.toggle}\n            >\n              {screenShare.isHosting ? 'Стоп экран' : 'Экран'}\n            </NavigationActionButton>\n          )}\n`;
const newBlock = `          {isOwner && screenShare && (\n            <span className="desktop-screen-share">\n              <NavigationActionButton\n                active={screenShare.isHosting}\n                disabled={screenShare.buttonDisabled}\n                title={screenShare.activeRemoteSession\n                  ? 'На этой доске уже идёт демонстрация экрана'\n                  : (screenShare.isHosting\n                    ? 'Остановить демонстрацию экрана'\n                    : 'Показать экран или вкладку участникам')}\n                onClick={screenShare.toggle}\n              >\n                {screenShare.isHosting ? 'Stop Share' : 'ShareScreen'}\n              </NavigationActionButton>\n            </span>\n          )}\n`;

if (!toolbar.includes('className="desktop-screen-share"')) {
  if (!toolbar.includes(oldBlock)) throw new Error('Expected current screen-share toolbar block was not found.');
  toolbar = toolbar.replace(oldBlock, newBlock);
  fs.writeFileSync(toolbarPath, toolbar);
}

let styles = fs.readFileSync(stylesPath, 'utf8');
if (!styles.includes('.desktop-screen-share {')) {
  styles = `${styles.trimEnd()}\n\n/* Desktop-only entry point for the existing WebRTC screen-share flow. */\n.desktop-screen-share {\n  display: inline-flex;\n  flex: 0 0 auto;\n}\n\n@media (max-width: 760px) {\n  .desktop-screen-share {\n    display: none !important;\n  }\n}\n\n@media (hover: none) and (pointer: coarse) {\n  .desktop-screen-share {\n    display: none !important;\n  }\n}\n`;
  fs.writeFileSync(stylesPath, styles);
}

let packageSource = fs.readFileSync(packagePath, 'utf8');
if (!packageSource.includes('node scripts/test-desktop-sharescreen-button.mjs')) {
  const oldSync = '"test:sync": "node scripts/test-desktop-shape-palette-scale.mjs';
  const newSync = '"test:sync": "node scripts/test-desktop-sharescreen-button.mjs && node scripts/test-desktop-shape-palette-scale.mjs';
  if (!packageSource.includes(oldSync)) throw new Error('Could not register desktop ShareScreen regression in test:sync.');
  packageSource = packageSource.replace(oldSync, newSync);
  fs.writeFileSync(packagePath, packageSource);
}
