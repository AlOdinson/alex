# Notebook 1.43.0 release candidate

Base: f766f2207495d52576cfee6bb4e2b8e6605f2bf8 (1.42.1).
This document describes the candidate, not proof that it is deployed.

## Changes

- Board gestures use versioned notebook child operations, compact conditional undo/redo and atomic outside-fragment groups.
- New strokes appear without waiting for network acknowledgement. Confirmed state is separate from ordered pending intents. Durable IndexedDB outbox retains action identities through reload; duplicate live tabs use separate actors.
- Incoming edits update only affected visible children. Hidden pages remain immutable records. Page/frame targets are captured at physical gesture start; an asynchronously changed target is rejected without silently writing to another page.
- Notebook rendering keeps the existing cache/compositor fast path. Rasterized text encodes its immutable bitmap once. No screen-share quality downgrade, TURN, new server, periodic full-board scan or scheduled compaction was added.
- Storage schema 3 separates immutable checkpoint payloads, metadata, child tombstones and local outbox. Failed upgrade transactions preserve old data. Older writers must reload; no rollback to an old writer on migrated journals.
- Peer negotiation distinguishes unknown from legacy clients. First child-operation migration requires all connected clients support version 1. On a migrated board an unsupported client sees a reload notice, not incomplete live content; current clients can continue editing.

## Activation and rollback

`VITE_NOTEBOOK_OPERATIONS_V1=true` is an explicit build-time switch. The main deployment and candidate CI use this flag only with the complete reader/writer/UI implementation. Local builds without the flag keep it disabled.

A production rollback must retain schema-3 readers and notebookVersion=1 replay. Do not install 1.42.1 as a writer over already-migrated storage. Full legacy checkpoints remain readable, and a failed storage migration is transactional. The historical The-Board-Lvl2 branch is not a safe writer rollback for newly migrated notebooks.

## Verification boundary

Local evidence: 172 notebook Node tests, actual production Board callback bodies executed with Fabric/Node-canvas, real authority/store/replica code and a 300-stroke delayed-ack test. The full authority, storage, connections, screen-share, sync, media, pencil and bounded-verification command groups passed; both build-flag configurations compiled. A Node-canvas test is not browser, video-decoder or physical-device verification.

Release CI must also pass actual Chromium and WebKit tests: direct SCTP peers with 20x300 pages and 600 added edits; actual React notebook tools/history/reload; stage-B incremental-session structural gates; received 720p60/1080p60 video with 20x300+300 pending strokes; PDF continuity and shared student asset lifecycle.

The local environment refuses browser navigation with ERR_BLOCKED_BY_ADMINISTRATOR. No alternative local navigation route was used. Browser validation must run as a normal repository job on its own runner, never by tunnelling to the blocked local service. Physical iPad/iPhone tests remain manual and were not performed. Final code review is an author self-review; no independent reviewer tool is available. Existing large-bundle/dynamic-import warnings are not addressed by this focused release.
