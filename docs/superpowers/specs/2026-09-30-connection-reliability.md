# Connection reliability upgrade

Approved scope: the user's eleven upgrades following the audit of c4fa57d.
Goal: existing owner/student board connections start reliably, survive transient failures, and explain failures accurately.
Constraints: existing Supabase/Ably/STUN only; Ably presence/signaling only; no TURN or new servers; no periodic full snapshots or snapshot compaction. Preserve teacher authority, durable acknowledgements, sequential initiator selection, and all board tools.

Design:
1. Use valid cancellable Web Locks requests; do not fail while another tab holds authority. Recreate the runtime on authority regain and reconcile readiness presence with actual runtime state.
2. Preserve active ICE replay. Fence all control messages with the pair's owner-issued attempt identifier and path generation. Ignore stale commands; retain legacy compatibility only where it cannot retire a known current attempt.
3. One student retry scheduler survives unchanged presence, with bounded exponential delay and jitter. Track the entire join separately from its stages.
4. Primary path uses no-progress timeout plus bounded overall deadline. Selected paths attempt coordinated ICE restart before teardown; live-channel replacement is initiated only by the native offerer. Recovery is bounded and failure escalates to the existing full reconnect.
5. Probe selected channels on online/focus/visible wake; collect bounded diagnostics without SDP, addresses or keys.
6. Forward validated student live envelopes through teacher WebRTC peers, preserving origin/sequence, excluding origin. Students trust relays only from their teacher.
7. Add regression and native-browser checks, including direct/no-TURN WebRTC and owner reload; gate deployment on mandatory checks.
