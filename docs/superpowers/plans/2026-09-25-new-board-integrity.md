# New-board Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans. The user selected implementation in this session.

**Goal:** Detect and repair bounded content/Canvas drift without blocking drawing or history, only on newly created boards.
**Architecture:** An optional board-session coordinator owns one bounded event queue. A cooperative comparator fingerprints selected canonical records; negotiated P2P requests return only differences. Version-guarded replica and Canvas adapters apply technical repairs.
**Tech Stack:** Existing JavaScript/React/Fabric/WebRTC/IndexedDB; no new application dependencies.
**Spec:** `docs/superpowers/specs/2026-09-25-new-board-integrity.md`

## Global Constraints
100 records/batch; 80/20 priority; queue 1000 IDs; 200 ms debounce; 1000 ms maximum schedule delay; 250 ms minimum batch interval; 4 ms cooperative target. New records only. No new periodic poll, custom audit timeout or retry backoff. Preserve normal commits and group undo.

## Review Focus
- Old clients receiving new protocol names: negotiate through existing initial-sync messages.
- Reply completing during a new gesture/commit: guard at every asynchronous repair boundary.
- Canonical data correct but Canvas wrong: independent Canvas comparison, not cached checksum only.
- Large string/path: tokenize and yield without whole-board JSON/clone.
- Queue overload/deleted IDs: finite rescan includes actual local membership, not only surviving authority IDs.

### Task 1: Scheduler and cooperative data comparison
Create `src/lib/boardIntegrityQueue.js`, `src/lib/boardIntegrityData.js`; test `scripts/test-board-integrity.mjs`.
- [ ] Write tests for constants, disabled/no idle timers, debounce, max-wait, no overlap, latest-ID work, overflow and 300-record draining.
- [ ] Run `node --test scripts/test-board-integrity.mjs` and retain failing output.
- [ ] Implement `createBoardIntegrityQueue({run, sample, ...clock})`, `createIntegrityBudget`, `fingerprintIntegrityRecord`, `captureIntegrityRecords`, `compareIntegrityCanvas`.
- [ ] Run tests and record green evidence.

### Task 2: New-board marker and canonical adapters
Modify `localBoardLibrary.js`, `browserAuthorityStore.js`, `freshOwnerBootstrap.js`, `browserBoardAuthority.js`, `browserReplicaStore.js`.
- [ ] Test new flag, absent old flag, recovery and no-revision/no-history targeted repair with stale revision refusal.
- [ ] Observe fail, implement only requested marker and read-only view/repair adapters, rerun authority/storage regressions.

### Task 3: Negotiated protocol and board-session coordinator
Create `boardIntegritySession.js` and `boardIntegrityPeer.js`; modify peer/session/runtime/realtime wrappers.
- [ ] Test real teacher/student module loop, same-revision color corruption, ghost deletion, move repair, bounded RPC and old-peer capability absence.
- [ ] Observe fail, implement existing-message capability negotiation and bounded request/result handling with teardown (no audit timeout or periodic retry).
- [ ] Wire confirmed commit notifications independently of action acknowledgement. Rerun all authority tests.

### Task 4: Canvas integration, verification and publication
Modify narrow callbacks in `Board.jsx`; add integrity browser regression and CI; bump feature release version.
- [ ] Test stale async enliven guard, gesture protection, rapid undo/redo and >100 selected IDs using actual Canvas/browser.
- [ ] Implement adapter using actual Canvas fields rather than whole-board serialization. Guard after enliven and before replay application.
- [ ] Run new unit/integration/browser tests, existing authority/sync/history/storage tests and production build. Review diff for old-board isolation and accidental changes.
- [ ] Publish verified branch, run GitHub CI, merge only the verified tree and verify deployment. Report physical-device limits accurately.
