# Three Dock Layout Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent `1 → 2 → 3 → 1` layout switcher that moves the main tool dock between bottom-center, top-center, and left-center vertical layouts while moving contextual controls and utility menus in the approved directions.

**Architecture:** A new `dock-layout-controller.js` is the single source of truth. It validates/persists the mode, writes `data-dock-layout` on `<html>`, and emits one layout-change event. Existing body-level accessory and drawing-control modules consume that shared state; a late-loaded CSS override handles broad placement/orientation without rewriting existing tool behavior.

**Tech Stack:** Vite 8.1.5, React 19.2.8, vanilla DOM modules, CSS, Node `assert` regression scripts.

**Spec:** `docs/superpowers/specs/2026-09-10-dock-layout-modes-design.md`

## Global Constraints

- Cycle exactly `1 → 2 → 3 → 1`.
- Persist the last selected mode under `alex-board:dock-layout:v1`.
- Missing/invalid persisted values resolve to mode `1`.
- Publish the active mode as `document.documentElement.dataset.dockLayout = "1|2|3"`.
- Contextual direction is mode 1 `above`, mode 2 `below`, mode 3 `right`.
- Mode 1 must preserve the existing bottom-dock behavior and visual design.
- Mode 2 keeps the main dock horizontal at top-center; left utility/object menus remain on the left.
- Mode 3 makes the main dock vertical at left-center; undo/redo sit above it; the 2×2 style block sits below it; the existing left utility menu moves as one horizontal unit to top-center; object actions form a horizontal row beneath it.
- The layout number is local UI state only; do not sync it through Supabase/Ably.
- Switching modes must not reset tool, color, opacity, width, selection, board content, undo history, or realtime state.
- Respect safe-area insets on desktop, tablet, and phone.
- Keep `ShapePalette.jsx` behavior independent; this feature changes the three-dot drawing/selection controls, not the shape-library popup.
- Prefer additive overrides; do not rewrite existing React tool handlers.

---

### Task 1: Persistent layout controller

**Files:**
- Create: `src/dock-layout-controller.js`
- Create: `scripts/test-dock-layout-controller.mjs`

**Interfaces:**
- Produces: `DOCK_LAYOUT_STORAGE_KEY`, `DOCK_LAYOUT_CHANGE_EVENT`, `normalizeDockLayoutMode(value)`, `nextDockLayoutMode(mode)`, `contextualDirectionForMode(mode)`, `getDockLayoutMode(doc)`, `setDockLayoutMode(mode, options)`, `advanceDockLayoutMode(options)`, `initializeDockLayout(options)`.
- Event detail: `{ mode: "1" | "2" | "3", direction: "above" | "below" | "right" }`.

- [ ] **Step 1: Write the failing controller test**

Create `scripts/test-dock-layout-controller.mjs` with direct imports and fake document/storage objects:

```js
import assert from 'node:assert/strict';
import {
  DOCK_LAYOUT_CHANGE_EVENT,
  DOCK_LAYOUT_STORAGE_KEY,
  advanceDockLayoutMode,
  contextualDirectionForMode,
  getDockLayoutMode,
  initializeDockLayout,
  nextDockLayoutMode,
  normalizeDockLayoutMode,
  setDockLayoutMode,
} from '../src/dock-layout-controller.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function fakeDocument() {
  const events = [];
  return {
    documentElement: { dataset: {} },
    dispatchEvent(event) { events.push(event); return true; },
    events,
  };
}

assert.equal(normalizeDockLayoutMode(null), '1');
assert.equal(normalizeDockLayoutMode('nope'), '1');
assert.equal(normalizeDockLayoutMode('1'), '1');
assert.equal(normalizeDockLayoutMode('2'), '2');
assert.equal(normalizeDockLayoutMode('3'), '3');
assert.equal(nextDockLayoutMode('1'), '2');
assert.equal(nextDockLayoutMode('2'), '3');
assert.equal(nextDockLayoutMode('3'), '1');
assert.equal(contextualDirectionForMode('1'), 'above');
assert.equal(contextualDirectionForMode('2'), 'below');
assert.equal(contextualDirectionForMode('3'), 'right');

{
  const doc = fakeDocument();
  const storage = memoryStorage({ [DOCK_LAYOUT_STORAGE_KEY]: '3' });
  assert.equal(initializeDockLayout({ doc, storage }), '3');
  assert.equal(doc.documentElement.dataset.dockLayout, '3');
  assert.equal(getDockLayoutMode(doc), '3');
}

{
  const doc = fakeDocument();
  const storage = memoryStorage();
  assert.equal(initializeDockLayout({ doc, storage }), '1');
  assert.equal(setDockLayoutMode('2', { doc, storage }), '2');
  assert.equal(storage.getItem(DOCK_LAYOUT_STORAGE_KEY), '2');
  assert.equal(advanceDockLayoutMode({ doc, storage }), '3');
  assert.equal(doc.documentElement.dataset.dockLayout, '3');
  assert.equal(doc.events.at(-1).type, DOCK_LAYOUT_CHANGE_EVENT);
  assert.deepEqual(doc.events.at(-1).detail, { mode: '3', direction: 'right' });
}

console.log('Dock layout controller regression passed.');
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node scripts/test-dock-layout-controller.mjs
```

Expected: FAIL because `src/dock-layout-controller.js` does not exist yet.

- [ ] **Step 3: Implement the minimal controller**

Create `src/dock-layout-controller.js` with the following behavior and browser bootstrap:

```js
export const DOCK_LAYOUT_STORAGE_KEY = 'alex-board:dock-layout:v1';
export const DOCK_LAYOUT_CHANGE_EVENT = 'alex-board:dock-layout-change';

const VALID_MODES = new Set(['1', '2', '3']);
const NEXT_MODE = { 1: '2', 2: '3', 3: '1' };
const DIRECTION = { 1: 'above', 2: 'below', 3: 'right' };

export function normalizeDockLayoutMode(value) {
  const mode = String(value ?? '');
  return VALID_MODES.has(mode) ? mode : '1';
}

export function nextDockLayoutMode(mode) {
  return NEXT_MODE[normalizeDockLayoutMode(mode)];
}

export function contextualDirectionForMode(mode) {
  return DIRECTION[normalizeDockLayoutMode(mode)];
}

export function getDockLayoutMode(doc = document) {
  return normalizeDockLayoutMode(doc?.documentElement?.dataset?.dockLayout);
}

function readStoredMode(storage) {
  try { return normalizeDockLayoutMode(storage?.getItem?.(DOCK_LAYOUT_STORAGE_KEY)); }
  catch { return '1'; }
}

function persistMode(storage, mode) {
  try { storage?.setItem?.(DOCK_LAYOUT_STORAGE_KEY, mode); }
  catch { /* session-only fallback */ }
}

function emitLayoutChange(doc, mode) {
  const detail = { mode, direction: contextualDirectionForMode(mode) };
  const event = typeof CustomEvent === 'function'
    ? new CustomEvent(DOCK_LAYOUT_CHANGE_EVENT, { detail })
    : { type: DOCK_LAYOUT_CHANGE_EVENT, detail };
  doc?.dispatchEvent?.(event);
}

export function setDockLayoutMode(mode, { doc = document, storage = globalThis.localStorage } = {}) {
  const normalized = normalizeDockLayoutMode(mode);
  if (doc?.documentElement?.dataset) doc.documentElement.dataset.dockLayout = normalized;
  persistMode(storage, normalized);
  emitLayoutChange(doc, normalized);
  return normalized;
}

export function advanceDockLayoutMode({ doc = document, storage = globalThis.localStorage } = {}) {
  return setDockLayoutMode(nextDockLayoutMode(getDockLayoutMode(doc)), { doc, storage });
}

export function initializeDockLayout({ doc = document, storage = globalThis.localStorage } = {}) {
  const mode = readStoredMode(storage);
  if (doc?.documentElement?.dataset) doc.documentElement.dataset.dockLayout = mode;
  return mode;
}

if (typeof document !== 'undefined') initializeDockLayout();
```

- [ ] **Step 4: Run controller test and syntax check**

Run:

```bash
node scripts/test-dock-layout-controller.mjs
node --check src/dock-layout-controller.js
```

Expected: both exit 0; controller test prints `Dock layout controller regression passed.`

- [ ] **Step 5: Commit Task 1**

```bash
git add src/dock-layout-controller.js scripts/test-dock-layout-controller.mjs
git commit -m "feat: add persistent dock layout controller"
```

---

### Task 2: Mode-number switcher and accessory metrics

**Files:**
- Modify: `src/dock-style-accessories.js`
- Create: `scripts/test-dock-layout-switcher.mjs`

**Interfaces:**
- Consumes: `advanceDockLayoutMode`, `getDockLayoutMode`, `DOCK_LAYOUT_CHANGE_EVENT` from `src/dock-layout-controller.js`.
- Produces DOM: `.dock-layout-mode-button[data-dock-layout-action="cycle"]` with visible text equal to current mode.
- Produces CSS metrics: `--dock-style-left`, `--dock-style-right`, `--dock-style-top`, `--dock-style-bottom`, `--dock-style-width`, `--dock-style-height`, `--dock-style-center-x`, `--dock-style-center-y`, `--dock-style-accessory-top`.

- [ ] **Step 1: Write the failing switcher regression**

Create `scripts/test-dock-layout-switcher.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/dock-style-accessories.js', import.meta.url), 'utf8');

assert.match(source, /from ['"]\.\/dock-layout-controller\.js['"]/);
assert.match(source, /dock-layout-mode-button/);
assert.match(source, /data-dock-layout-action/);
assert.match(source, /advanceDockLayoutMode\(/);
assert.match(source, /getDockLayoutMode\(/);
assert.match(source, /DOCK_LAYOUT_CHANGE_EVENT/);
assert.match(source, /--dock-style-bottom/);
assert.match(source, /--dock-style-width/);
assert.match(source, /--dock-style-center-x/);
assert.match(source, /--dock-style-center-y/);

console.log('Dock layout switcher regression passed.');
```

- [ ] **Step 2: Run the test and verify RED**

```bash
node scripts/test-dock-layout-switcher.mjs
```

Expected: FAIL because the accessory module does not yet import/use the layout controller or create the number button.

- [ ] **Step 3: Add the controller import and mode button**

At the top of `src/dock-style-accessories.js` add:

```js
import {
  DOCK_LAYOUT_CHANGE_EVENT,
  advanceDockLayoutMode,
  getDockLayoutMode,
} from './dock-layout-controller.js';
```

Extend `ensureAccessoryShells()` with a body-level switcher that is independent of the 2×2 block's hidden state:

```js
let layoutButton = document.querySelector('.dock-layout-mode-button');
if (!layoutButton) {
  layoutButton = createAccessoryButton(
    'dock-layout-mode-button',
    'Изменить положение панели инструментов',
    getDockLayoutMode(document),
  );
  layoutButton.dataset.dockLayoutAction = 'cycle';
  document.body.append(layoutButton);
}

return { history, right, selectionProxy, layoutButton };
```

Update `syncState()` so the button stays visible whenever the dock exists and always displays the current mode:

```js
const { history, right, selectionProxy, layoutButton } = ensureAccessoryShells();
const boardActive = syncDockMetrics();
layoutButton.hidden = !boardActive;
if (boardActive) layoutButton.textContent = getDockLayoutMode(document);
```

Add `.dock-layout-mode-button` to `accessoryTarget()` and in `activateAccessoryTarget()` handle it before drawing/preset logic:

```js
if (target.classList.contains('dock-layout-mode-button')) {
  advanceDockLayoutMode();
  scheduleSync();
  return;
}
```

This reuses the module's existing click and stylus-touch-end arbitration, so the new control follows the same mouse/touch/Apple Pencil behavior as the other accessories.

- [ ] **Step 4: Extend dock metrics for all three orientations**

In `syncDockMetrics()` write the additional variables from the actual dock rectangle:

```js
root.style.setProperty('--dock-style-bottom', `${rect.bottom}px`);
root.style.setProperty('--dock-style-width', `${rect.width}px`);
root.style.setProperty('--dock-style-center-x', `${rect.left + rect.width / 2}px`);
root.style.setProperty('--dock-style-center-y', `${rect.top + rect.height / 2}px`);
```

Listen for the shared layout event in the browser bootstrap:

```js
document.addEventListener(DOCK_LAYOUT_CHANGE_EVENT, scheduleSync);
```

Keep the existing MutationObserver, storage, resize, orientation, scroll, and VisualViewport listeners.

- [ ] **Step 5: Run focused checks**

```bash
node scripts/test-dock-layout-switcher.mjs
node --check src/dock-style-accessories.js
```

Expected: exit 0; switcher test prints `Dock layout switcher regression passed.`

- [ ] **Step 6: Commit Task 2**

```bash
git add src/dock-style-accessories.js scripts/test-dock-layout-switcher.mjs
git commit -m "feat: add dock layout mode switcher"
```

---

### Task 3: Direction-aware drawing and selection controls

**Files:**
- Modify: `src/floating-drawing-controls-enhancer.js`
- Create: `scripts/test-dock-contextual-direction.mjs`

**Interfaces:**
- Consumes: `DOCK_LAYOUT_CHANGE_EVENT`, `contextualDirectionForMode`, `getDockLayoutMode`.
- Writes per-root custom properties: `--drawing-controls-x`, `--drawing-controls-y` and attribute `data-context-direction="above|below|right"`.
- The same logic applies to normal drawing roots and `.selection-floating-proxy` because both use `.floating-drawing-controls`.

- [ ] **Step 1: Write the failing direction regression**

Create `scripts/test-dock-contextual-direction.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/floating-drawing-controls-enhancer.js', import.meta.url), 'utf8');

assert.match(source, /dock-layout-controller\.js/);
assert.match(source, /contextualDirectionForMode/);
assert.match(source, /getDockLayoutMode/);
assert.match(source, /data-context-direction/);
assert.match(source, /rect\.bottom\s*\+\s*10/);
assert.match(source, /rect\.right\s*\+\s*10/);
assert.match(source, /DOCK_LAYOUT_CHANGE_EVENT/);

console.log('Dock contextual direction regression passed.');
```

- [ ] **Step 2: Run the test and verify RED**

```bash
node scripts/test-dock-contextual-direction.mjs
```

Expected: FAIL because the enhancer currently always anchors above using `rect.top - 10`.

- [ ] **Step 3: Replace fixed-above positioning with shared mode logic**

Add the controller import:

```js
import {
  DOCK_LAYOUT_CHANGE_EVENT,
  contextualDirectionForMode,
  getDockLayoutMode,
} from './dock-layout-controller.js';
```

Replace `syncPosition(root)` with direction-aware geometry:

```js
function syncPosition(root) {
  const activeButton = document.querySelector(ACTIVE_DOCK_SELECTOR);
  if (!activeButton) return;
  const rect = activeButton.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const direction = contextualDirectionForMode(getDockLayoutMode(document));
  root.dataset.contextDirection = direction;

  if (direction === 'below') {
    root.style.setProperty('--drawing-controls-x', `${rect.left + rect.width / 2}px`);
    root.style.setProperty('--drawing-controls-y', `${rect.bottom + 10}px`);
    return;
  }

  if (direction === 'right') {
    root.style.setProperty('--drawing-controls-x', `${rect.right + 10}px`);
    root.style.setProperty('--drawing-controls-y', `${rect.top + rect.height / 2}px`);
    return;
  }

  root.style.setProperty('--drawing-controls-x', `${rect.left + rect.width / 2}px`);
  root.style.setProperty('--drawing-controls-y', `${rect.top - 10}px`);
}
```

Add:

```js
document.addEventListener(DOCK_LAYOUT_CHANGE_EVENT, resync);
```

Keep the existing MutationObserver and viewport listeners so active-tool and selection DOM changes still reposition the controls.

- [ ] **Step 4: Run focused checks**

```bash
node scripts/test-dock-contextual-direction.mjs
node --check src/floating-drawing-controls-enhancer.js
```

Expected: both exit 0.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/floating-drawing-controls-enhancer.js scripts/test-dock-contextual-direction.mjs
git commit -m "feat: make dock contextual controls directional"
```

---

### Task 4: Three visual layouts and directional transforms

**Files:**
- Create: `src/dock-layout-modes.css`
- Modify: `src/main.jsx`
- Create: `scripts/test-dock-layout-css.mjs`

**Interfaces:**
- Consumes document root attribute: `html[data-dock-layout="1|2|3"]`.
- Consumes dock geometry CSS variables written by `dock-style-accessories.js`.
- Overrides only placement/orientation for `.board-tool-dock`, `.dock-history-accessories`, `.dock-style-right-accessories`, `.dock-layout-mode-button`, `.floating-drawing-controls`, `.toolbar-secondary-row .edit-actions`, and `.toolbar-secondary-row .object-actions`.

- [ ] **Step 1: Write the failing CSS integration test**

Create `scripts/test-dock-layout-css.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/dock-layout-modes.css', import.meta.url), 'utf8');

assert.match(main, /import ['"]\.\/dock-layout-controller\.js['"]/);
assert.match(main, /import ['"]\.\/dock-layout-modes\.css['"]/);

assert.match(css, /html\[data-dock-layout="1"\][\s\S]*?\.board-tool-dock/);
assert.match(css, /html\[data-dock-layout="2"\][\s\S]*?\.board-tool-dock/);
assert.match(css, /html\[data-dock-layout="3"\][\s\S]*?\.board-tool-dock/);
assert.match(css, /data-dock-layout="2"[\s\S]*?top:\s*max\(/);
assert.match(css, /data-dock-layout="3"[\s\S]*?flex-direction:\s*column/);
assert.match(css, /data-dock-layout="3"[\s\S]*?\.edit-actions[\s\S]*?top:\s*max\(/);
assert.match(css, /data-dock-layout="3"[\s\S]*?\.object-actions[\s\S]*?flex-direction:\s*row/);
assert.match(css, /data-context-direction="below"/);
assert.match(css, /data-context-direction="right"/);
assert.match(css, /dock-layout-mode-button/);

console.log('Dock layout CSS regression passed.');
```

- [ ] **Step 2: Run the test and verify RED**

```bash
node scripts/test-dock-layout-css.mjs
```

Expected: FAIL because `src/dock-layout-modes.css` does not exist and `main.jsx` does not import the new controller/CSS yet.

- [ ] **Step 3: Add startup imports in the correct order**

In `src/main.jsx`, import the controller before accessory modules and load the layout CSS after existing toolbar/accessory layout CSS so its placement rules win without `styles.css` rewrites:

```js
import './dock-layout-controller.js';
```

Place it before:

```js
import './dock-style-accessories.js';
```

Then after:

```js
import './floating-toolbar-layout.css';
```

add:

```js
import './dock-layout-modes.css';
```

- [ ] **Step 4: Implement mode 1 and mode 2 placement**

Create `src/dock-layout-modes.css`. Preserve mode 1 geometry explicitly and define mode 2 as the top counterpart:

```css
html[data-dock-layout="1"] .board-tool-dock {
  position: fixed !important;
  left: 50% !important;
  right: auto !important;
  top: auto !important;
  bottom: max(12px, env(safe-area-inset-bottom)) !important;
  transform: translateX(-50%) !important;
  flex-direction: row !important;
}

html[data-dock-layout="2"] .board-tool-dock {
  position: fixed !important;
  left: 50% !important;
  right: auto !important;
  top: max(12px, env(safe-area-inset-top)) !important;
  bottom: auto !important;
  transform: translateX(-50%) !important;
  flex-direction: row !important;
}

html[data-dock-layout="1"] .dock-history-accessories,
html[data-dock-layout="2"] .dock-history-accessories {
  left: max(6px, calc(var(--dock-style-left, 50vw) - 70px)) !important;
  top: calc(var(--dock-style-top, 0px) + (var(--dock-style-height, 58px) - 32px) / 2) !important;
}

html[data-dock-layout="1"] .dock-style-right-accessories,
html[data-dock-layout="2"] .dock-style-right-accessories {
  left: min(calc(100vw - 88px), calc(var(--dock-style-right, 50vw) + 8px)) !important;
  top: var(--dock-style-accessory-top, 0px) !important;
}
```

Use 8px mobile safe-area values in the existing `@media (max-width: 760px)` pattern so mode 1 remains visually unchanged on phones/tablets.

- [ ] **Step 5: Implement mode 3 vertical placement**

Add the left-center vertical layout:

```css
html[data-dock-layout="3"] .board-tool-dock {
  position: fixed !important;
  left: max(12px, env(safe-area-inset-left)) !important;
  right: auto !important;
  top: 50% !important;
  bottom: auto !important;
  transform: translateY(-50%) !important;
  flex-direction: column !important;
  max-width: none !important;
  max-height: calc(100dvh - 150px) !important;
  overflow-x: hidden !important;
  overflow-y: auto !important;
}

html[data-dock-layout="3"] .dock-history-accessories {
  left: calc(var(--dock-style-center-x, 40px) - 34px) !important;
  top: max(6px, calc(var(--dock-style-top, 50vh) - 40px)) !important;
  flex-direction: row !important;
}

html[data-dock-layout="3"] .dock-style-right-accessories {
  left: calc(var(--dock-style-center-x, 40px) - 29px) !important;
  top: min(calc(100dvh - 70px), calc(var(--dock-style-bottom, 50vh) + 8px)) !important;
}
```

Do not alter tool order; `flex-direction: column` makes the existing DOM order top-to-bottom.

- [ ] **Step 6: Position the mode-number button**

Give it a small visible number with a touchable 28×28 target. In modes 1/2 position it to the right of the 2×2 block and lower than the gear; in mode 3 preserve that relationship below the vertical dock:

```css
.dock-layout-mode-button {
  position: fixed !important;
  z-index: 189 !important;
  width: 28px !important;
  height: 28px !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  color: #64748b !important;
  font-size: 11px !important;
  font-weight: 800 !important;
  line-height: 1 !important;
  display: grid !important;
  place-items: center !important;
  touch-action: manipulation;
}

.dock-layout-mode-button[hidden] { display: none !important; }

html[data-dock-layout="1"] .dock-layout-mode-button,
html[data-dock-layout="2"] .dock-layout-mode-button {
  left: min(calc(100vw - 30px), calc(var(--dock-style-right, 50vw) + 74px)) !important;
  top: calc(var(--dock-style-accessory-top, 0px) + 27px) !important;
}

html[data-dock-layout="3"] .dock-layout-mode-button {
  left: calc(var(--dock-style-center-x, 40px) + 35px) !important;
  top: min(calc(100dvh - 32px), calc(var(--dock-style-bottom, 50vh) + 35px)) !important;
}
```

- [ ] **Step 7: Move the utility and object-action menus in mode 3**

Override the fixed left layout only for mode 3:

```css
html[data-dock-layout="3"] .toolbar-secondary-row .edit-actions {
  left: 50% !important;
  right: auto !important;
  top: max(10px, env(safe-area-inset-top)) !important;
  transform: translateX(-50%) !important;
  flex-direction: row !important;
}

html[data-dock-layout="3"] .toolbar-secondary-row .object-actions {
  left: 50% !important;
  right: auto !important;
  top: max(58px, calc(env(safe-area-inset-top) + 58px)) !important;
  transform: translateX(-50%) !important;
  flex-direction: row !important;
}
```

Do not hard-code button count. Keep existing `.tool-button` sizing and action order.

- [ ] **Step 8: Change the three-dot group transform by direction**

The enhancer keeps supplying an anchor point; CSS controls which edge of the group attaches to it:

```css
.floating-drawing-controls[data-context-direction="above"] {
  transform: translate(-50%, -100%) !important;
}

.floating-drawing-controls[data-context-direction="below"] {
  transform: translate(-50%, 0) !important;
}

.floating-drawing-controls[data-context-direction="right"] {
  transform: translate(0, -50%) !important;
}
```

This applies equally to `.selection-floating-proxy` because it has the same base class.

- [ ] **Step 9: Run CSS and legacy dock tests**

```bash
node scripts/test-dock-layout-css.mjs
node scripts/test-bottom-tool-dock.mjs
node scripts/test-floating-drawing-controls.mjs
```

Expected: all exit 0. If `test-bottom-tool-dock.mjs` rejects the new fixed/override strategy because it only inspects `styles.css`, keep `styles.css` unchanged and update that regression only to accept the new late-loaded mode stylesheet while still asserting that mode 1 is bottom-centered.

- [ ] **Step 10: Commit Task 4**

```bash
git add src/dock-layout-modes.css src/main.jsx scripts/test-dock-layout-css.mjs scripts/test-bottom-tool-dock.mjs
git commit -m "feat: add three dock layout modes"
```

---

### Task 5: Full regression wiring and verification

**Files:**
- Modify: `package.json`
- Create: `scripts/test-dock-layout-modes.mjs`

**Interfaces:**
- `test:sync` must execute the new dock-layout regressions before the existing bottom-dock/accessory regressions.
- Final static regression verifies cross-file wiring, persistence key, event name, switcher DOM hook, directional hooks, mode 3 vertical CSS, and mode 3 utility relocation.

- [ ] **Step 1: Write the failing integration regression**

Create `scripts/test-dock-layout-modes.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';

const controller = fs.readFileSync(new URL('../src/dock-layout-controller.js', import.meta.url), 'utf8');
const accessories = fs.readFileSync(new URL('../src/dock-style-accessories.js', import.meta.url), 'utf8');
const enhancer = fs.readFileSync(new URL('../src/floating-drawing-controls-enhancer.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/dock-layout-modes.css', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.match(controller, /alex-board:dock-layout:v1/);
assert.match(controller, /alex-board:dock-layout-change/);
assert.match(controller, /1:\s*['"]2['"]/);
assert.match(controller, /2:\s*['"]3['"]/);
assert.match(controller, /3:\s*['"]1['"]/);
assert.match(accessories, /dock-layout-mode-button/);
assert.match(accessories, /advanceDockLayoutMode/);
assert.match(enhancer, /contextualDirectionForMode/);
assert.match(css, /data-dock-layout="3"[\s\S]*?flex-direction:\s*column/);
assert.match(css, /data-context-direction="below"/);
assert.match(css, /data-context-direction="right"/);
assert.match(css, /\.edit-actions[\s\S]*?flex-direction:\s*row/);
assert.match(css, /\.object-actions[\s\S]*?flex-direction:\s*row/);
assert.match(main, /dock-layout-controller\.js/);
assert.match(main, /dock-layout-modes\.css/);
assert.match(pkg.scripts['test:sync'], /test-dock-layout-controller\.mjs/);
assert.match(pkg.scripts['test:sync'], /test-dock-layout-switcher\.mjs/);
assert.match(pkg.scripts['test:sync'], /test-dock-contextual-direction\.mjs/);
assert.match(pkg.scripts['test:sync'], /test-dock-layout-css\.mjs/);
assert.match(pkg.scripts['test:sync'], /test-dock-layout-modes\.mjs/);

console.log('Dock layout modes integration regression passed.');
```

- [ ] **Step 2: Run the test and verify RED**

```bash
node scripts/test-dock-layout-modes.mjs
```

Expected: FAIL because `package.json` has not yet wired the new test scripts into `test:sync`.

- [ ] **Step 3: Wire the regressions into `test:sync`**

Prepend the new layout tests ahead of the existing dock tests in `package.json` while preserving every current command. The relevant beginning becomes:

```json
"test:sync": "node scripts/test-board-fullscreen.mjs && node scripts/test-realtime-discontinuity-recovery.mjs && node scripts/test-settings-gear-layout.mjs && node scripts/test-dock-layout-controller.mjs && node scripts/test-dock-layout-switcher.mjs && node scripts/test-dock-contextual-direction.mjs && node scripts/test-dock-layout-css.mjs && node scripts/test-dock-layout-modes.mjs && node scripts/test-presence-menu.mjs ..."
```

Do not delete or reorder unrelated existing regression commands beyond inserting the five new scripts before the legacy dock-related checks.

- [ ] **Step 4: Run all focused dock-layout tests**

```bash
node scripts/test-dock-layout-controller.mjs
node scripts/test-dock-layout-switcher.mjs
node scripts/test-dock-contextual-direction.mjs
node scripts/test-dock-layout-css.mjs
node scripts/test-dock-layout-modes.mjs
node scripts/test-bottom-tool-dock.mjs
node scripts/test-dock-liquid-glass.mjs
node scripts/test-floating-drawing-controls.mjs
```

Expected: every command exits 0.

- [ ] **Step 5: Run syntax checks for every modified/new JS module**

```bash
node --check src/dock-layout-controller.js
node --check src/dock-style-accessories.js
node --check src/floating-drawing-controls-enhancer.js
node --check scripts/test-dock-layout-controller.mjs
node --check scripts/test-dock-layout-switcher.mjs
node --check scripts/test-dock-contextual-direction.mjs
node --check scripts/test-dock-layout-css.mjs
node --check scripts/test-dock-layout-modes.mjs
```

Expected: all exit 0.

- [ ] **Step 6: Run the full sync suite and build**

```bash
npm run test:sync
npm run build
```

Expected: both exit 0. Do not claim CI status unless a GitHub Actions run is actually present and inspected.

- [ ] **Step 7: Manual acceptance pass in browser/device emulation**

Verify these exact interactions without reloading between mode changes:

1. Start in mode 1: dock bottom-center, left utility menu unchanged, drawing/selection dots above.
2. Press `1`: dock moves top-center and button becomes `2`; drawing/selection dots appear below active tool.
3. Press `2`: dock moves left-center vertical and button becomes `3`; dots appear right; undo/redo are above dock; 2×2 block is below dock; edit actions are top-center; object actions appear as a second horizontal row only when selection exists.
4. Press `3`: all geometry returns to mode 1 and button becomes `1`.
5. Reload in each mode and verify the mode persists.
6. Repeat on a viewport ≤760px and confirm safe areas/clamping keep controls on-screen.
7. During mode changes, keep one object selected and confirm the selection stays selected; then keep Pencil active and confirm color/opacity/width values do not reset.

- [ ] **Step 8: Commit Task 5**

```bash
git add package.json scripts/test-dock-layout-modes.mjs
git commit -m "test: cover dock layout mode switching"
```

## Plan Self-Review

- Spec coverage: all approved mode positions, persistence, cycle semantics, contextual directions, mode-3 utility relocation, accessory placement, safe-area behavior, and state-preservation constraints map to Tasks 1–5.
- Placeholder scan: no `TBD`, `TODO`, "implement later", or unspecified error-handling steps remain.
- Interface consistency: the controller event is consistently named `alex-board:dock-layout-change`; the root attribute is consistently `data-dock-layout`; the mode button is consistently `.dock-layout-mode-button`; contextual direction is consistently stored as `data-context-direction`.
- Scope remains one feature: no ShapePalette redesign, no realtime changes, no tool-handler refactor, no drag-to-reposition.
