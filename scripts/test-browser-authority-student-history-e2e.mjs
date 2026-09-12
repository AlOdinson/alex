import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const PREVIEW_URL = process.env.BROWSER_AUTHORITY_PREVIEW_URL
  ?? 'https://alodinson.github.io/alex/preview-browser-authority/';
const TIMEOUT_MS = 45_000;

async function waitFor(label, check, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (lastError) throw new Error(`${label}: ${lastError.message}`);
  throw new Error(`Timed out waiting for ${label}`);
}

function boardIdFromUrl(value) {
  const match = new URL(value).pathname.match(/\/board\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

async function authorityBoard(page, boardId) {
  return page.evaluate(async (id) => new Promise((resolve, reject) => {
    const request = indexedDB.open('alex-board-authority');
    request.onerror = () => reject(request.error ?? new Error('Could not open authority IndexedDB'));
    request.onsuccess = () => {
      const db = request.result;
      try {
        const tx = db.transaction('boards', 'readonly');
        const get = tx.objectStore('boards').get(id);
        get.onerror = () => {
          db.close();
          reject(get.error ?? new Error('Could not read authority board'));
        };
        get.onsuccess = () => {
          const result = get.result ?? null;
          db.close();
          resolve(result);
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    };
  }), boardId);
}

async function enterBoardIfNeeded(page, name) {
  const state = await waitFor('participant name gate or board canvas', async () => {
    if (await page.locator('canvas.upper-canvas').isVisible().catch(() => false)) return 'canvas';
    if (await page.getByLabel('Ваше имя').isVisible().catch(() => false)) return 'name';
    return '';
  }, 12_000);
  if (state !== 'name') return;
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Войти на доску' }).click();
}

async function waitForDurableReady(page, label) {
  await waitFor(`${label} durable runtime ready`, async () => page.evaluate(() => {
    const dataset = document.documentElement?.dataset ?? {};
    return dataset.alexDurableEditState === 'ready'
      && dataset.alexDurableEditBlocked !== 'true';
  }));
}

async function canvasDigest(page) {
  return page.locator('canvas.lower-canvas').evaluate((canvas) => canvas.toDataURL('image/png'));
}

async function drawStroke(page) {
  await page.getByRole('button', { name: 'Карандаш' }).click();
  const canvas = page.locator('canvas.upper-canvas');
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 240 && box.height > 180, 'Fabric canvas has no usable bounds');
  const x1 = box.x + 180;
  const y1 = box.y + 180;
  const x2 = Math.min(box.x + box.width - 80, x1 + 150);
  const y2 = Math.min(box.y + box.height - 80, y1 + 60);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
  await page.mouse.up();
}

async function openShare(page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Поделиться', exact: true }).click();
  const input = page.locator('.share-dialog .copy-row input');
  return waitFor('student share URL', async () => {
    const value = await input.inputValue();
    return value.includes('/board/') && value.includes('?key=') ? value : '';
  });
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const teacherContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const studentContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const teacher = await teacherContext.newPage();
const student = await studentContext.newPage();

for (const [page, label] of [[teacher, 'teacher'], [student, 'student']]) {
  page.on('pageerror', (error) => console.error(`${label} pageerror:`, error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.error(`${label} console ${message.type()}:`, message.text());
    }
  });
}

try {
  await teacher.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await teacher.getByLabel('Название доски').fill(`Student history E2E ${Date.now()}`);
  await teacher.getByLabel('Ученик').fill('History smoke');
  await Promise.all([
    teacher.waitForURL(/\/board\//, { timeout: TIMEOUT_MS }),
    teacher.getByRole('button', { name: 'Создать доску' }).click(),
  ]);
  await enterBoardIfNeeded(teacher, 'Teacher History');
  await teacher.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(teacher, 'teacher');

  const boardId = boardIdFromUrl(teacher.url());
  assert.ok(boardId, 'Could not determine board id');
  await waitFor('fresh authority board', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? -1) === 0 ? board : null;
  });

  const shareUrl = await openShare(teacher);
  await teacher.getByRole('button', { name: 'Закрыть', exact: true }).click();

  await student.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(student, 'Student History');
  await student.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitFor('two-peer presence', async () => {
    const teacherCount = Number((await teacher.locator('.presence-summary').textContent())?.trim());
    const studentCount = Number((await student.locator('.presence-summary').textContent())?.trim());
    return teacherCount >= 2 && studentCount >= 2;
  });
  // Presence only proves Ably discovery. Durable edits are intentionally gated until
  // the ordered WebRTC channel has also synchronized the teacher authority head.
  await waitForDurableReady(student, 'student');

  const teacherBlank = await canvasDigest(teacher);
  const studentBlank = await canvasDigest(student);
  await drawStroke(student);

  const revisionAfterDraw = await waitFor('student draw teacher revision', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) >= 1 ? Number(board.revision) : 0;
  });
  await waitFor('student draw converged', async () => {
    const teacherDigest = await canvasDigest(teacher);
    const studentDigest = await canvasDigest(student);
    return teacherDigest !== teacherBlank && studentDigest !== studentBlank && teacherDigest === studentDigest;
  });
  const drawnDigest = await canvasDigest(teacher);

  const undoButton = student.getByRole('button', { name: /Отменить/ });
  await waitFor('student undo enabled', async () => !(await undoButton.isDisabled()));
  await undoButton.click();

  const revisionAfterUndo = await waitFor('student undo teacher revision', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) > revisionAfterDraw ? Number(board.revision) : 0;
  });
  await waitFor('student undo converged on both canvases', async () => (
    (await canvasDigest(teacher)) === teacherBlank
    && (await canvasDigest(student)) === studentBlank
  ));

  const redoButton = student.getByRole('button', { name: /Вернуть/ });
  await waitFor('student redo enabled', async () => !(await redoButton.isDisabled()));
  await redoButton.click();

  const revisionAfterRedo = await waitFor('student redo teacher revision', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) > revisionAfterUndo ? Number(board.revision) : 0;
  });
  await waitFor('student redo converged on both canvases', async () => (
    (await canvasDigest(teacher)) === drawnDigest
    && (await canvasDigest(student)) === drawnDigest
  ));

  console.log(JSON.stringify({
    ok: true,
    boardId,
    revisionAfterDraw,
    revisionAfterUndo,
    revisionAfterRedo,
    studentToolbarUndoRedoConverged: true,
    preview: PREVIEW_URL,
  }));
} finally {
  await Promise.allSettled([teacherContext.close(), studentContext.close()]);
  await browser.close();
}
