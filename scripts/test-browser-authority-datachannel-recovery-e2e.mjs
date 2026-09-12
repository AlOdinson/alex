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

async function authorityObjectIds(page, boardId) {
  return page.evaluate(async (id) => new Promise((resolve, reject) => {
    const request = indexedDB.open('alex-board-authority');
    request.onerror = () => reject(request.error ?? new Error('Could not open authority IndexedDB'));
    request.onsuccess = () => {
      const db = request.result;
      try {
        const tx = db.transaction(['boards', 'commits'], 'readonly');
        const boardRequest = tx.objectStore('boards').get(id);
        boardRequest.onerror = () => {
          db.close();
          reject(boardRequest.error ?? new Error('Could not read authority board'));
        };
        boardRequest.onsuccess = () => {
          const board = boardRequest.result;
          if (!board) {
            db.close();
            resolve([]);
            return;
          }

          const ids = new Set((board?.snapshot?.canvas?.objects ?? [])
            .map((object) => String(object?.boardObjectId ?? ''))
            .filter(Boolean));
          const snapshotRevision = Math.max(0, Number(board.snapshotRevision ?? 0) || 0);
          const headRevision = Math.max(snapshotRevision, Number(board.revision ?? snapshotRevision) || snapshotRevision);
          if (snapshotRevision >= headRevision) {
            db.close();
            resolve([...ids].sort());
            return;
          }

          const index = tx.objectStore('commits').index('boardRevision');
          const range = IDBKeyRange.bound(
            [id, snapshotRevision + 1],
            [id, headRevision],
          );
          const cursorRequest = index.openCursor(range, 'next');
          cursorRequest.onerror = () => {
            db.close();
            reject(cursorRequest.error ?? new Error('Could not materialize authority journal'));
          };
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              db.close();
              resolve([...ids].sort());
              return;
            }
            const commit = cursor.value;
            for (const op of Array.isArray(commit?.ops) ? commit.ops : []) {
              if (op?.type === 'delete' && op.id) {
                ids.delete(String(op.id));
              } else if (op?.type === 'upsert' && op.object?.boardObjectId) {
                ids.add(String(op.object.boardObjectId));
              }
            }
            cursor.continue();
          };
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

async function waitForMatchingCanvases(teacher, student, label) {
  return waitFor(label, async () => {
    const [teacherDigest, studentDigest] = await Promise.all([
      canvasDigest(teacher),
      canvasDigest(student),
    ]);
    return teacherDigest === studentDigest ? teacherDigest : false;
  }, 30_000);
}

async function drawStroke(page, offset = 0) {
  await page.getByRole('button', { name: 'Карандаш' }).click();
  const canvas = page.locator('canvas.upper-canvas');
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 300 && box.height > 240, 'Fabric canvas has no usable bounds');
  const x1 = box.x + Math.min(box.width - 220, 150 + offset);
  const y1 = box.y + Math.min(box.height - 170, 150 + Math.floor(offset / 3));
  const x2 = Math.min(box.x + box.width - 80, x1 + 125);
  const y2 = Math.min(box.y + box.height - 80, y1 + 45);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
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

async function openDataChannelCount(page) {
  return page.evaluate(() => (
    (window.__alexTestDataChannels ?? []).filter((channel) => channel?.readyState === 'open').length
  ));
}

async function totalDataChannelCount(page) {
  return page.evaluate(() => (window.__alexTestDataChannels ?? []).length);
}

async function closeCurrentDurableChannel(page) {
  return page.evaluate(() => {
    const channels = window.__alexTestDataChannels ?? [];
    const channel = [...channels].reverse().find((candidate) => candidate?.readyState === 'open');
    if (!channel) throw new Error('No open durable RTCDataChannel found');
    const index = channels.indexOf(channel);
    channel.close();
    return { index, label: channel.label, readyState: channel.readyState };
  });
}

async function runtimeEventCount(page) {
  return page.evaluate(() => (window.__alexTestRuntimeStates ?? []).length);
}

async function waitForRecoveryCycle(page, fromIndex, previousChannelCount, label) {
  await waitFor(`${label} left durable ready state`, async () => page.evaluate((start) => {
    const events = (window.__alexTestRuntimeStates ?? []).slice(start);
    return events.some((entry) => entry?.state === 'waiting' || entry?.state === 'error' || entry?.state === 'closed');
  }, fromIndex), 15_000);

  await waitFor(`${label} created replacement datachannel`, async () => (
    (await totalDataChannelCount(page)) > previousChannelCount
      && (await openDataChannelCount(page)) >= 1
  ), 30_000);

  await waitForDurableReady(page, `${label} recovered`);

  await waitFor(`${label} emitted ready after recovery`, async () => page.evaluate((start) => {
    const events = (window.__alexTestRuntimeStates ?? []).slice(start);
    const waitingIndex = events.findIndex((entry) => entry?.state === 'waiting' || entry?.state === 'error' || entry?.state === 'closed');
    if (waitingIndex < 0) return false;
    return events.slice(waitingIndex + 1).some((entry) => entry?.state === 'ready');
  }, fromIndex), 30_000);
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const teacherContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const studentContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });

await studentContext.addInitScript(() => {
  window.__alexTestDataChannels = [];
  window.__alexTestRuntimeStates = [];
  window.addEventListener('alex-board-runtime-state', (event) => {
    window.__alexTestRuntimeStates.push({
      state: event?.detail?.state ?? '',
      at: Date.now(),
      teacherId: event?.detail?.teacherId ?? '',
      error: event?.detail?.error ?? null,
    });
  });

  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  if (!OriginalRTCPeerConnection) return;

  const remember = (channel) => {
    if (channel && !window.__alexTestDataChannels.includes(channel)) {
      window.__alexTestDataChannels.push(channel);
    }
    return channel;
  };

  class TrackedRTCPeerConnection extends OriginalRTCPeerConnection {
    constructor(...args) {
      super(...args);
      this.addEventListener('datachannel', (event) => remember(event.channel));
    }

    createDataChannel(...args) {
      return remember(super.createDataChannel(...args));
    }
  }

  window.RTCPeerConnection = TrackedRTCPeerConnection;
});

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
  await teacher.getByLabel('Название доски').fill(`DataChannel recovery E2E ${Date.now()}`);
  await teacher.getByLabel('Ученик').fill('Recovery smoke');
  await Promise.all([
    teacher.waitForURL(/\/board\//, { timeout: TIMEOUT_MS }),
    teacher.getByRole('button', { name: 'Создать доску' }).click(),
  ]);
  await enterBoardIfNeeded(teacher, 'Teacher channel recovery');
  await teacher.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(teacher, 'teacher');

  const boardId = boardIdFromUrl(teacher.url());
  assert.ok(boardId, 'Could not determine board id');
  await waitFor('fresh authority board', async () => {
    const board = await authorityBoard(teacher, boardId);
    return Number(board?.revision ?? -1) === 0 ? board : null;
  });

  const shareUrl = await openShare(teacher);
  await student.goto(shareUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(student, 'Student channel recovery');
  await student.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(student, 'student initial');
  await waitFor('student has open durable datachannel', async () => (await openDataChannelCount(student)) >= 1);

  let previousRevision = 0;
  let previousChannelCount = await totalDataChannelCount(student);
  const rounds = [];

  for (let round = 0; round < 2; round += 1) {
    const runtimeStart = await runtimeEventCount(student);
    const closedChannel = await closeCurrentDurableChannel(student);

    // Commit authority work immediately after the durable channel is severed. The
    // student must not silently diverge; the replacement channel/snapshot must catch up.
    await drawStroke(teacher, round * 190);
    const teacherRevision = await waitFor(`teacher revision after channel drop ${round + 1}`, async () => {
      const revision = Number((await authorityBoard(teacher, boardId))?.revision ?? 0);
      return revision > previousRevision ? revision : 0;
    });

    await waitForRecoveryCycle(
      student,
      runtimeStart,
      previousChannelCount,
      `channel recovery round ${round + 1}`,
    );
    await waitForMatchingCanvases(
      teacher,
      student,
      `student caught up authority after silent channel drop ${round + 1}`,
    );

    const beforeStudentEdit = await canvasDigest(teacher);
    const beforeStudentEditIds = await authorityObjectIds(teacher, boardId);
    await drawStroke(student, 90 + round * 190);
    const studentRevision = await waitFor(`student edit revision after recovery ${round + 1}`, async () => {
      const revision = Number((await authorityBoard(teacher, boardId))?.revision ?? 0);
      return revision > teacherRevision ? revision : 0;
    });
    const afterStudentEdit = await waitForMatchingCanvases(
      teacher,
      student,
      `student edit converged after recovery ${round + 1}`,
    );
    assert.notEqual(afterStudentEdit, beforeStudentEdit, 'post-recovery student edit did not alter authority canvas');

    const afterStudentEditIds = await authorityObjectIds(teacher, boardId);
    assert.equal(afterStudentEditIds.length, beforeStudentEditIds.length + 1, 'post-recovery student edit did not add one authority object');

    const undoButton = student.getByRole('button', { name: /Отменить/ });
    await waitFor(`student undo enabled after recovery ${round + 1}`, async () => !(await undoButton.isDisabled()));
    await undoButton.click();
    const undoRevision = await waitFor(`student undo revision after recovery ${round + 1}`, async () => {
      const revision = Number((await authorityBoard(teacher, boardId))?.revision ?? 0);
      return revision > studentRevision ? revision : 0;
    });
    await waitForMatchingCanvases(
      teacher,
      student,
      `student undo converged after recovery ${round + 1}`,
    );
    const afterUndoIds = await authorityObjectIds(teacher, boardId);
    assert.deepEqual(afterUndoIds, beforeStudentEditIds, 'post-recovery undo did not restore the pre-edit authority object set');

    previousRevision = undoRevision;
    previousChannelCount = await totalDataChannelCount(student);
    rounds.push({
      round: round + 1,
      closedChannel,
      teacherRevision,
      studentRevision,
      undoRevision,
      channelCount: previousChannelCount,
    });
  }

  // Reload both replicas at the end so a successful transient recovery cannot hide a
  // bad durable head. Both browsers must reconstruct the same authority truth again.
  await student.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(student, 'Student channel recovery');
  await student.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(student, 'student final reload');

  await teacher.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await enterBoardIfNeeded(teacher, 'Teacher channel recovery');
  await teacher.locator('canvas.upper-canvas').waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await waitForDurableReady(teacher, 'teacher final reload');
  await waitForMatchingCanvases(teacher, student, 'final reload converged to authority truth');

  console.log(JSON.stringify({
    ok: true,
    boardId,
    silentDataChannelDrops: rounds.length,
    rounds,
    finalRevision: Number((await authorityBoard(teacher, boardId))?.revision ?? 0),
    finalReloadConverged: true,
    preview: PREVIEW_URL,
  }));
} finally {
  await Promise.allSettled([teacherContext.close(), studentContext.close()]);
  await browser.close();
}
