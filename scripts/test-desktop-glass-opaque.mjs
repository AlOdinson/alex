import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/refractive-glass-lensing.css', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../src/refractive-glass-desktop-surface.js', import.meta.url), 'utf8');

assert.match(runtime, /refractive-desktop-opaque/, 'Desktop runtime must mark dock/history as desktop-opaque glass');
assert.match(css, /\.refractive-desktop-opaque\s*>\s*\.refractive-surface-sample,[\s\S]*?\.refractive-desktop-opaque\s*>\s*\.refractive-contour-sample\s*\{[\s\S]*?opacity:\s*1\s*!important;/, 'Desktop sampled center and contour must be fully opaque so the real board cannot show through underneath');
assert.doesNotMatch(css, /\.refractive-desktop-opaque[\s\S]*opacity:\s*0\.[0-9]+/, 'Desktop opaque override must not reintroduce partial transparency');

console.log('Desktop sampled glass opacity regression passed.');
