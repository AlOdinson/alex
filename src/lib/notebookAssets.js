import { FabricImage } from 'fabric';

// Only notebook-owned immutable bitmap sources opt into memoization. Ordinary
// images, video, GIF/PDF, filters and the global Fabric prototype are untouched.
// Inline strings retain the existing checkpoint/export and shared-asset lifecycle;
// this introduces neither another asset store nor an unreadable file migration.
const installed = new WeakSet(), sources = new WeakMap();
export function memoizeImmutableNotebookImage(image) {
  if (!(image instanceof FabricImage) || installed.has(image)) return image;
  const original = image.getSrc;
  image.getSrc = function getImmutableSource(filtered) {
    if (filtered) return original.call(this, true);
    const element = this._originalElement;
    if (!element?.toDataURL) return original.call(this, false);
    let cached = sources.get(this);
    if (!cached || cached.element !== element) {
      cached = { element, src: original.call(this, false) }; sources.set(this, cached);
    }
    return cached.src;
  };
  installed.add(image); return image;
}
export function getImmutableNotebookImageSource(image) {
  if (!(image instanceof FabricImage)) throw new TypeError('Notebook image source requires a static Fabric image');
  memoizeImmutableNotebookImage(image);
  return Object.freeze({ kind: 'inline', src: image.getSrc() });
}
