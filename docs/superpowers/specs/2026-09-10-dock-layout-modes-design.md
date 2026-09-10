# Alex Board — Three Dock Layout Modes

Date: 2026-09-10
Status: approved in chat, pending written-spec review before implementation

## Goal

Add a compact layout-mode control to the board that cycles the primary tool dock through three placements while keeping all existing tool behavior intact.

Cycle: `1 → 2 → 3 → 1`.

The most recently selected mode must persist across reloads using `localStorage`.

## Current UI pieces involved

- Main tool dock: `.board-tool-dock`
- Left-side edit menu: `.toolbar-secondary-row .edit-actions`
- Selection object-action menu: `.toolbar-secondary-row .object-actions`
- Drawing three-dot controls: `.floating-drawing-controls`
- Selection floating proxy: `.selection-floating-proxy`
- Right-side 2×2 style/preset block: `.dock-style-right-accessories`
- Preset editor gear associated with the 2×2 block
- Undo/redo accessories: `.dock-history-accessories`

Existing drawing, selection, preset, history, and tool handlers must be reused rather than rewritten.

## Architecture

Introduce one layout controller as the single source of truth for dock placement.

The controller stores the current mode as `1`, `2`, or `3`, persists it under a dedicated `localStorage` key, and publishes the mode on the document root using:

`data-dock-layout="1|2|3"`

All visual relocation rules should derive from this attribute. Existing body-level helpers and enhancer scripts should read the same mode when they need geometry-specific positioning. Do not create independent mode state in multiple files.

Recommended persistence key:

`alex-board:dock-layout:v1`

Invalid or missing stored values fall back to mode `1`.

## Mode 1 — Bottom

This is the current layout and remains the default fallback.

- Main dock stays horizontally centered near the bottom.
- Left edit menu stays vertically centered on the left.
- Object-action menu stays beside the left edit menu when a selection exists.
- Drawing three-dot controls for Pencil, Line, and Shapes appear above the active dock button, as they do now.
- Selection floating controls also appear above the relevant dock/selection anchor.
- Undo/redo remain immediately to the left of the dock.
- The 2×2 style/preset block remains immediately to the right of the dock.
- The gear remains attached to that block.
- A small layout button appears just to the right of the 2×2 block, slightly lower than the gear, and displays `1`.

## Mode 2 — Top

The main dock moves to the top center and remains horizontal.

- Main dock is centered horizontally near the top safe area.
- The 2×2 style/preset block, gear, undo/redo, and layout button move with the dock while preserving their existing relative arrangement.
- Layout button displays `2`.
- Drawing three-dot controls for Pencil, Line, and Shapes appear below the active tool button instead of above it.
- Selection floating controls appear below the active dock/selection anchor.
- Side ranges still expand away from the middle dot according to their existing left/right behavior; only the group’s anchor position changes.
- Left edit menu and object-action menu keep their normal left-side placement in this mode.

## Mode 3 — Left Vertical

The main dock moves to the left-center and becomes vertical.

- Main dock is vertically centered near the left edge.
- Tool order remains unchanged from the horizontal dock.
- The 2×2 style/preset block, gear, undo/redo, and layout button relocate with the dock in a coherent left-side arrangement without obscuring tool buttons.
- Layout button displays `3`.
- Drawing three-dot controls for Pencil, Line, and Shapes appear to the right of the active tool button.
- Selection floating controls appear to the right of the relevant dock/selection anchor.
- The existing left edit menu of five utility buttons moves to the top center and becomes horizontal.
- When a selection exists, the object-action menu must also move out of the left-center dock area so it cannot overlap the vertical main dock; it should align with the top utility area in a predictable horizontal row beneath or adjacent to the edit menu.

The next layout-button press returns to mode `1`.

## Layout Button

The layout button is visually small but keeps a touch-friendly hit area.

Requirements:

- Visible text is exactly the current mode number: `1`, `2`, or `3`.
- One press advances to the next mode.
- It is located with the accessory cluster, not inside the main tool list.
- In mode 1 it sits immediately to the right of the 2×2 style block and slightly below the preset gear.
- In modes 2 and 3 it stays attached to the relocated accessory cluster.
- It must not steal focus from the active drawing tool or clear selection.
- It must work with mouse, touch, and Apple Pencil-style touch interactions consistently with existing accessory controls.

## Contextual Controls Direction

The same mode determines the preferred side for all contextual controls:

- Mode 1: `above`
- Mode 2: `below`
- Mode 3: `right`

This applies to:

- Pencil drawing controls
- Line drawing controls
- Shapes drawing controls
- Selection style proxy shown after selecting objects

The position should be calculated from the active tool button’s current `getBoundingClientRect()` and the current mode, rather than relying only on fixed viewport coordinates.

All positioning must be resynchronized on:

- layout-mode changes
- resize
- orientation change
- visual viewport resize/scroll
- active tool changes
- selection appearance/disappearance
- dock size changes caused by responsive CSS

## Responsive Behavior

The three modes must work on desktop, tablet, and phone layouts.

Safe-area insets must continue to be respected.

For narrow screens, geometry may use clamping to keep popovers and accessory clusters inside the visual viewport, but the semantic direction must remain:

- mode 1 above
- mode 2 below
- mode 3 right

If space is insufficient on the preferred side, clamp within the viewport rather than silently switching to another mode or another side.

## State and Data Flow

1. On startup, layout controller reads `alex-board:dock-layout:v1`.
2. It validates the stored value and defaults to `1` if invalid.
3. It writes `data-dock-layout` to `document.documentElement`.
4. CSS reacts to the attribute for broad placement/orientation changes.
5. Enhancer scripts use the same attribute for geometry-dependent floating controls.
6. Clicking the layout button advances `1 → 2 → 3 → 1`, saves the new value, updates the document attribute, and triggers a layout resync.

No board content state, tool state, color, width, opacity, active selection, undo history, or realtime state is reset when changing layout modes.

## Files / Responsibilities

Expected implementation areas:

- New small layout controller module for persisted mode state and change events.
- New CSS file for the three dock layouts and accessory relocation.
- `Toolbar.jsx` only if a stable DOM hook or wrapper is required; avoid moving existing tool logic.
- `dock-style-accessories.js` for layout button creation and accessory-cluster geometry.
- `floating-drawing-controls-enhancer.js` for above/below/right anchor calculation.
- Selection-proxy positioning logic in the existing dock accessory layer.
- Existing CSS files only where necessary to remove conflicting fixed positioning.

Prefer additive overrides over invasive rewrites of current toolbar behavior.

## Non-goals

- Do not redesign icons, colors, presets, drawing controls, or tool order.
- Do not change drawing behavior, selection behavior, undo/redo behavior, or realtime sync.
- Do not add drag-to-reposition in this version.
- Do not add more than three layout modes.
- Do not synchronize the chosen layout between users; it is a local device/user preference.

## Failure Handling

- If `localStorage` is unavailable, mode switching still works for the current session.
- If stored mode is malformed, use mode `1`.
- If a required dock anchor is temporarily absent during React updates, hide or defer the dependent floating control until the next sync frame rather than positioning it at `0,0`.
- A layout change must not throw if an accessory is currently hidden.

## Testing

Add focused regression coverage before production changes.

Minimum checks:

1. Missing/invalid saved value resolves to mode `1`.
2. Saved `2` or `3` is restored on load.
3. Cycle is exactly `1 → 2 → 3 → 1`.
4. Each mode updates `data-dock-layout` and persistence.
5. Mode 1 maps contextual direction to `above`.
6. Mode 2 maps contextual direction to `below`.
7. Mode 3 maps contextual direction to `right`.
8. Existing fullscreen control behavior remains independent.
9. Existing dock regression tests still pass.
10. Static checks ensure mode 3 makes the main dock vertical and moves the left utility menu to the top-center region.

Where practical, isolate pure mode/cycle/direction functions so they can be tested in Node without a browser DOM.

## Acceptance Criteria

The feature is accepted when:

- The small mode number appears in the specified accessory location.
- Repeated presses visibly cycle all three layouts and return to mode 1.
- Reload preserves the last selected mode.
- Mode 2 contextual controls open below the active tool/selection.
- Mode 3 contextual controls open to the right.
- Mode 3 main dock is vertical at left-center.
- Mode 3 moves the existing left utility menu to the top center.
- No tool selection, object selection, drawing setting, or board content is lost when changing modes.
- Current bottom-mode behavior remains unchanged when mode 1 is active.
