# Event-driven integrity checks for new boards

Approved in the conversation on 2026-09-25; user explicitly requested implementation.

## Contract
- Opt in only at new local board creation (`integrityVersion: 1`), preserving the marker through fresh-owner recovery and duplication. Existing records default off. No migration, backend schema change, or rewrite of old boards.
- Confirmed operations (including history, deletion, moves and properties) mark work; live pointer motion does not. Existing action delivery, history semantics, retry/recovery and legacy insurance mechanisms remain unchanged.
- One verifier per board session; up to 100 IDs per batch; 200 ms quiet debounce, 1000 ms maximum scheduling delay, at least 250 ms between batches; cooperative work target 4 ms with bounded token/string traversal. These are scheduling targets, not hardware guarantees.
- Prefer up to 80 affected IDs + 20 rotating earlier/extra Canvas IDs; spare slots may be borrowed. Queue at most 1000 distinct IDs, latest generation only; overflow requests a finite incremental rescan, never loses user operations.
- No newly introduced periodic 5/30-second poll, check timeout or 1/2/4-second retry policy. Existing connection mechanisms remain untouched. Event-created work may drain in several batches while idle.
- Compare authoritative records at the same revision and negotiated peer session. Stale responses and changes during comparison/repair are discarded and cannot erase new work.
- Primary teacher is the authority. A capable student checks bounded fingerprints against that authority, repairs only mismatched records, then compares its Canvas to the committed replica. Owner checks its Canvas against its authority. Verification is outside durable acknowledgement and undo queues.
- Deletion is a positive absence assertion; extra Canvas or replica objects enter rotating checks. Group operation semantics stay atomic; only audits are split into <=100 IDs.
- Repair protects active local/remote gestures and pending local changes. Technical repairs do not create user history. Full snapshot remains existing recovery fallback, not a per-action mechanism.
- Peer capability negotiation must avoid sending new message types to legacy clients. Disconnect/board switch closes pending audit resources. No checker exception can reject an already committed action.

## Verification
Tests must cover old/new gating, debounce/max-wait, no overlap, queue overflow, 100-object cap, same-revision old-content corruption, deletion/restore, transforms/order, stale session/revision, repeated undo, dropped connections and cooperative traversal. Exercise production callbacks and native browser Canvas, plus existing authority/history/sync/build suites. Physical devices not available here must be reported NOT RUN.
