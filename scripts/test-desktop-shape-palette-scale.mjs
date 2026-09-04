import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/components/ShapePalette.jsx', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  source.includes('const DESKTOP_SCALE = 0.77;'),
  'Desktop shape palette must be 10% larger than the current 0.70 size (0.77).',
);

assert(
  source.includes('const TOUCH_SCALE = 1.1;'),
  'Touch/iPad shape palette must be 10% larger than the current 1.00 size (1.10).',
);

assert(
  source.includes('const paletteScale = compactTouchLayout ? TOUCH_SCALE : DESKTOP_SCALE;'),
  'Shape palette must use the enlarged scale for both desktop and touch layouts.',
);

assert(
  source.includes('const visualWidth = width * paletteScale;'),
  'Palette placement must clamp against the scaled visual width.',
);

assert(
  source.includes('availableHeight / paletteScale'),
  'Palette max-height calculation must account for visual scaling.',
);

assert(
  source.includes("`scale(${placement.scale}) translateY(-100%)`"),
  'Above-anchor palette must preserve its anchor while applying scale.',
);

assert(
  source.includes("`scale(${placement.scale})`"),
  'Below-anchor palette must apply scale.',
);

assert(
  source.includes("transformOrigin: 'top left'"),
  'Scaled palette must use a stable top-left transform origin.',
);

console.log('Shape palette 10% larger in all layouts regression passed.');
