# Browser Authority two-browser E2E checklist

Use this only against the temporary `/preview-browser-authority/` deployment.

## Setup

- Teacher: desktop browser on the preview home page.
- Student: separate browser/profile or device. Prefer a different network for the final pass (for example desktop Wi-Fi + phone cellular/hotspot).
- Create a **new** board in the preview. Old Supabase-era boards are intentionally not migrated.

## Required pass

1. Teacher creates a new board and draws text + pencil + shape.
2. Teacher opens Share, copies the guest link, and opens it on the student browser.
3. Student receives the full current board without a page refresh.
4. Teacher draws/moves/deletes objects; student sees live preview and authoritative final state.
5. Student draws/moves/deletes objects; teacher receives the durable change and the student does not report saved before teacher ACK.
6. Insert an image on the teacher side; student receives it over the peer channel and can reload without needing Supabase Storage.
7. Run undo/redo from both sides, including a stale/conflicting object edit. Newer remote edits must not be overwritten.
8. Switch guest mode to **view**. Student must still sync but must not acquire a lock or commit an edit.
9. Switch back to **edit** and confirm editing resumes without recreating the board.
10. Reload the student. It must reconnect to the same teacher and resync from its local revision or a fresh snapshot.
11. Temporarily disconnect the student network, reconnect it, and confirm the peer session is recreated and catches up.
12. Close/reopen the teacher board tab. The board must restore from teacher IndexedDB. Student should reconnect once the teacher tab is available again.
13. Verify a second teacher tab does not become a second authority for the same board.

## Direct-only networking note

The board uses STUN for NAT discovery and no TURN relay. A failure only on restrictive/corporate/symmetric-NAT networks may therefore be a direct-P2P reachability limitation rather than a board-state bug. Record the browser console/connection status if that occurs.

## Merge gate

Do not merge PR #61 into `main` until the required pass succeeds in two real browsers. After verification, remove the temporary preview deployment workflow before or immediately after merge so normal `main` Pages deployment remains the only deployment path.
