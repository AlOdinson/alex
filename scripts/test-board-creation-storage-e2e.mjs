import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright-core';

const engine = process.env.STORAGE_BROWSER ?? 'chromium';
const home = process.env.STORAGE_TEST_URL ?? 'http://127.0.0.1:5173/alex/';
const storeModule = new URL('src/lib/browserAuthorityStore.js', home).href;
const browser = await (engine === 'webkit'
  ? webkit.launch({ headless: true })
  : chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }));
const results = [];
const errors = [];
const createButton = (page) => page.locator('.create-board-card .primary-button');
async function records(page) {
  return page.evaluate(async (url) => (await import(url)).listAuthorityBoards(), storeModule);
}
async function createAndWait(page, doubleClick = false) {
  if (doubleClick) await createButton(page).evaluate((button) => { button.click(); button.click(); });
  else await createButton(page).click();
  await page.waitForURL(/\/board\/[A-Za-z0-9_-]+\?key=/, { timeout: 20_000 });
}
async function expectCreationError(page) {
  await page.locator('.create-board-card .error-text').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await createButton(page).isEnabled(), true);
  assert.equal(page.url(), home);
}

try {
  for (const [device, width, height, touch] of [
    ['desktop', 1280, 900, false], ['phone', 390, 844, true], ['tablet', 1024, 768, true],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch });
    const page = await context.newPage();
    await context.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'alex-board:owner-library:v2') throw new DOMException('Injected quota failure', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await page.goto(home);
    const title = `Storage recovery ${engine} ${device}`;
    await page.locator('.create-board-fields input').first().fill(title);
    await createAndWait(page, true);
    const boardUrl = page.url();
    const saved = await records(page);
    assert.equal(saved.length, 1, 'double event or cache failure created extra boards');
    assert.equal(saved[0].ownerKey, new URL(boardUrl).searchParams.get('key'));
    assert.equal(saved[0].title, title);
    await page.goto(home);
    await page.locator('.board-library-card').first().waitFor();
    assert.equal(await page.locator('.board-library-card').count(), 1);
    assert.equal(await page.locator('.board-library-card h3').innerText(), title);
    const ownerLink = new URL(await page.locator('.board-card-actions a').first().getAttribute('href'), home);
    assert.equal(ownerLink.searchParams.get('key'), saved[0].ownerKey);
    assert.deepEqual((await records(page))[0].snapshot, saved[0].snapshot);
    await page.reload();
    await page.locator('.board-library-card').first().waitFor();
    assert.equal(await page.locator('.board-library-card').count(), 1);
    results.push({ engine, device, cacheFailure: 'passed', singleCreate: 'passed', recoveryAfterReload: 'passed' });
    await context.close();
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(home);
  await createButton(page).waitFor();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    window.restoreAdd = () => { IDBObjectStore.prototype.add = original; };
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'boards') throw new DOMException('Injected durable storage failure', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await createButton(page).click();
  await expectCreationError(page);
  assert.equal((await records(page)).length, 0);
  await page.evaluate(() => window.restoreAdd());
  await createAndWait(page);
  assert.equal((await records(page)).length, 1);
  results.push({ engine, failedWriteDoesNotNavigate: 'passed', retryAfterError: 'passed' });
  await context.close();

  const timeoutContext = await browser.newContext();
  const timeoutPage = await timeoutContext.newPage();
  await timeoutPage.goto(home);
  await createButton(timeoutPage).waitFor();
  const sentinel = await timeoutPage.evaluate(async (url) => {
    const store = await import(url);
    return store.createAuthorityBoard({
      boardId: 'existing-sentinel', ownerKey: 'existing-owner',
      snapshot: { version: 2, background: 'grid', canvas: { objects: [{ type: 'rect', boardObjectId: 'keep-me', left: 42 }] } },
    });
  }, storeModule);
  await timeoutPage.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    const originalTimer = window.setTimeout;
    window.restoreStorage = () => { IDBObjectStore.prototype.add = originalAdd; window.setTimeout = originalTimer; };
    // Accelerate only the storage deadline. Keep the actual native transaction
    // active so the test checks real rollback, not a mocked abort callback.
    window.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 15_000 ? 200 : ms, ...args);
    IDBObjectStore.prototype.add = function (...args) {
      const request = originalAdd.apply(this, args);
      if (this.name === 'boards') {
        const store = this;
        const keepAlive = () => {
          try { const next = store.count(); next.onsuccess = keepAlive; next.onerror = () => {}; } catch { /* aborted */ }
        };
        keepAlive();
      }
      return request;
    };
  });
  await createButton(timeoutPage).click();
  await expectCreationError(timeoutPage);
  await timeoutPage.evaluate(() => window.restoreStorage());
  const afterTimeout = await records(timeoutPage);
  assert.equal(afterTimeout.length, 1, 'timed-out add must have been rolled back');
  assert.deepEqual(afterTimeout[0], sentinel, 'existing board changed during rollback');
  await createAndWait(timeoutPage);
  assert.equal((await records(timeoutPage)).length, 2);
  results.push({ engine, nativeTransactionRollback: 'passed', existingBoardPreserved: 'passed', retryAfterTimeout: 'passed' });
  await timeoutContext.close();
} catch (error) {
  errors.push(String(error.stack ?? error));
  throw error;
} finally {
  await mkdir('storage-e2e-results', { recursive: true });
  await writeFile(`storage-e2e-results/${engine}.json`, JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
