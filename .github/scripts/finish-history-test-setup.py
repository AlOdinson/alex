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
p.write_text(s)
