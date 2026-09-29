# Connection Reliability Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the eleven approved connection upgrades on the existing stack.
**Architecture:** Keep owner-authoritative star topology and sequential WebRTC paths. Repair lifecycle transitions and add bounded in-place recovery before reconnect.
**Tech Stack:** React, browser WebRTC/Web Locks, Ably, Supabase, Node tests, Playwright CI.
**Spec:** docs/superpowers/specs/2026-09-30-connection-reliability.md

## Global Constraints
- No new servers or TURN; board data travels over WebRTC.
- No periodic full snapshot verification or snapshot compaction.
- Preserve existing acknowledgement and board editing behavior.

## Review Focus
- Authority loss while IndexedDB startup is unresolved: stale runtime must close.
- Old control messages after a fresh student session: current healthy channels survive.
- Both peers request recovery simultaneously: single native offerer, bounded retry.
- Live channel replacement: sequence state and author identity remain valid.
- Browser suspends longer than timeout: wake checks recover without destroying a responsive path.

### Task 1: Authority and readiness
Files: teacherTabAuthority.js, browserBoardSession.js, browserAuthorityRealtime.js; scripts/test-connection-upgrades.mjs, test-teacher-tab-authority.mjs.
Interfaces: authority onChange(Boolean); session onRuntimeState(state); desired presence reconciliation.
- [ ] Regress valid lock options, delayed fallback acquisition, authority loss/regain, failed presence update/recovery. Run node --test scripts/test-connection-upgrades.mjs; expect failures on current behavior.
- [ ] Repair lock ownership lifecycle; publish true only for ready runtime and false on loss; retry failed readiness publication.
- [ ] Verify authority/session/realtime suites and commit.

### Task 2: Signaling and retry scheduling
Files: peerSignalingAssistance.js, dualPathPeerPair.js, browserBoardSession.js, boardPeerSignaling.js.
Interfaces: pair attemptId on all signals; negotiationId for each native path; nextRetryAt is session-owned.
- [ ] Regress duplicate-offer replay, stale control generation, unchanged presence backoff, progress deadline behavior.
- [ ] Preserve replay queue, validate control before mutation, bound progress deadline, centralize retries.
- [ ] Verify signaling/pair/session suites and commit.

### Task 3: Channel recovery and relays
Files: browserPeerConnection.js, dualPathPeerPair.js, studentPeerNetwork.js, teacherPeerNetwork.js, peerLiveChannel.js, liveEventProtocol.js, teacherBoardRuntime.js, studentBoardRuntime.js.
Interfaces: connection restartIce/recoverLiveChannel/checkHealth/getDiagnostics; pair recover/repairLiveChannel; runtime recoverConnections/getConnectionDiagnostics.
- [ ] Regress native ICE restart exchange, duplicate recovery, replacement live delivery, failed recovery teardown, relay origin validation and fanout.
- [ ] Implement bounded recovery with one native offerer, per-round ICE identity, channel replacement, and wake probes.
- [ ] Preserve live envelope origin/sequence, trust only teacher relays; verify network/live/runtime suites and commit.

### Task 4: Diagnostics and release gate
Files: connectionProgress.js, browserAuthorityRealtime.js, Board.jsx, package.json, package-lock.json, .github/workflows/main.yml, scripts/browser connection tests.
Interfaces: monotonic startedAt + stage since + attempt, bounded sanitized local events.
- [ ] Regress total elapsed/attempt count, readiness status, actual direct browser reload/live synchronization.
- [ ] Add clear status/recovery handling, bounded diagnostics, mandatory unit/build/browser checks before deployment.
- [ ] Run test:browser-authority, live/signaling suites, build and direct browser tests; commit.

### Task 5: Review and publish
- [ ] Fresh whole-branch review; reproduce and fix important findings.
- [ ] Verify final tests and current remote main; push without force, observe CI and Pages deployment.
