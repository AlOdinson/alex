# Notebook child-operation consumer inventory

Base: main f766f220 / 1.42.1. The feature is not enabled in the production runtime.

| Boundary | Current implementation | Verification |
| --- | --- | --- |
| Protocol types, affected IDs, authorization and parent locks | operationProtocol, notebookOperations, teacherPeerHub, teacherBoardRuntime | core / peer / lock suites |
| Authority preflight and ordered replay | authorityOperationEvaluator, authoritySnapshot, browserBoardAuthority | atomic split history, action identity, duplicate commit, 20-page core tests |
| Durable baseline, commit journal, child tombstones | browserAuthorityStore schema 3; baseline and individual child deletion rows are separate from mutable metadata | notebook-storage; successful and aborted schema migration, rollback, restart/undo |
| Permission checks | metadata-only reader used by teacherBoardRuntime | no baseline serialization per remote action; authority/runtime suite |
| Wire and old readers | notebookProtocol, teacherPeerHub, studentPeerSession | negotiated capability, transport replacement, update-required read-only notice, unsupported versions rejected |
| Replica and offline journal | browserReplicaStore, studentOfflineCache | authority/replica/archive equality, duplicates, unknown versions do not advance head |
| History | historyOperations, notebookOperations | compact conditional inverse, sequential undo/redo, parent frame separate from page content |
| Integrity hashes | notebookRecords, notebookVerification, boundedVerificationState/Digest/Protocol, boundedBoardVerifier | domain/versioned frame/page/child hashes, stale revision fence, targeted page repairs |
| Integrity peer wiring | teacherPeerHub, studentPeerSession, browserBoardSession, browserReplicaStore | digest-version advertisement and selected replica view |
| Canvas integrity | boundedCanvasVerifier, boardNotebook immutable record boundary | hidden-page hash cache; visible children remain independently checked |
| Image/media traversal | imageStorage and mediaReferences recursively inspect arrays/objects; studentOfflineCache recursively normalizes image sources | notebook-image journal dedup, retention through deletion and final-reference cleanup; no new asset store |
| Page delta adapter | notebookPageRuntime + BoardNotebook.applyPreparedPageDelta | real Fabric subset revival, clipping/transparency/eraser pixel equivalence, load/navigation/retirement races |
| UI live/durable writers | Board.jsx still uses legacy notebook edits; Task 5 must replace capture/text/erase/navigation and both incoming-op helpers together | not activated; browser/UI gates not yet run |
| Pending intent replay | notebookSession + browserAuthorityStore outbox (not UI-wired) | ordered saves, lost ack/reload/dedup, 300 reverse acknowledgements, rejection and lease loss |

Ably, TURN, server infrastructure, screen-share codec, bitrate, FPS and resolution
settings are unchanged. No periodic full-board sweep or snapshot compaction added.
The compatibility notice is not a flattened view of the notebook.
