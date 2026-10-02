import { createVerificationBudget, verificationDigest } from './boundedVerificationDigest.js';
import { isSerializedNotebook } from './notebookOperations.js';
import { freezeNotebookRecord, isImmutableNotebookRecord } from './notebookRecords.js';

const hashPattern = /^[a-f0-9]{64}$/;
export const validNotebookFingerprint = value => value?.version === 1 && hashPattern.test(value.frameHash ?? '')
  && Array.isArray(value.pageHashes) && value.pageHashes.every(hash => hashPattern.test(hash));
const frameOf = notebook => { const { notebookPages, ...frame } = notebook; return frame; };

export function createNotebookVerificationCache() {
  const children = new WeakMap(), pages = new WeakMap();
  const pageHash = async (page, options = {}) => {
    const budget = options.budget ?? createVerificationBudget(options);
    budget.assertCurrent();
    if (!Array.isArray(page)) throw new TypeError('Invalid notebook verification page');
    if (isImmutableNotebookRecord(page) && pages.has(page)) return pages.get(page);
    const hashes = [];
    for (const child of page) {
      let hash = isImmutableNotebookRecord(child) ? children.get(child) : null;
      if (!hash) {
        hash = await verificationDigest(child, { budget });
        if (isImmutableNotebookRecord(child)) children.set(child, hash);
      }
      hashes.push(hash);
      const pause = budget.checkpoint(); if (pause) await pause;
    }
    const hash = await verificationDigest({ domain: 'notebook-page-v1', children: hashes }, { budget });
    if (isImmutableNotebookRecord(page)) pages.set(page, hash);
    return hash;
  };
  return {
    pageHash,
    async fingerprint(record, options = {}) {
      const budget = options.budget ?? createVerificationBudget(options);
      budget.assertCurrent();
      if (!isSerializedNotebook(record?.object)) return { hash: await verificationDigest(record, { budget }) };
      const frameHash = await verificationDigest(frameOf(record.object), { budget });
      const pageHashes = [];
      for (const page of record.object.notebookPages) {
        pageHashes.push(await pageHash(page, { budget }));
        const pause = budget.checkpoint(); if (pause) await pause;
      }
      const notebook = { version: 1, frameHash, pageHashes };
      return { hash: await verificationDigest({ domain: 'notebook-record-v1', id: record.id, zIndex: record.zIndex, notebook }, { budget }), notebook };
    },
  };
}

export function createNotebookVerificationRepair(record, actual, expected) {
  if (!isSerializedNotebook(record?.object) || !validNotebookFingerprint(actual) || !validNotebookFingerprint(expected)) return record;
  const pages = [];
  for (let index = 0; index < expected.pageHashes.length; index++) {
    if (actual.pageHashes[index] !== expected.pageHashes[index]) pages.push({ pageNumber: index + 1, objects: record.object.notebookPages[index] });
  }
  return { ...record, object: frameOf(record.object), notebookRepair: { version: 1, pageCount: expected.pageHashes.length, pages } };
}

export function validNotebookVerificationRepair(record) {
  const repair = record?.notebookRepair;
  return repair?.version === 1 && String(record.object?.type ?? '').toLowerCase() === 'boardnotebook'
    && !Object.hasOwn(record.object, 'notebookPages')
    && Number.isSafeInteger(repair.pageCount) && repair.pageCount >= 0
    && Array.isArray(repair.pages) && new Set(repair.pages.map(page => page?.pageNumber)).size === repair.pages.length
    && repair.pages.every(page => Number.isSafeInteger(page?.pageNumber) && page.pageNumber >= 1 && page.pageNumber <= repair.pageCount
      && Array.isArray(page.objects) && page.objects.every(child => child && typeof child === 'object' && typeof child.boardObjectId === 'string' && child.boardObjectId)
      && new Set(page.objects.map(child => child.boardObjectId)).size === page.objects.length);
}

export function applyNotebookVerificationRepair(current, record) {
  if (!isSerializedNotebook(current) || !validNotebookVerificationRepair(record)) return null;
  const { pageCount, pages: changes } = record.notebookRepair;
  // Every new page needs actual data. This also rejects malicious sparse growth
  // before allocating or traversing a huge attacker-controlled page count.
  if (pageCount > current.notebookPages.length + changes.length) return null;
  const byNumber = new Map(changes.map(page => [page.pageNumber, page]));
  for (let page = current.notebookPages.length + 1; page <= pageCount; page++) if (!byNumber.has(page)) return null;
  let pages = current.notebookPages;
  if (changes.length || pageCount !== pages.length) {
    pages = pages.slice(0, pageCount);
    for (const change of changes) pages[change.pageNumber - 1] = freezeNotebookRecord(structuredClone(change.objects));
    Object.freeze(pages);
  }
  return { ...structuredClone(record.object), notebookPages: pages };
}
