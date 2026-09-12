import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const PREVIEW_URL = process.env.BROWSER_AUTHORITY_PREVIEW_URL
  ?? 'https://alodinson.github.io/alex/preview-browser-authority/';
const TIMEOUT_MS = 120_000;
const FILLER_STROKES = 260;
const EXPECTED_TEACHER_REVISIONS = FILLER_STROKES + 1;

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
    await new Promise((resolve) => setTimeout(resolve, 200));
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

async function authorityCommits(page, boardId) {
  return page.evaluate(async (id) => new Promise((resolve, reject) => {
    const request = indexedDB.open('alex-board-authority');
    request.onerror = () => reject(request.error ?? new Error('Could not open authority IndexedDB'));
    request.onsuccess = () => {
      const db = request.result;
      try {
        const store = db.transaction('commits', 'readonly').objectStore('commits');
        const index = store.index('boardRevision');
        const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
        const cursorRequest = index.openCursor(range, 'next');
        const commits = [];
        cursorRequest.onerror = () => {
          db.close();
          reject(cursorRequest.error ?? new Error('Could not read authority commits'));
        };
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            db.close();
            resolve(commits);
            return;
          }
          commits.push(cursor.value);
          cursor.continue();
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
  }, 15_000);
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

async function canvasRegionSignature(page, point, radius = 22) {
  return page.locator('canvas.lower-canvas').evaluate((canvas, args) => {
    const context = canvas.getContext('2d');
    const scaleX = canvas.width / Math.max(1, canvas.clientWidth);
    const scaleY = canvas.height / Math.max(1, canvas.clientHeight);
    const left = Math.max(0, Math.round((args.point.x - args.radius) * scaleX));
    const top = Math.max(0, Math.round((args.point.y - args.radius) * scaleY));
    const width = Math.max(1, Math.min(canvas.width - left, Math.round(args.radius * 2 * scaleX)));
    const height = Math.max(1, Math.min(canvas.height - top, Math.round(args.radius * 2 * scaleY)));
    const data = context.getImageData(left, top, width, height).data;
    let hash = 2166136261;
    for (let index = 0; index < data.length; index += 1) {
      hash ^= data[index];
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${width}x${height}:${hash}`;
  }, { point, radius });
}

async function waitForMatchingCanvases(teacher, student, label, expectedDigest = null) {
  return waitFor(label, async () => {
    const [teacherDigest, studentDigest] = await Promise.all([
      canvasDigest(teacher),
      canvasDigest(student),
    ]);
    if (teacherDigest !== studentDigest) return false;
    if (expectedDigest != null && teacherDigest !== expectedDigest) return false;
    return teacherDigest;
  });
}

async function drawOneStroke(page, start, end, steps = 3) {
  const canvas = page.locator('canvas.upper-canvas');
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 900 && box.height > 550, 'Fabric canvas has no usable bounds');
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y, { steps });
  await page.mouse.up();
}

async function eraseAt(page, point) {
  await page.getByRole('button', { name: 'Ластик' }).click();
  const canvas = page.locator('canvas.upper-canvas');
  const box = await canvas.boundingBox();
  assert.ok(box, 'Fabric canvas has no bounds for eraser');
  await page.mouse.move(box.x + point.x, box.y + point.y);
  await page.mouse.down();
  await page.mouse.up();
}

async function openShare(page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Поделиться', exact: true }).click();
  const input = page.locator('.share-dialog .copy-row input');
  const url = await waitFor('student share URL', async () => {
    const value = await input.inputValue();
    return value.includes('/board/') && value.includes('?key=') ? value : '';
  });
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  return url;
}

async function clearTeacherBoard(page) {
  page.once('dialog', async (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Очистить доску', exact: true }).click();
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
  await teacher.getByLabel('Название доски').fill(`Large snapshot truth ${Date.now()}`);
  await teacher.getByLabel('Ученик').fill('Large snapshot student');
  await Promise.all([
    teacher.waitForURL(/\/board\//, { timeout: TIMEOUT_MS }),
    teacher.getByRole('button', { name: 'Создать доску' }).click(),
  ]);
  await enterBoardIfNeeded(teacher, 'Teacher Large Truth');
  await teacher.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(teacher, 'teacher');

  const boardId = boardIdFromUrl(teacher.url());
  assert.ok(boardId, 'Could not determine board id');
  const blankDigest = await canvasDigest(teacher);
  const targetMidpoint = { x: 235, y: 195 };
  const blankTargetRegion = await canvasRegionSignature(teacher, targetMidpoint);

  await teacher.getByRole('button', { name: 'Карандаш' }).click();
  await drawOneStroke(teacher, { x: 170, y: 165 }, { x: 300, y: 225 }, 8);

  // More than the teacher peer hub's 256-commit journal window forces initial student
  // synchronization through a full snapshot transfer instead of the ordinary journal path.
  for (let index = 0; index < FILLER_STROKES; index += 1) {
    const column = index % 26;
    const row = Math.floor(index / 26);
    const x = 410 + column * 25;
    const y = 105 + row * 42;
    await drawOneStroke(teacher, { x, y }, { x: x + 13, y: y + 8 }, 2);
  }

  // Drawing is intentionally much faster than durable IndexedDB commits. Wait for
  // every teacher stroke to reach authority before opening the student; otherwise a
  // trailing teacher commit can be mistaken for the student's eraser commit below.
  const revisionBeforeStudent = await waitFor('complete large teacher authority head', async () => {
    const revision = Number((await authorityBoard(teacher, boardId))?.revision ?? 0);
    return revision >= EXPECTED_TEACHER_REVISIONS ? revision : 0;
  });
  assert.ok(revisionBeforeStudent > 256, 'test did not force the full-snapshot sync threshold');

  const populatedDigest = await canvasDigest(teacher);
  const populatedTargetRegion = await canvasRegionSignature(teacher, targetMidpoint);
  assert.notEqual(populatedDigest, blankDigest, 'large teacher board stayed blank');
  assert.notEqual(populatedTargetRegion, blankTargetRegion, 'teacher target stroke was not painted');

  const shareUrl = await openShare(teacher);
  await student.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(student, 'Student Large Truth');
  await student.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(student, 'student large-board first open');
  await waitForMatchingCanvases(
    teacher,
    student,
    'student received every historical object through full snapshot transfer',
    populatedDigest,
  );

  await eraseAt(student, targetMidpoint);
  const eraseCommit = await waitFor('student authoritative delete after full snapshot bootstrap', async () => {
    const commits = await authorityCommits(teacher, boardId);
    return commits.find((commit) => (
      Number(commit?.revision) > revisionBeforeStudent
      && commit?.ops?.some((op) => op?.type === 'delete')
    )) ?? null;
  });
  const revisionAfterErase = Number(eraseCommit?.revision ?? 0);
  assert.ok(revisionAfterErase > revisionBeforeStudent,
    'student eraser did not advance authority with a delete after full snapshot bootstrap');

  await waitFor('teacher and student both cleared target after student erase', async () => {
    const [teacherRegion, studentRegion] = await Promise.all([
      canvasRegionSignature(teacher, targetMidpoint),
      canvasRegionSignature(student, targetMidpoint),
    ]);
    return teacherRegion === blankTargetRegion && studentRegion === blankTargetRegion;
  });

  const undoButton = student.getByRole('button', { name: /Отменить/ });
  await waitFor('student undo enabled after cross-author erase', async () => !(await undoButton.isDisabled()));
  await undoButton.click();
  const revisionAfterUndo = await waitFor('student undo restored teacher object authoritatively', async () => {
    const revision = Number((await authorityBoard(teacher, boardId))?.revision ?? 0);
    return revision > revisionAfterErase ? revision : 0;
  });
  await waitFor('erase undo restored the same target on both participants', async () => {
    const [teacherRegion, studentRegion] = await Promise.all([
      canvasRegionSignature(teacher, targetMidpoint),
      canvasRegionSignature(student, targetMidpoint),
    ]);
    return teacherRegion === populatedTargetRegion && studentRegion === populatedTargetRegion;
  });

  const redoButton = student.getByRole('button', { name: /Повторить/ });
  await waitFor('student redo enabled after cross-author erase undo', async () => !(await redoButton.isDisabled()));
  await redoButton.click();
  const revisionAfterRedo = await waitFor('student redo re-deleted teacher object authoritatively', async () => {
    const revision = Number((await authorityBoard(teacher, boardId))?.revision ?? 0);
    return revision > revisionAfterUndo ? revision : 0;
  });
  await waitFor('erase redo cleared the target on both participants', async () => {
    const [teacherRegion, studentRegion] = await Promise.all([
      canvasRegionSignature(teacher, targetMidpoint),
      canvasRegionSignature(student, targetMidpoint),
    ]);
    return teacherRegion === blankTargetRegion && studentRegion === blankTargetRegion;
  });

  await clearTeacherBoard(teacher);
  const revisionAfterClear = await waitFor('canonical teacher clear reached authority', async () => {
    const revision = Number((await authorityBoard(teacher, boardId))?.revision ?? 0);
    return revision > revisionAfterRedo ? revision : 0;
  });
  await waitForMatchingCanvases(
    teacher,
    student,
    'canonical clear removed all visible authority objects on both participants',
    blankDigest,
  );

  // Reload both ends after the clear. No deleted historical object may be reconstructed
  // from an old cache, a compacted snapshot, or a peer replica.
  await student.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(student, 'Student Large Truth');
  await student.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(student, 'student after clear reload');

  await teacher.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(teacher, 'Teacher Large Truth');
  await teacher.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(teacher, 'teacher after clear reload');
  await waitForMatchingCanvases(
    teacher,
    student,
    'no historical remnants returned after both sides reloaded',
    blankDigest,
  );

  console.log(JSON.stringify({
    ok: true,
    boardId,
    forcedSnapshotThreshold: revisionBeforeStudent,
    fillerStrokes: FILLER_STROKES,
    revisionAfterErase,
    revisionAfterUndo,
    revisionAfterRedo,
    revisionAfterClear,
    crossAuthorEraseUndoRedoConverged: true,
    clearReloadStayedBlank: true,
    preview: PREVIEW_URL,
  }));
} finally {
  await Promise.allSettled([teacherContext.close(), studentContext.close()]);
  await browser.close();
}
