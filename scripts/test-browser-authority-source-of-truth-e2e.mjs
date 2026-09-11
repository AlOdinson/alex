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
  return waitFor(`${label} durable runtime ready`, async () => page.evaluate(() => {
    const dataset = document.documentElement?.dataset ?? {};
    return dataset.alexDurableEditState === 'ready'
      && dataset.alexDurableEditBlocked !== 'true';
  }));
}

async function canvasDigest(page) {
  return page.locator('canvas.lower-canvas').evaluate((canvas) => canvas.toDataURL('image/png'));
}

async function canvasObjectCount(page) {
  return page.locator('canvas.upper-canvas').evaluate((canvas) => {
    const instance = canvas?.__fabric;
    if (instance?.getObjects) return instance.getObjects().filter((object) => !object?.transientPreview).length;
    return null;
  }).catch(() => null);
}

async function drawStroke(page, { x = 180, y = 180, dx = 150, dy = 60 } = {}) {
  await page.getByRole('button', { name: 'Карандаш' }).click();
  const canvas = page.locator('canvas.upper-canvas');
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 300 && box.height > 240, 'Fabric canvas has no usable bounds');
  const x1 = box.x + x;
  const y1 = box.y + y;
  const x2 = Math.min(box.x + box.width - 80, x1 + dx);
  const y2 = Math.min(box.y + box.height - 80, y1 + dy);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 14 });
  await page.mouse.up();
  return {
    midpoint: {
      x: (x1 + x2) / 2 - box.x,
      y: (y1 + y2) / 2 - box.y,
    },
  };
}

async function eraseAt(page, point) {
  await page.getByRole('button', { name: 'Ластик' }).click();
  const canvas = page.locator('canvas.upper-canvas');
  const box = await canvas.boundingBox();
  assert.ok(box, 'Fabric canvas has no bounds for eraser');
  const x = box.x + point.x;
  const y = box.y + point.y;
  await page.mouse.move(x, y);
  await page.mouse.down();
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

async function waitForMatchingCanvases(teacher, student, label, expectedDigest = null) {
  return waitFor(label, async () => {
    const teacherDigest = await canvasDigest(teacher);
    const studentDigest = await canvasDigest(student);
    if (teacherDigest !== studentDigest) return false;
    if (expectedDigest != null && teacherDigest !== expectedDigest) return false;
    return teacherDigest;
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
  page.on('requestfailed', (request) => {
    console.error(`${label} requestfailed:`, request.url(), request.failure()?.errorText ?? 'unknown');
  });
}

try {
  await teacher.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await teacher.getByLabel('Название доски').fill(`Source of truth E2E ${Date.now()}`);
  await teacher.getByLabel('Ученик').fill('Convergence smoke');
  await Promise.all([
    teacher.waitForURL(/\/board\//, { timeout: TIMEOUT_MS }),
    teacher.getByRole('button', { name: 'Создать доску' }).click(),
  ]);
  await enterBoardIfNeeded(teacher, 'Teacher Truth');
  await teacher.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(teacher, 'teacher');

  const boardId = boardIdFromUrl(teacher.url());
  assert.ok(boardId, 'Could not determine board id');
  await waitFor('fresh authority board', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? -1) === 0 ? board : null;
  });

  const blankDigest = await canvasDigest(teacher);
  const firstStroke = await drawStroke(teacher, { x: 170, y: 180, dx: 150, dy: 60 });
  await drawStroke(teacher, { x: 520, y: 310, dx: 140, dy: -45 });
  const revisionAfterTeacherDraws = await waitFor('two teacher strokes committed', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) >= 2 ? Number(board.revision) : 0;
  });
  assert.ok(revisionAfterTeacherDraws >= 2);
  const populatedDigest = await canvasDigest(teacher);
  assert.notEqual(populatedDigest, blankDigest, 'teacher board stayed blank after durable strokes');

  // The student first opens only after the teacher board is already populated. This
  // verifies that no cached/empty replica becomes editable before authority bootstrap.
  const shareUrl = await openShare(teacher);
  await teacher.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await student.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(student, 'Student Truth');
  await student.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(student, 'student first open');
  await waitForMatchingCanvases(
    teacher,
    student,
    'student first open received complete teacher truth',
    populatedDigest,
  );

  // Reload an already-populated student board. It must remain gated until it has the
  // current teacher head/snapshot and must never expose a partial local canvas as ready.
  await student.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(student, 'Student Truth');
  await student.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(student, 'student reload');
  await waitForMatchingCanvases(
    teacher,
    student,
    'student reload restored complete teacher truth',
    populatedDigest,
  );

  // A student in edit mode may delete any board object, including one created by the
  // teacher. Creator identity is not an ownership boundary; the teacher authority only
  // checks current edit permission, revision conditions and transient locks.
  await eraseAt(student, firstStroke.midpoint);
  const revisionAfterStudentErase = await waitFor('student eraser committed by teacher authority', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) > revisionAfterTeacherDraws ? Number(board.revision) : 0;
  });
  const erasedDigest = await waitForMatchingCanvases(
    teacher,
    student,
    'student eraser deletion converged on teacher and student',
  );
  assert.notEqual(erasedDigest, populatedDigest, 'student eraser did not change the authoritative board');
  assert.notEqual(erasedDigest, blankDigest, 'student eraser removed more than the targeted teacher object');

  const undoButton = student.getByRole('button', { name: /Отменить/ });
  await waitFor('student undo after eraser enabled', async () => !(await undoButton.isDisabled()));
  await undoButton.click();
  const revisionAfterUndo = await waitFor('student eraser undo committed', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) > revisionAfterStudentErase ? Number(board.revision) : 0;
  });
  await waitForMatchingCanvases(
    teacher,
    student,
    'student undo restored teacher object everywhere',
    populatedDigest,
  );

  const redoButton = student.getByRole('button', { name: /Вернуть/ });
  await waitFor('student redo after eraser enabled', async () => !(await redoButton.isDisabled()));
  await redoButton.click();
  const revisionAfterRedo = await waitFor('student eraser redo committed', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) > revisionAfterUndo ? Number(board.revision) : 0;
  });
  await waitForMatchingCanvases(
    teacher,
    student,
    'student redo deletion converged everywhere',
    erasedDigest,
  );

  // Finally reload the authority browser itself. A legacy Fabric/UI compaction must not
  // be able to replace canonical teacher state with a partial snapshot.
  await teacher.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(teacher, 'Teacher Truth');
  await teacher.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(teacher, 'teacher reload');
  await waitFor('teacher reload restored complete authority state', async () => (
    (await canvasDigest(teacher)) === erasedDigest
  ));

  console.log(JSON.stringify({
    ok: true,
    boardId,
    revisionAfterTeacherDraws,
    revisionAfterStudentErase,
    revisionAfterUndo,
    revisionAfterRedo,
    populatedStudentBootstrapConverged: true,
    populatedStudentReloadConverged: true,
    studentErasedTeacherObject: true,
    studentUndoRedoConverged: true,
    teacherReloadPreservedAuthorityTruth: true,
    preview: PREVIEW_URL,
  }));
} finally {
  await Promise.allSettled([teacherContext.close(), studentContext.close()]);
  await browser.close();
}
