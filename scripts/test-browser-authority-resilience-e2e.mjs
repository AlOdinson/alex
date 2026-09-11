import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const PREVIEW_URL = process.env.BROWSER_AUTHORITY_PREVIEW_URL
  ?? 'https://alodinson.github.io/alex/preview-browser-authority/';
const TIMEOUT_MS = 60_000;

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
    };
  }), boardId);
}

async function enterBoardIfNeeded(page, name) {
  const state = await waitFor('participant name gate or board canvas', async () => {
    if (await page.locator('canvas.upper-canvas').isVisible().catch(() => false)) return 'canvas';
    if (await page.getByLabel('Ваше имя').isVisible().catch(() => false)) return 'name';
    return '';
  }, 15_000);
  if (state !== 'name') return;
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Войти на доску' }).click();
}

async function createOwnerBoard(page, title) {
  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.getByLabel('Название доски').fill(title);
  await page.getByLabel('Ученик').fill('Resilience smoke');
  await Promise.all([
    page.waitForURL(/\/preview-browser-authority\/board\//, { timeout: TIMEOUT_MS }),
    page.getByRole('button', { name: 'Создать доску' }).click(),
  ]);
  await enterBoardIfNeeded(page, 'Teacher resilience');
  await page.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  const boardId = boardIdFromUrl(page.url());
  assert.ok(boardId, 'Could not determine owner board id');
  const board = await waitFor('owner authority board', () => authorityBoard(page, boardId));
  return { boardId, board };
}

async function canvasDigest(page) {
  return page.locator('canvas.lower-canvas').evaluate((canvas) => canvas.toDataURL('image/png'));
}

async function drawStroke(page, offset = 0) {
  await page.getByRole('button', { name: 'Карандаш' }).click();
  const canvas = page.locator('canvas.upper-canvas');
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 240 && box.height > 180, 'Fabric upper canvas has no usable bounds');
  const x1 = box.x + Math.min(box.width - 110, 140 + offset);
  const y1 = box.y + Math.min(box.height - 110, 150 + offset);
  const x2 = Math.min(box.x + box.width - 70, x1 + 120);
  const y2 = Math.min(box.y + box.height - 70, y1 + 45);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 10 });
  await page.mouse.up();
}

async function waitForPresence(teacher, student) {
  return waitFor('teacher/student presence', async () => {
    const teacherCount = Number((await teacher.locator('.presence-summary').textContent())?.trim());
    const studentCount = Number((await student.locator('.presence-summary').textContent())?.trim());
    return teacherCount >= 2 && studentCount >= 2;
  });
}

function attachDiagnostics(page, label) {
  page.on('pageerror', (error) => console.error(`${label} pageerror:`, error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.error(`${label} console ${message.type()}:`, message.text());
    }
  });
  page.on('requestfailed', (request) => {
    console.error(`${label} requestfailed:`, request.url(), request.failure()?.errorText ?? 'unknown');
  });
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  // Scenario 1: only one owner tab may hold teacher authority at a time.
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ownerA = await ownerContext.newPage();
  attachDiagnostics(ownerA, 'owner-a');
  const { boardId: lockBoardId } = await createOwnerBoard(ownerA, `Lock E2E ${Date.now()}`);
  assert.equal(Number((await authorityBoard(ownerA, lockBoardId))?.revision ?? -1), 0);

  const ownerB = await ownerContext.newPage();
  attachDiagnostics(ownerB, 'owner-b');
  await ownerB.goto(ownerA.url(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(ownerB, 'Teacher resilience');
  await ownerB.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await drawStroke(ownerB, 80);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(
    Number((await authorityBoard(ownerB, lockBoardId))?.revision ?? -1),
    0,
    'second owner tab must not durably commit while the first tab owns the Web Lock',
  );

  await ownerA.close();
  const takeoverRevision = await waitFor('second owner tab authority takeover', async () => {
    const revision = Number((await authorityBoard(ownerB, lockBoardId))?.revision ?? 0);
    return revision > 0 ? revision : 0;
  }, 20_000);
  assert.ok(takeoverRevision > 0, 'second owner tab did not take authority after the first tab closed');
  await ownerContext.close();

  // Scenario 2: a real browser offline/online transition must recreate student connectivity and catch up.
  const teacherContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const studentContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  attachDiagnostics(teacher, 'offline-teacher');
  attachDiagnostics(student, 'offline-student');

  const { boardId, board } = await createOwnerBoard(teacher, `Offline E2E ${Date.now()}`);
  const shareUrl = new URL(`board/${encodeURIComponent(boardId)}?key=${encodeURIComponent(board.shareKey)}`, PREVIEW_URL).toString();
  await student.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(student, 'Student offline E2E');
  await student.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForPresence(teacher, student);

  const studentBlank = await canvasDigest(student);
  await drawStroke(teacher, 0);
  const revisionBeforeOffline = await waitFor('initial durable revision', async () => {
    const revision = Number((await authorityBoard(teacher, boardId))?.revision ?? 0);
    return revision > 0 ? revision : 0;
  });
  await waitFor('initial teacher edit on student', async () => (await canvasDigest(student)) !== studentBlank);

  await studentContext.setOffline(true);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await drawStroke(teacher, 150);
  const revisionWhileOffline = await waitFor('teacher commit while student offline', async () => {
    const revision = Number((await authorityBoard(teacher, boardId))?.revision ?? 0);
    return revision > revisionBeforeOffline ? revision : 0;
  });
  const teacherWhileOffline = await canvasDigest(teacher);

  await studentContext.setOffline(false);
  await waitForPresence(teacher, student);
  await waitFor('student catch-up after offline reconnect', async () => (
    (await canvasDigest(student)) === teacherWhileOffline
  ), 30_000);

  const teacherBeforeStudentEdit = await canvasDigest(teacher);
  await drawStroke(student, 240);
  const revisionAfterStudentReconnectEdit = await waitFor('student durable edit after offline reconnect', async () => {
    const revision = Number((await authorityBoard(teacher, boardId))?.revision ?? 0);
    return revision > revisionWhileOffline ? revision : 0;
  }, 30_000);
  await waitFor('student reconnect edit rendered on teacher', async () => (
    (await canvasDigest(teacher)) !== teacherBeforeStudentEdit
  ));

  console.log(JSON.stringify({
    ok: true,
    secondOwnerBlocked: true,
    takeoverRevision,
    offlineReconnect: true,
    revisionBeforeOffline,
    revisionWhileOffline,
    revisionAfterStudentReconnectEdit,
    preview: PREVIEW_URL,
  }));

  await Promise.allSettled([teacherContext.close(), studentContext.close()]);
} finally {
  await browser.close();
}
