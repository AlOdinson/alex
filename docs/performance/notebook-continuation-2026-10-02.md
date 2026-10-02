# Notebook performance continuation — 2026-10-02

## Exact restart point

Base main: `f766f2207495d52576cfee6bb4e2b8e6605f2bf8`, version 1.42.1.
Branch: `feature/notebook-performance-continuation-20261002`.
Plan: `docs/superpowers/plans/2026-10-02-notebook-performance.md`.
Spec: `docs/superpowers/specs/2026-10-02-notebook-performance.md`.

The previous Work session's unpublished files were not available in this session.
Only stage A was found on main. This continuation implements the Task 3 child
operation foundation from that verified base; it does not claim to recover Work's
unpublished implementation. Main and the deployed version remain unchanged.

Publication status: GitHub blocked the subsequent source write with
"couldn't determine the safety status of the request". The implementation was
NOT committed or pushed. The remote feature branch still contains only the
initial CI/bootstrap commit c2b7df76f9f5c1f27e339afd87c5886a2d352c58.
The patch and modified source files are preserved in the conversation archive.

## Implemented and locally verified

- `notebookOperations.js`: version-1 insert/patch/delete, copy-on-write addressed
  pages, immutable changed children, strict validation, separate child tombstones,
  guarded restores and compact inverses. Hidden page children are not traversed.
- Parent notebook IDs remain the authorization/lease targets.
- Authority preflight stages dependent compound operations in intent order and
  rejects the complete atomic group on a member conflict. Replay uses the same
  intent order for compound/notebook actions, retaining ordinary batch reordering.
- History no longer clones notebook pages for child operations or frame-only
  inverses. Per-deletion mutation identities survive aggregated page history.
- Undo/redo preserves editable text and content guards. Transport timestamps do
  not invalidate earlier history when later edits are undone. Replacement inverses
  restore child type and order as a guarded compound delete/restore.
- The production authority still rejects notebook proposals explicitly with
  `notebook_protocol_disabled`; a caller cannot activate the protocol by adding
  `notebookVersion:1` to its action. No new writer, wire rollout or migration exists.

## Verification evidence

TDD: 16 initial tests were run before implementation (15 expected failures, one
existing invariant passed). Four edge cases, action identity propagation,
sequential history restamping, and null compound entries were reproduced as
failing tests before their fixes.

Current `npm run test:notebook`: **43 passing tests**, including 24 new child-op
regressions and 19 existing notebook tests. A seeded 60-action sequence over 20
pages is fully undone and redone with changing action/mutation identities.

Locally passed after the final changes:

```
npm run test:notebook
node scripts/benchmark-notebook-operations.mjs
npm run test:browser-authority
npm run test:student:storage
npm run test:connections
npm run test:screen-share
npm run test:sync:ci
npm run build
```

The build retains existing warnings about large chunks and mixed static/dynamic
imports of mediaAssetStore. They were not hidden or presented as newly fixed.

Local Chromium execution was attempted but the environment blocked navigation to
127.0.0.1 with `ERR_BLOCKED_BY_ADMINISTRATOR`. The revised feature-branch workflow is prepared locally
to run existing notebook UI, stage-A performance and actual received test-video
checks in Chromium and WebKit, but its update was NOT published after the tool
write block. No browser CI result for this implementation exists. Those tests
would exercise the legacy writer, not an activated child-op UI.
No physical iPad/iPhone or real teacher/student network test was performed here.

Pure core fixture results are in `notebook-child-core-2026-10-02.json`: 300 strokes
per page, 40 points per stroke, 1/6/12/20 pages. The 20-page forward/inverse payloads
were 736/675 bytes. This excludes network, durable storage, Fabric rendering,
video and device input latency; it is not a whole-application speedup claim.

## Review and rulings

Final review is self-review by the implementer (no independent reviewer tool).
Seven demonstrated edge issues were covered and corrected before the final suite:
compound reorder replay, merged deletion identity, tombstone enumeration,
replacement type/order inverse, authority action identity, timestamp-only history
conflicts, and null operation entries.

1. Preserve main and keep wire activation disabled until Tasks 4–5 pass. Cost:
   the compact core is not yet a user-visible performance improvement.
2. Use a temporary read-only Actions source/dependency artifact because local
   network cloning/package installation was unavailable. No credentials or .git
   were included; the original artifact expires after two days. The locally prepared
   replacement workflow removes these bundle uploads; it has not been published.
3. Sequential application is required for compound/notebook operations so replay
   agrees with preflight; independent ordinary operations keep existing batched
   layer semantics. Cost if incorrect: ordering regressions, guarded by the full
   existing authority/history suite and new dependent-fragment regression.
4. Child content guards ignore updatedAt/updatedBy, matching ordinary board history
   semantics, but compare all other content fields and deletion mutation identity.
   Cost if incorrect: a metadata-only change does not count as a content conflict.

Deferred minor issues: none introduced by this continuation. Existing build
warnings are outside this task, not new performance claims.

## Not completed — resume here

Task 4: inventory and implement every reader/writer; negotiate notebookVersion=1;
persist/replay child tombstones and journal operations across teacher/replica/offline
storage; protect unsupported clients; avoid rewriting immutable baseline snapshots;
version and incrementally update verification digests; validate asset references.

Task 5: implement notebookSession with bounded ordered pending intents, immediate
preview, acknowledgements/rejections/rebase/reconnect, stable gesture page, lease
loss and parent deletion handling; apply only changed visible Fabric children;
exercise 300 rapid strokes and atomic split history. Do not activate before these
end-to-end paths pass together.

Task 7: immutable image encoding and final-reference lifecycle work remains.
Task 8: full activated-protocol browser/video/soak gates, independent review,
staged release and physical-device tests remain. Tasks 1/2/6 were already present
in stage A; do not reimplement them or mistake their browser gates for Release B.
