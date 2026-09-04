import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/components/ShapePalette.jsx', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  source.includes('const DESKTOP_SCALE = 0.7;'),
  'Desktop shape palette must use an explicit 0.7 scale (30% smaller).',
);

assert(
  source.includes('const paletteScale = compactTouchLayout ? 1 : DESKTOP_SCALE;'),
  'Touch/iPad shape palette must stay at 100% while desktop uses DESKTOP_SCALE.',
);

assert(
  source.includes('const visualWidth = width * paletteScale;'),
  'Desktop placement must clamp against the scaled visual width.',
);

assert(
  source.includes('availableHeight / paletteScale'),
  'Palette max-height calculation must account for desktop visual scaling.',
);

assert(
  source.includes("`translateY(-100%) scale(${placement.scale})`"),
  'Above-anchor palette must preserve its anchor while applying desktop scale.',
);

assert(
  source.includes("`scale(${placement.scale})`"),
  'Below-anchor palette must apply the desktop scale.',
);

console.log('Desktop shape palette 70% scale regression passed.');
