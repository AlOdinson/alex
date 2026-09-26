# Image Selection Lease Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this single repair with tests before code.

**Goal:** Resume a still-held image move/resize after the student receives its selection lease.
**Architecture:** Preserve Fabric's original transform action handler while permission is pending. On a valid reply, run the existing history/live-transform initialization and restore the handler only for that exact, still-active transform. No permission, transport, storage, clock, or tool redesign.
**Tech Stack:** React, Fabric 7.4.0, Node test runner, Chromium.
**Spec:** User's reported student image move/resize failure and explicit repair request in this conversation.

## Constraints and review focus
Keep teacher authority and genuine conflicts enforced. Do not revive a gesture after release/cancel, deselection, tool switch, permission loss, object removal, canvas disposal/replacement, or a newer gesture. Preserve complete before/after history, shared-screen exception, and mouse/touch/pen paths. Device clock skew is a separate previously diagnosed problem, not changed by this repair.

## Task 1: Resume a pending transform safely
- [x] Add executable tests extracting the actual Board.jsx callbacks: delayed move/scale grant, rejection, late grant, stale gesture, and before-state capture.
- [x] Run tests on the unchanged source and retain expected failures.
- [x] Extract existing transform initialization into a local helper; restore the captured handler after lease confirmation with active-gesture identity and permission guards.
- [x] Run the focused tests, all existing authority and hosted-safe sync tests, and a production build.
- [x] Verify actual mouse move/resize using pinned Fabric in Chromium with delayed lease replies.
- [ ] Review the exact diff, publish the tested changes to GitHub, and verify the Pages deployment. Record any unavailable device tests honestly.

## Verification record before publication
Production callback regressions: 26 passed. Actual Fabric 7.4.0 + Chromium 144 isolated mouse fixture: 9 scenarios passed, no page errors. Both regression commands fail on unchanged Board.jsx and pass with the repair. Existing authority suite: 290 passed including the new 26. Hosted-safe sync suite passed (its 3 documented native-Canvas exclusions remain). Screen-share suite: 30 passed plus protocol/account checks. Production build passed with the pre-existing large-bundle warning. Physical iPad/Pencil, the student's actual computer, and live inter-device networks were not tested by this fixture.

The initial npm ci preparation failed on pre-existing lock-file omissions; used the repository's established npm install path without changing dependencies. An initial sync static-source check required keeping transform initialization inside before:transform; it now passes unchanged. A native pointer-cancel regression was added and observed failing before the cancellation fence was implemented.
