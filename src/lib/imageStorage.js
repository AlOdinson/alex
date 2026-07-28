import { randomToken } from './ids.js';
import { isSupabaseConfigured, supabase } from './supabase.js';

const IMAGE_BUCKET = 'board-assets';
const MAX_SIDE = 1800;
const TARGET_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);
const ACCEPTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif']);

function fileExtension(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

export function isHeicFile(file) {
  const extension = fileExtension(file?.name);
  const mime = String(file?.type ?? '').toLowerCase();
  return extension === 'heic'
    || extension === 'heif'
    || mime === 'image/heic'
    || mime === 'image/heif'
    || mime === 'image/heic-sequence'
    || mime === 'image/heif-sequence';
}

export function isAcceptedImageFile(file) {
  if (!file) return false;
  if (String(file.type ?? '').toLowerCase().startsWith('image/')) return true;
  return ACCEPTED_EXTENSIONS.has(fileExtension(file.name));
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Браузер не смог подготовить изображение'));
      },
      type,
      quality,
    );
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    reader.readAsDataURL(blob);
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function withRetryToken(source, attempt) {
  if (!/^https?:/i.test(source) || attempt <= 0) return source;
  const separator = source.includes('?') ? '&' : '?';
  return `${source}${separator}alex_retry=${Date.now()}-${attempt}`;
}

export async function loadImageElement(source, { retries = 8 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const requestSource = withRetryToken(source, attempt);
      // eslint-disable-next-line no-await-in-loop
      return await new Promise((resolve, reject) => {
        const image = new Image();
        if (/^https?:/i.test(requestSource)) image.crossOrigin = 'anonymous';
        image.decoding = 'async';
        image.onload = async () => {
          try {
            if (typeof image.decode === 'function') await image.decode();
          } catch {
            // onload already confirms that the browser can render the image.
          }
          resolve(image);
        };
        image.onerror = () => reject(new Error('Не удалось загрузить изображение'));
        image.src = requestSource;
      });
    } catch (caught) {
      lastError = caught;
      if (attempt < retries) {
        // Public Storage/CDN may briefly return an old cached 404 immediately
        // after an upload. Every retry uses a fresh query token.
        // eslint-disable-next-line no-await-in-loop
        await sleep(Math.min(1800, 260 * (attempt + 1)));
      }
    }
  }
  throw lastError ?? new Error('Не удалось загрузить изображение');
}

async function decodeBlob(blob) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await loadImageElement(objectUrl, { retries: 0 });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function convertHeicToJpeg(file) {
  const { heicTo } = await import('heic-to/csp');
  const result = await heicTo({
    blob: file,
    type: 'image/jpeg',
    quality: 0.92,
  });
  if (Array.isArray(result)) return result[0];
  return result;
}

function chooseOutputType(file, sourceBlob) {
  const extension = fileExtension(file?.name);
  const mime = String(sourceBlob?.type || file?.type || '').toLowerCase();
  if (extension === 'png' || mime === 'image/png') {
    return { contentType: 'image/png', extension: 'png', quality: undefined };
  }
  if (extension === 'webp' || mime === 'image/webp') {
    return { contentType: 'image/webp', extension: 'webp', quality: 0.9 };
  }
  return { contentType: 'image/jpeg', extension: 'jpg', quality: 0.88 };
}

export async function prepareImageForBoard(file) {
  if (!isAcceptedImageFile(file)) {
    throw new Error('Поддерживаются JPG, PNG, WebP, GIF, HEIC и HEIF');
  }

  let sourceBlob = file;
  let convertedFromHeic = false;
  if (isHeicFile(file)) {
    sourceBlob = await convertHeicToJpeg(file);
    convertedFromHeic = true;
  }

  const image = await decodeBlob(sourceBlob);
  const naturalWidth = Number(image.naturalWidth || image.width || 1);
  const naturalHeight = Number(image.naturalHeight || image.height || 1);
  let scale = Math.min(1, MAX_SIDE / Math.max(naturalWidth, naturalHeight));
  let width = Math.max(1, Math.round(naturalWidth * scale));
  let height = Math.max(1, Math.round(naturalHeight * scale));
  const output = chooseOutputType(file, sourceBlob);
  if (convertedFromHeic) {
    output.contentType = 'image/jpeg';
    output.extension = 'jpg';
    output.quality = 0.88;
  }

  let resultBlob = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: output.contentType !== 'image/jpeg' });
    if (!context) throw new Error('Не удалось подготовить изображение');
    if (output.contentType === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    } else {
      context.clearRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0, width, height);
    // eslint-disable-next-line no-await-in-loop
    resultBlob = await canvasToBlob(canvas, output.contentType, output.quality);
    if (resultBlob.size <= TARGET_MAX_BYTES || Math.max(width, height) <= 720) break;
    width = Math.max(320, Math.round(width * 0.82));
    height = Math.max(240, Math.round(height * 0.82));
    if (typeof output.quality === 'number') output.quality = Math.max(0.7, output.quality - 0.05);
  }

  if (!resultBlob) throw new Error('Не удалось подготовить изображение');
  const actualContentType = resultBlob.type || output.contentType;
  const actualExtension = actualContentType === 'image/png'
    ? 'png'
    : actualContentType === 'image/webp'
      ? 'webp'
      : 'jpg';
  return {
    blob: resultBlob,
    contentType: actualContentType,
    extension: actualExtension,
    width,
    height,
    convertedFromHeic,
  };
}

export async function storeBoardImage(boardId, file) {
  const prepared = await prepareImageForBoard(file);

  if (!isSupabaseConfigured) {
    return {
      url: await blobToDataUrl(prepared.blob),
      storagePath: null,
      ...prepared,
    };
  }

  const storagePath = `${boardId}/${Date.now()}-${randomToken(14)}.${prepared.extension}`;
  const { error } = await supabase.storage
    .from(IMAGE_BUCKET)
    .upload(storagePath, prepared.blob, {
      cacheControl: '31536000',
      contentType: prepared.contentType,
      upsert: false,
    });

  if (error) {
    if (/bucket.*not found/i.test(error.message ?? '')) {
      throw new Error('В Supabase не создано хранилище board-assets. Запусти SQL обновления 0.3.7.');
    }
    throw new Error(`Не удалось загрузить изображение: ${error.message}`);
  }

  const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(storagePath);
  const publicUrl = data?.publicUrl;
  if (!publicUrl) throw new Error('Supabase не вернул ссылку на изображение');

  // Store a versioned URL in the board. This prevents another phone/tablet
  // from reusing a cached 404 response for a file that has just been uploaded.
  const separator = publicUrl.includes('?') ? '&' : '?';
  const versionedUrl = `${publicUrl}${separator}v=${Date.now()}`;

  // Verify that the freshly uploaded asset is readable before its URL is
  // committed to the shared board state.
  await loadImageElement(versionedUrl, { retries: 10 });

  return {
    url: versionedUrl,
    storagePath,
    ...prepared,
  };
}

function collectImageSources(value, results) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageSources(item, results));
    return;
  }
  const type = String(value.type ?? '').toLowerCase();
  if ((type === 'image' || value.objectKind === 'image') && typeof value.src === 'string') {
    results.add(value.src);
  }
  Object.values(value).forEach((item) => collectImageSources(item, results));
}

export async function preloadSerializedImages(value) {
  const sources = new Set();
  collectImageSources(value, sources);
  const queue = [...sources];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const source = queue.shift();
      if (!source) continue;
      // eslint-disable-next-line no-await-in-loop
      await loadImageElement(source, { retries: 10 });
    }
  });
  await Promise.all(workers);
}

function collectSerializedImageNodes(value, results) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectSerializedImageNodes(item, results));
    return;
  }
  const type = String(value.type ?? '').toLowerCase();
  if ((type === 'image' || value.objectKind === 'image') && typeof value.src === 'string') {
    results.push(value);
  }
  Object.values(value).forEach((item) => collectSerializedImageNodes(item, results));
}

/**
 * Give cross-board pasted images their own Storage files. This prevents a pasted
 * lesson from depending on the source board's asset folder forever.
 */
export async function copySerializedBoardImages(value, targetBoardId) {
  if (!isSupabaseConfigured) return value;
  const sourceNodes = [];
  collectSerializedImageNodes(value, sourceNodes);
  if (!sourceNodes.length) return value;

  const clone = typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
  const nodes = [];
  collectSerializedImageNodes(clone, nodes);
  const sourceMap = new Map();
  for (const node of nodes) {
    const source = String(node.src ?? '');
    if (!source || sourceMap.has(source)) continue;
    sourceMap.set(source, null);
  }

  const sources = [...sourceMap.keys()];
  const queue = [...sources];
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (queue.length) {
      const source = queue.shift();
      if (!source) continue;
      const response = await fetch(source, { mode: 'cors', cache: 'force-cache' });
      if (!response.ok) throw new Error(`Не удалось скопировать изображение (${response.status})`);
      const blob = await response.blob();
      const extension = blob.type === 'image/png'
        ? 'png'
        : blob.type === 'image/webp'
          ? 'webp'
          : 'jpg';
      const file = new File([blob], `copied-image.${extension}`, {
        type: blob.type || `image/${extension === 'jpg' ? 'jpeg' : extension}`,
      });
      // eslint-disable-next-line no-await-in-loop
      const stored = await storeBoardImage(targetBoardId, file);
      sourceMap.set(source, stored);
    }
  });
  await Promise.all(workers);

  nodes.forEach((node) => {
    const stored = sourceMap.get(String(node.src ?? ''));
    if (!stored) return;
    node.src = stored.url;
    node.storagePath = stored.storagePath;
  });
  return clone;
}
