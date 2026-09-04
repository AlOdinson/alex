# Alex Board RU/EN Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete Russian/English localization to Alex Board with independent language selection for teachers and students.

**Architecture:** Introduce a small app-owned i18n module with `ru` and `en` dictionaries, a React language context/provider, and persistent per-role language preferences in localStorage. Teacher language is selected from Home and applies to all teacher UI. Student language is selected before name entry on a shared board, persists for that browser, and applies throughout the board UI; both roles can switch language later without changing board/user content.

**Tech Stack:** React, Vite, browser localStorage, existing Node test scripts.

**Spec:** `docs/superpowers/specs/2026-09-05-ru-en-localization-design.md`

## Global Constraints

- Support exactly two UI languages: Russian (`ru`) and English (`en`).
- Teacher and student language preferences are independent.
- Existing user-created board titles, student names, canvas text, and other user data are never translated.
- Translate all app-owned visible copy: buttons, headings, labels, placeholders, tooltips, aria labels, prompts, confirms, status text, errors, screen-share UI, game UI, account UI, board library UI, and dates.
- Existing users default to Russian until they explicitly choose English.
- Student language choice must be available before the student enters their name.
- Language switching must not change board state, permissions, realtime behavior, or persisted board data.

---

### Task 1: Localization core and persistence

**Files:** Create `src/i18n.js`, `scripts/test-i18n.mjs`; modify `package.json`.

- [ ] Write failing tests for RU/EN translation, interpolation, per-role persistence keys, fallback, and locale formatting.
- [ ] Run `node scripts/test-i18n.mjs` and verify RED.
- [ ] Implement dictionary and helpers.
- [ ] Run tests and verify GREEN.
- [ ] Add the test to `npm run test:sync`.

### Task 2: Global language provider and teacher Home selector

**Files:** Create `src/components/LanguageProvider.jsx`, `src/components/LanguageToggle.jsx`; modify `src/App.jsx`, `src/components/Home.jsx`.

- [ ] Add failing source regression assertions for provider/toggle/Home integration.
- [ ] Verify RED.
- [ ] Wrap Home in teacher language context, add RU/EN selector, translate all Home UI and dates.
- [ ] Verify `node scripts/test-i18n.mjs` and `npm run build`.

### Task 3: Student pre-entry language choice and board provider

**Files:** Modify `src/App.jsx`, `src/components/Board.jsx`, `src/components/LanguageToggle.jsx`.

- [ ] Add failing assertions that the student entry gate renders RU/EN before name entry and uses translation keys.
- [ ] Verify RED.
- [ ] Apply student language preference before entry; retain it inside the board; owner sessions use teacher preference.
- [ ] Verify tests and build.

### Task 4: Translate all board controls and auxiliary components

**Files:** Modify `Toolbar.jsx`, `ShapePalette.jsx`, `DrawingPresets.jsx`, `ShareDialog.jsx`, `ScreenShare.jsx`, `GameLibrary.jsx`, `TeacherAccountPanel.jsx`, `MacBrowserHost.jsx`, `Board.jsx`.

- [ ] Add a failing Cyrillic UI scan for `src/**/*.jsx`, with a minimal explicit allowlist for intentional non-UI content only.
- [ ] Verify RED and collect all remaining UI strings.
- [ ] Move every app-owned visible Russian literal into `src/i18n.js` and replace with `t(key, params)`.
- [ ] Iterate until the Cyrillic UI scan is clean.

### Task 5: End-to-end regression verification

- [ ] Run `node scripts/test-i18n.mjs`.
- [ ] Run `npm run test:sync`.
- [ ] Run `npm run build`.
- [ ] Confirm no SQL, realtime protocol, board persistence schema, permissions, or user-created content transformation logic changed.
- [ ] Commit and fast-forward `main`; confirm GitHub Pages workflow starts.
