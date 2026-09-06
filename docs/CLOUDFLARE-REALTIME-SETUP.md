# Cloudflare Realtime screen-share setup

This feature keeps normal screen sharing on direct WebRTC P2P by default. The host-only `Cloud` switch routes the already-captured screen track through Cloudflare Realtime SFU only when manually enabled.

## 1. Create a Cloudflare Realtime SFU application

In the Cloudflare dashboard, create one Realtime SFU application for Alex Board and copy its **App ID** and **App Secret**.

Treat the App Secret as a server credential. Do not add it to Vite variables, GitHub Pages variables, browser code, board signaling, logs, or screenshots.

## 2. Store the credentials in Supabase Edge Function secrets

Add these exact project secrets to the Supabase project that serves Alex Board:

```text
CLOUDFLARE_REALTIME_APP_ID=<Cloudflare App ID>
CLOUDFLARE_REALTIME_APP_SECRET=<Cloudflare App Secret>
```

The frontend must never receive either value directly. The App Secret is read only by `supabase/functions/cloudflare-realtime/index.ts`.

## 3. Deploy the Edge Function

Deploy the committed function source as `cloudflare-realtime`.

The function intentionally uses explicit `boardId + boardKey` authorization and is deployed with platform JWT verification disabled. Every request still validates live board access through `get_board_access_v4` (with the existing legacy fallback), and post-creation Cloudflare mutations additionally require a server-signed session lease.

The function may be deployed before the Cloudflare credentials exist. In that state Cloud requests fail closed with a configuration error, while the existing P2P screen-share path is unaffected.

## 4. Smoke test after secrets are configured

Use two real browsers/devices on the same board:

1. Host starts screen sharing and confirms the viewer sees the normal P2P picture.
2. Host clicks `Cloud ☐` on the upper-right corner of the live screen object.
3. Confirm no second screen picker appears.
4. Confirm the control reaches `Cloud ☑` and the viewer continues receiving the same screen through Cloudflare.
5. Join a late viewer while Cloud is active and confirm it receives the Cloud stream.
6. Clear the switch and confirm the viewer returns to the warm P2P stream without a new screen picker.
7. Re-enable Cloud after a deliberately failed/unavailable P2P connection and confirm the Cloud stream restores the picture.
8. Stop sharing and confirm the transient screen object and Cloud peers disappear.

Do not consider the live Cloud path verified until this matrix has been exercised with real Cloudflare credentials.

## Failure behavior

- Missing/invalid Cloudflare credentials: `Cloud` reports an error; P2P remains available.
- Cloudflare publisher failure: partial Cloud resources are closed; P2P remains active.
- One viewer cannot subscribe to Cloud: other Cloud viewers continue; that viewer keeps P2P when available.
- Removing `Cloud` while that viewer's P2P connection is independently dead can remove its picture again; the host can re-enable Cloud without restarting capture.

## Media behavior

Cloud reuses the same capture track and the existing adaptive quality targets: 1280x720 ideal, up to 1920x1080 capture, with 2/10/15 FPS activity profiles and the existing bitrate/degraded-network policy. P2P remains warm while Cloud is enabled so handback is immediate; this intentionally causes duplicate host upstream traffic during Cloud mode.
