# Browser Authority final physical-network E2E checklist

Use this only against the temporary `/preview-browser-authority/` deployment.

## Already covered automatically

The hosted Chromium gates already verify on every browser-authority push:

- new-board creation and guest-link bootstrap through the real UI;
- Ably presence and WebRTC DataChannel establishment;
- teacher → student and student → teacher durable drawing with teacher ACK/revisions;
- student reload/reconnect and authoritative catch-up;
- browser offline → online reconnect, including a teacher commit while the student is offline and a student durable edit after reconnect;
- image transfer without Supabase Storage;
- durable image undo/redo;
- view-only enforcement;
- teacher reload from IndexedDB;
- exclusive owner-tab Web Lock, including blocking a second owner tab and authority takeover after the first owner closes.

Do not repeat those as a large manual regression suite unless debugging a failure.

## Final manual merge gate: different physical networks/NATs

This is the one environment hosted CI cannot reproduce faithfully because the release intentionally uses direct WebRTC with STUN and **no TURN relay**.

Setup:

- Teacher: laptop/desktop on normal Wi-Fi, open the preview home page.
- Student: a phone/tablet/second computer on a genuinely different network, preferably cellular data with Wi-Fi disabled.
- Create a **new** board in the preview. Old Supabase-era boards are intentionally not migrated.

Required pass:

1. Teacher creates the new board and copies the guest link.
2. Student opens the guest link over the other network and reaches the board.
3. Teacher draws one pencil stroke; student receives the authoritative result.
4. Student draws one pencil stroke; teacher receives it and the durable save completes.
5. Leave both sides connected for roughly a minute and confirm the session does not fall into a reconnect/error loop.

If all five pass, the direct-P2P physical-network merge gate is complete.

## Direct-only networking note

The board uses `stun:stun.cloudflare.com:3478` for NAT discovery and no TURN relay. If the same build passes hosted E2E but cannot establish a peer connection on a restrictive/corporate/symmetric-NAT network, that can be a direct-P2P reachability limitation rather than a board-state defect. Record both networks and the browser connection status. Adding TURN later would broaden reachability but is intentionally outside the current architecture.

## Merge gate

Do not merge PR #61 into `main` until the five-step physical-network pass above succeeds, or until the release owner explicitly accepts the known direct-only reachability limitation and chooses to ship without that physical test.

Keep the temporary preview deployment available until that decision is made. After merge, remove the temporary preview-only deployment machinery so normal `main` Pages deployment remains the production path.
