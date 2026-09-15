from pathlib import Path
import subprocess
subprocess.run(['git','apply','--check','.github/scripts/history-text.patch'],check=True)
subprocess.run(['git','apply','.github/scripts/history-text.patch'],check=True)
p=Path('package.json'); s=p.read_text(); s=s.replace('node --test scripts/test-history-dock-layout.mjs','node --test scripts/test-history-text-input.mjs scripts/test-history-dock-layout.mjs');p.write_text(s)
p=Path('scripts/test-history-device-matrix-e2e.mjs');s=p.read_text()
s="import { deriveShareKey } from '../src/lib/ids.js';\n"+s
old="""    await button(owner, 'Настройки', profiles[ownerIndex]);
    await owner.getByRole('menuitem', { name: 'Поделиться', exact: true }).click();
    const share = await owner.locator('.share-dialog .copy-row input').inputValue();
    await owner.getByRole('button', { name: 'Закрыть', exact: true }).click();"""
new="""    // Use the application's real share-key derivation for the synthetic board;
    // menu animation/clipboard behavior is not part of the history assertion.
    const guestURL = new globalThis.URL(owner.url());
    guestURL.searchParams.set('key', await deriveShareKey(guestURL.searchParams.get('key')));
    const share = guestURL.href;"""
assert old in s;s=s.replace(old,new)
s=s.replace("await input.waitFor({ state: 'attached' });", "await input.waitFor({ state: 'visible' });\n      await wait('selection color control enabled', () => input.isEnabled());")
s=s.replace("async function button(page, name, profile) {", "async function button(page, name, profile) {\n  await page.bringToFront();")
s=s.replace("  const box = await page.locator('canvas.upper-canvas').boundingBox();", "  await page.evaluate(() => {\n    window.__historyInput = [];\n    for (const type of ['pointerdown','pointermove','pointerup','mousedown','mouseup']) document.addEventListener(type, (event) => {\n      if (window.__historyInput.length < 60) window.__historyInput.push({type, pointerType:event.pointerType, target:event.target?.className, trusted:event.isTrusted, drawing:window.__historyCanvas().isDrawingMode});\n    }, {capture:true, once:true});\n  });\n  await delay(50);\n  const box = await page.locator('canvas.upper-canvas').boundingBox();")
s=s.replace("await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();", "for (let i=1;i<=8;i++) { await page.mouse.move(a.x+(b.x-a.x)*i/8, a.y+(b.y-a.y)*i/8); await delay(16); }\n    await page.mouse.up();")
s=s.replace("dataset: { ...document.documentElement.dataset },", "dataset: { ...document.documentElement.dataset }, inputEvents: window.__historyInput, drawing:window.__historyCanvas().isDrawingMode, pointerEvents:window.__historyCanvas().enablePointerEvents,")
p.write_text(s)
