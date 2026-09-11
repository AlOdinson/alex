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

async function listAuthorityBoardsInPage(page) {
  return page.evaluate(async () => new Promise((resolve) => {
    const request = indexedDB.open('alex-board-authority');
    request.onerror = () => resolve({ error: String(request.error ?? 'open failed') });
    request.onsuccess = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains('boards')) {
          const stores = [...db.objectStoreNames];
          db.close();
          resolve({ stores, boards: [] });
          return;
        }
        const get = db.transaction('boards', 'readonly').objectStore('boards').getAll();
        get.onerror = () => {
          db.close();
          resolve({ error: String(get.error ?? 'getAll failed') });
        };
        get.onsuccess = () => {
          const result = { stores: [...db.objectStoreNames], boards: get.result ?? [] };
          db.close();
          resolve(result);
        };
      } catch (error) {
        db.close();
        resolve({ error: String(error) });
      }
    };
  }));
}

async function enterBoardIfNeeded(page, name) {
  const state = await waitFor('participant name gate or board canvas', async () => {
    if (await page.locator('canvas.upper-canvas').isVisible().catch(() => false)) return 'canvas';
    if (await page.getByLabel('Ваше имя').isVisible().catch(() => false)) return 'name';
    return '';
  }, 12_000);
  if (state !== 'name') return false;
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Войти на доску' }).click();
  return true;
}

async function waitForCanvasOrDump(page, label) {
  try {
    await page.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  } catch (error) {
    const [bodyText, authorityState] = await Promise.all([
      page.locator('body').innerText().catch(() => '<body unavailable>'),
      listAuthorityBoardsInPage(page).catch((caught) => ({ error: String(caught) })),
    ]);
    console.error(`${label} bootstrap URL:`, page.url());
    console.error(`${label} body:`, bodyText.slice(0, 6000));
    console.error(`${label} authority IndexedDB:`, JSON.stringify(authorityState));
    throw error;
  }
}

async function clickOwnerShareOrDump(page, authorityRecord) {
  try {
    const settings = page.getByRole('button', { name: 'Настройки', exact: true });
    await settings.waitFor({ state: 'visible', timeout: 8_000 });
    await settings.click();

    const shareItem = page.getByRole('menuitem', { name: 'Поделиться', exact: true });
    await shareItem.waitFor({ state: 'visible', timeout: 8_000 });
    await shareItem.click();
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: window.location.href,
      body: document.body?.innerText?.slice(0, 6000) ?? '',
      settingsRoot: (() => {
        const root = document.getElementById('alex-board-settings-root');
        const menu = root?.querySelector('.alex-settings-menu');
        return {
          exists: Boolean(root),
          menuHidden: menu?.hidden ?? null,
          gearExpanded: root?.querySelector('.alex-settings-gear')?.getAttribute('aria-expanded') ?? null,
          shareHidden: root?.querySelector('[data-action="share"]')?.hidden ?? null,
        };
      })(),
      buttons: [...document.querySelectorAll('button')].map((button) => ({
        text: button.innerText,
        ariaLabel: button.getAttribute('aria-label'),
        title: button.getAttribute('title'),
        disabled: button.disabled,
        hidden: button.hidden,
        rect: (() => {
          const rect = button.getBoundingClientRect();
          return { width: rect.width, height: rect.height, x: rect.x, y: rect.y };
        })(),
      })),
    }));
    const urlKey = new URL(page.url()).searchParams.get('key') ?? '';
    console.error('teacher owner-key diagnostic:', JSON.stringify({
      urlKeyMatchesIndexedOwnerKey: urlKey === String(authorityRecord?.ownerKey ?? ''),
      urlKeyLength: urlKey.length,
      indexedOwnerKeyLength: String(authorityRecord?.ownerKey ?? '').length,
      indexedGuestMode: authorityRecord?.guestMode ?? null,
    }));
    console.error('teacher toolbar diagnostic:', JSON.stringify(diagnostic));
    throw error;
  }
}

async function closeShareDialog(page) {
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.locator('.share-dialog').waitFor({ state: 'detached', timeout: 8_000 });
}

async function canvasDigest(page) {
  return page.locator('canvas.lower-canvas').evaluate((canvas) => canvas.toDataURL('image/png'));
}

async function drawStroke(page, offset = 0) {
  await page.getByRole('button', { name: 'Карандаш' }).click();
  const canvas = page.locator('canvas.upper-canvas');
  await canvas.waitFor({ state: 'visible' });
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 240 && box.height > 180, 'Fabric upper canvas has no usable bounds');
  const x1 = box.x + Math.min(box.width - 100, 150 + offset);
  const y1 = box.y + Math.min(box.height - 100, 160 + offset);
  const x2 = Math.min(box.x + box.width - 70, x1 + 130);
  const y2 = Math.min(box.y + box.height - 70, y1 + 55);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
  await page.mouse.up();
}

async function tryDrawStroke(page, offset = 0) {
  const pencil = page.getByRole('button', { name: 'Карандаш' });
  if (await pencil.isDisabled().catch(() => false)) return 'ui-blocked';
  await drawStroke(page, offset);
  return 'attempted';
}

async function uploadTestImage(page) {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120">',
    '<rect width="180" height="120" rx="18" fill="#2563eb"/>',
    '<circle cx="48" cy="58" r="28" fill="#facc15"/>',
    '<path d="M92 32h60v18H92zm0 36h42v18H92z" fill="#ffffff"/>',
    '</svg>',
  ].join('');
  await page.locator('input.image-file-input').setInputFiles({
    name: 'authority-e2e.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(svg),
  });
}

async function blurActiveElement(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
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

try {
  attachDiagnostics(teacher, 'teacher');
  attachDiagnostics(student, 'student');

  await teacher.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await teacher.getByLabel('Название доски').fill(`E2E ${Date.now()}`);
  await teacher.getByLabel('Ученик').fill('Browser smoke');
  await Promise.all([
    teacher.waitForURL(/\/preview-browser-authority\/board\//, { timeout: TIMEOUT_MS }),
    teacher.getByRole('button', { name: 'Создать доску' }).click(),
  ]);
  await enterBoardIfNeeded(teacher, 'Teacher E2E');
  await waitForCanvasOrDump(teacher, 'teacher');

  const boardId = boardIdFromUrl(teacher.url());
  assert.ok(boardId, 'Could not determine created board id');
  const initialBoard = await waitFor('teacher authority board', async () => authorityBoard(teacher, boardId));
  assert.equal(Number(initialBoard.revision ?? -1), 0, 'A fresh board should start at revision 0');

  await clickOwnerShareOrDump(teacher, initialBoard);
  const shareInput = teacher.locator('.share-dialog .copy-row input');
  const shareUrl = await waitFor('derived student share URL', async () => {
    const value = await shareInput.inputValue();
    return value.includes('/preview-browser-authority/board/') && value.includes('?key=') ? value : '';
  });
  await closeShareDialog(teacher);

  await student.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(student, 'Student E2E');
  await waitForCanvasOrDump(student, 'student');

  await waitFor('teacher/student Ably presence', async () => {
    const teacherCount = Number((await teacher.locator('.presence-summary').textContent())?.trim());
    const studentCount = Number((await student.locator('.presence-summary').textContent())?.trim());
    return teacherCount >= 2 && studentCount >= 2;
  });

  const studentBlank = await canvasDigest(student);
  await drawStroke(teacher, 0);
  const revisionAfterTeacher = await waitFor('teacher stroke durable revision', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) >= 1 ? Number(board.revision) : 0;
  });
  assert.ok(revisionAfterTeacher >= 1);

  await waitFor('teacher stroke on student canvas', async () => (await canvasDigest(student)) !== studentBlank);

  const teacherAfterFirst = await canvasDigest(teacher);
  await drawStroke(student, 120);
  const revisionAfterStudent = await waitFor('student stroke persisted by teacher authority', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) > revisionAfterTeacher ? Number(board.revision) : 0;
  });
  assert.ok(revisionAfterStudent > revisionAfterTeacher);

  await waitFor('student authoritative stroke rendered on teacher', async () => (await canvasDigest(teacher)) !== teacherAfterFirst);

  // A page reload destroys the student's in-memory replica. It must reconnect to the
  // live teacher and receive the current authoritative board again over the peer path.
  const teacherBeforeStudentReconnect = await canvasDigest(teacher);
  await student.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(student, 'Student E2E');
  await waitForCanvasOrDump(student, 'student reconnect');
  await waitFor('student presence after reconnect', async () => {
    const teacherCount = Number((await teacher.locator('.presence-summary').textContent())?.trim());
    const studentCount = Number((await student.locator('.presence-summary').textContent())?.trim());
    return teacherCount >= 2 && studentCount >= 2;
  });
  await waitFor('student snapshot restored after reconnect', async () => (
    (await canvasDigest(student)) === teacherBeforeStudentReconnect
  ));

  // Image upload must remain self-contained and durable through the same authority
  // path, then undo/redo must each become new authoritative revisions visible remotely.
  const teacherBeforeImage = await canvasDigest(teacher);
  const studentBeforeImage = await canvasDigest(student);
  await uploadTestImage(teacher);
  const revisionAfterImage = await waitFor('image upload durable revision', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) > revisionAfterStudent ? Number(board.revision) : 0;
  });
  const teacherAfterImage = await waitFor('image rendered on teacher', async () => {
    const digest = await canvasDigest(teacher);
    return digest !== teacherBeforeImage ? digest : '';
  });
  const studentAfterImage = await waitFor('image rendered on student', async () => {
    const digest = await canvasDigest(student);
    return digest !== studentBeforeImage ? digest : '';
  });

  await blurActiveElement(teacher);
  await teacher.keyboard.press('Control+z');
  const revisionAfterUndo = await waitFor('undo durable revision', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) > revisionAfterImage ? Number(board.revision) : 0;
  });
  await waitFor('teacher canvas restored by undo', async () => (
    (await canvasDigest(teacher)) === teacherBeforeImage
  ));
  await waitFor('student canvas restored by undo', async () => (
    (await canvasDigest(student)) === studentBeforeImage
  ));

  await blurActiveElement(teacher);
  await teacher.keyboard.press('Control+Shift+z');
  const revisionAfterRedo = await waitFor('redo durable revision', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) > revisionAfterUndo ? Number(board.revision) : 0;
  });
  await waitFor('teacher image restored by redo', async () => (
    (await canvasDigest(teacher)) === teacherAfterImage
  ));
  await waitFor('student image restored by redo', async () => (
    (await canvasDigest(student)) === studentAfterImage
  ));

  // View-only is authoritative at the teacher. Even if a stale guest UI still offers
  // an editing control, the teacher must reject the proposal and restore the peer to
  // the authoritative snapshot without advancing IndexedDB revision.
  const beforeViewOnly = await authorityBoard(teacher, boardId);
  await clickOwnerShareOrDump(teacher, beforeViewOnly);
  await teacher.getByRole('button', { name: /Только просмотр/ }).click();
  const viewBoard = await waitFor('view-only metadata persisted', async () => {
    const board = await authorityBoard(teacher, boardId);
    return board?.guestMode === 'view' ? board : null;
  });
  assert.equal(viewBoard.guestMode, 'view');
  await closeShareDialog(teacher);

  const revisionBeforeBlockedEdit = Number(viewBoard.revision ?? 0);
  const teacherBeforeBlockedEdit = await canvasDigest(teacher);
  const studentBeforeBlockedEdit = await canvasDigest(student);
  const viewOnlyAttempt = await tryDrawStroke(student, 230);

  await new Promise((resolve) => setTimeout(resolve, 1800));
  const afterBlockedEdit = await authorityBoard(teacher, boardId);
  assert.equal(
    Number(afterBlockedEdit.revision ?? -1),
    revisionBeforeBlockedEdit,
    'View-only student edit must not advance teacher authority revision',
  );
  assert.equal(
    await canvasDigest(teacher),
    teacherBeforeBlockedEdit,
    'View-only student edit must not mutate the teacher canvas',
  );
  if (viewOnlyAttempt === 'attempted') {
    await waitFor('view-only student restored to authoritative canvas', async () => (
      (await canvasDigest(student)) === studentBeforeBlockedEdit
    ), 12_000);
  }

  await teacher.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(teacher, 'Teacher E2E');
  await waitForCanvasOrDump(teacher, 'teacher reload');
  const boardAfterReload = await waitFor('teacher IndexedDB authority after reload', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? 0) >= revisionAfterRedo ? board : null;
  });
  assert.ok(Number(boardAfterReload.revision) >= revisionAfterRedo);
  assert.equal(boardAfterReload.guestMode, 'view');

  console.log(JSON.stringify({
    ok: true,
    boardId,
    revisionAfterTeacher,
    revisionAfterStudent,
    studentReconnect: true,
    revisionAfterImage,
    revisionAfterUndo,
    revisionAfterRedo,
    viewOnlyAttempt,
    viewOnlyRevision: Number(boardAfterReload.revision),
    preview: PREVIEW_URL,
  }));
} finally {
  await Promise.allSettled([teacherContext.close(), studentContext.close()]);
  await browser.close();
}
