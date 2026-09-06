import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

type CloudRole = "publisher" | "viewer";
type CloudOperation =
  | "create-publisher-session"
  | "publish-track"
  | "create-viewer-session"
  | "subscribe-track"
  | "renegotiate-viewer"
  | "close-track";

type RequestBody = {
  boardId?: unknown;
  boardKey?: unknown;
  screenShareSessionId?: unknown;
  operation?: unknown;
  sessionId?: unknown;
  sessionLease?: unknown;
  publisherSessionId?: unknown;
  sdp?: unknown;
  mid?: unknown;
};

type SessionLeasePayload = {
  boardId: string;
  screenShareSessionId: string;
  cloudflareSessionId: string;
  role: CloudRole;
  exp: number;
};

type BoardAccessRpcError = { message?: string } | null;
type BoardAccessRpcResult = { data: unknown; error: BoardAccessRpcError };
type BoardAccessRpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<BoardAccessRpcResult>;
};
type BoardAccessRecord = { permission?: unknown };

const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const BOARD_KEY_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const SCREEN_SESSION_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const CLOUDFLARE_SESSION_PATTERN = /^[A-Za-z0-9_-]{6,256}$/;
const MID_PATTERN = /^[A-Za-z0-9_.:#-]{1,128}$/;
const MAX_SDP_LENGTH = 256 * 1024;
const SESSION_LEASE_TTL_MS = 2 * 60 * 60 * 1000;
const CLOUDFLARE_API_BASE = "https://rtc.live.cloudflare.com/v1";
const OPERATIONS = new Set<CloudOperation>([
  "create-publisher-session",
  "publish-track",
  "create-viewer-session",
  "subscribe-track",
  "renegotiate-viewer",
  "close-track",
]);

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlToBytes(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToBase64Url(new Uint8Array(digest));
}

async function importLeaseKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createSessionLease(
  secret: string,
  payload: Omit<SessionLeasePayload, "exp">,
) {
  const complete: SessionLeasePayload = {
    ...payload,
    exp: Date.now() + SESSION_LEASE_TTL_MS,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(complete));
  const payloadB64 = bytesToBase64Url(payloadBytes);
  const key = await importLeaseKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64),
  );
  return `${payloadB64}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function verifySessionLease(
  secret: string,
  token: string,
  expected: {
    boardId: string;
    screenShareSessionId: string;
    cloudflareSessionId: string;
    role?: CloudRole;
  },
) {
  const [payloadB64, signatureB64, extra] = String(token ?? "").split(".");
  if (!payloadB64 || !signatureB64 || extra) return null;

  try {
    const key = await importLeaseKey(secret);
    const validSignature = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signatureB64),
      new TextEncoder().encode(payloadB64),
    );
    if (!validSignature) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payloadB64)),
    ) as SessionLeasePayload;
    if (!payload || typeof payload !== "object") return null;
    if (payload.boardId !== expected.boardId) return null;
    if (payload.screenShareSessionId !== expected.screenShareSessionId) return null;
    if (payload.cloudflareSessionId !== expected.cloudflareSessionId) return null;
    if (expected.role && payload.role !== expected.role) return null;
    if (payload.role !== "publisher" && payload.role !== "viewer") return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function jsonError(message: string, status: number) {
  return Response.json(
    { error: message },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function validSdp(value: unknown) {
  const sdp = typeof value === "string" ? value : "";
  return sdp.length > 0 && sdp.length <= MAX_SDP_LENGTH ? sdp : "";
}

function cloudflareResponseHasError(data: unknown) {
  if (!data || typeof data !== "object") return true;
  const response = data as Record<string, unknown>;
  if (response.errorCode) return true;
  const tracks = Array.isArray(response.tracks) ? response.tracks : [];
  return tracks.some((track) => (
    track && typeof track === "object" && Boolean((track as Record<string, unknown>).errorCode)
  ));
}

async function callCloudflare(
  appId: string,
  appSecret: string,
  path: string,
  method: "POST" | "PUT",
  body: Record<string, unknown>,
) {
  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/apps/${encodeURIComponent(appId)}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${appSecret}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const responseText = await response.text();
  let data: unknown = {};
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error("Cloudflare Realtime returned non-JSON", response.status);
      throw new Error("cloudflare-invalid-response");
    }
  }

  if (!response.ok || cloudflareResponseHasError(data)) {
    console.error("Cloudflare Realtime request failed", response.status, data);
    throw new Error("cloudflare-request-failed");
  }
  return data as Record<string, unknown>;
}

export default {
  fetch: withSupabase(
    { auth: ["publishable", "secret"] },
    async (req, ctx) => {
      if (req.method !== "POST") {
        return new Response(null, {
          status: 405,
          headers: { Allow: "POST" },
        });
      }

      let body: RequestBody;
      try {
        body = await req.json();
      } catch {
        return jsonError("Invalid JSON body", 400);
      }

      const boardId = text(body.boardId);
      const boardKey = text(body.boardKey);
      const screenShareSessionId = text(body.screenShareSessionId);
      const operation = text(body.operation) as CloudOperation;

      if (!BOARD_ID_PATTERN.test(boardId)) return jsonError("Invalid boardId", 400);
      if (!BOARD_KEY_PATTERN.test(boardKey)) return jsonError("Invalid boardKey", 400);
      if (!SCREEN_SESSION_PATTERN.test(screenShareSessionId)) {
        return jsonError("Invalid screenShareSessionId", 400);
      }
      if (!OPERATIONS.has(operation)) return jsonError("Invalid operation", 400);

      const keyHash = await sha256(boardKey);
      const boardAccessClient = ctx.supabase as unknown as BoardAccessRpcClient;
      let accessData: unknown = null;
      let accessError: BoardAccessRpcError = null;
      ({ data: accessData, error: accessError } = await boardAccessClient.rpc(
        "get_board_access_v4",
        { p_id: boardId, p_key_hash: keyHash },
      ));

      if (accessError && /function .* does not exist/i.test(accessError.message ?? "")) {
        ({ data: accessData, error: accessError } = await boardAccessClient.rpc(
          "get_board_access",
          { p_id: boardId, p_key_hash: keyHash },
        ));
      }
      if (accessError) {
        console.error("Cloudflare board access check failed", accessError);
        return jsonError("Could not verify board access", 500);
      }

      const accessCandidate = Array.isArray(accessData) ? accessData[0] : accessData;
      const access = accessCandidate && typeof accessCandidate === "object"
        ? accessCandidate as BoardAccessRecord
        : null;
      if (!access) return jsonError("Board access denied", 403);
      const permission = String(access.permission ?? "view");
      if (permission === "closed") return jsonError("Board access is closed", 403);
      const canPublish = permission === "owner" || permission === "edit";

      const appId = Deno.env.get("CLOUDFLARE_REALTIME_APP_ID") ?? "";
      const appSecret = Deno.env.get("CLOUDFLARE_REALTIME_APP_SECRET") ?? "";
      if (!appId || !appSecret) {
        console.error("Cloudflare Realtime server configuration is missing");
        return jsonError("Cloud relay is not configured", 503);
      }

      const expectedTrackName = `screen:${boardId}:${screenShareSessionId}`;

      try {
        if (operation === "create-publisher-session") {
          if (!canPublish) return jsonError("Publisher permission required", 403);
          const data = await callCloudflare(appId, appSecret, "/sessions/new", "POST", {});
          const sessionId = text(data.sessionId);
          if (!CLOUDFLARE_SESSION_PATTERN.test(sessionId)) {
            throw new Error("cloudflare-invalid-session");
          }
          const sessionLease = await createSessionLease(appSecret, {
            boardId,
            screenShareSessionId,
            cloudflareSessionId: sessionId,
            role: "publisher",
          });
          return Response.json(
            { ...data, sessionId, sessionLease },
            { headers: { "Cache-Control": "no-store" } },
          );
        }

        if (operation === "create-viewer-session") {
          const data = await callCloudflare(appId, appSecret, "/sessions/new", "POST", {});
          const sessionId = text(data.sessionId);
          if (!CLOUDFLARE_SESSION_PATTERN.test(sessionId)) {
            throw new Error("cloudflare-invalid-session");
          }
          const sessionLease = await createSessionLease(appSecret, {
            boardId,
            screenShareSessionId,
            cloudflareSessionId: sessionId,
            role: "viewer",
          });
          return Response.json(
            { ...data, sessionId, sessionLease },
            { headers: { "Cache-Control": "no-store" } },
          );
        }

        const sessionId = text(body.sessionId);
        const sessionLease = text(body.sessionLease);
        if (!CLOUDFLARE_SESSION_PATTERN.test(sessionId) || !sessionLease) {
          return jsonError("Invalid Cloud session", 400);
        }

        if (operation === "publish-track") {
          if (!canPublish) return jsonError("Publisher permission required", 403);
          const lease = await verifySessionLease(appSecret, sessionLease, {
            boardId,
            screenShareSessionId,
            cloudflareSessionId: sessionId,
            role: "publisher",
          });
          if (!lease) return jsonError("Invalid Cloud session lease", 403);
          const sdp = validSdp(body.sdp);
          const mid = text(body.mid);
          if (!sdp || !MID_PATTERN.test(mid)) return jsonError("Invalid publish payload", 400);
          const data = await callCloudflare(
            appId,
            appSecret,
            `/sessions/${encodeURIComponent(sessionId)}/tracks/new`,
            "POST",
            {
              sessionDescription: { type: "offer", sdp },
              tracks: [{ location: "local", mid, trackName: expectedTrackName }],
            },
          );
          return Response.json(data, { headers: { "Cache-Control": "no-store" } });
        }

        if (operation === "subscribe-track") {
          const lease = await verifySessionLease(appSecret, sessionLease, {
            boardId,
            screenShareSessionId,
            cloudflareSessionId: sessionId,
            role: "viewer",
          });
          if (!lease) return jsonError("Invalid Cloud session lease", 403);
          const publisherSessionId = text(body.publisherSessionId);
          if (!CLOUDFLARE_SESSION_PATTERN.test(publisherSessionId)) {
            return jsonError("Invalid publisher session", 400);
          }
          const data = await callCloudflare(
            appId,
            appSecret,
            `/sessions/${encodeURIComponent(sessionId)}/tracks/new`,
            "POST",
            {
              tracks: [{
                location: "remote",
                sessionId: publisherSessionId,
                trackName: expectedTrackName,
              }],
            },
          );
          return Response.json(data, { headers: { "Cache-Control": "no-store" } });
        }

        if (operation === "renegotiate-viewer") {
          const lease = await verifySessionLease(appSecret, sessionLease, {
            boardId,
            screenShareSessionId,
            cloudflareSessionId: sessionId,
            role: "viewer",
          });
          if (!lease) return jsonError("Invalid Cloud session lease", 403);
          const sdp = validSdp(body.sdp);
          if (!sdp) return jsonError("Invalid renegotiation payload", 400);
          const data = await callCloudflare(
            appId,
            appSecret,
            `/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
            "PUT",
            { sessionDescription: { type: "answer", sdp } },
          );
          return Response.json(data, { headers: { "Cache-Control": "no-store" } });
        }

        if (operation === "close-track") {
          const lease = await verifySessionLease(appSecret, sessionLease, {
            boardId,
            screenShareSessionId,
            cloudflareSessionId: sessionId,
          });
          if (!lease) return jsonError("Invalid Cloud session lease", 403);
          if (lease.role === "publisher" && !canPublish) {
            return jsonError("Publisher permission required", 403);
          }
          const mid = text(body.mid);
          if (!MID_PATTERN.test(mid)) return jsonError("Invalid track mid", 400);
          const data = await callCloudflare(
            appId,
            appSecret,
            `/sessions/${encodeURIComponent(sessionId)}/tracks/close`,
            "PUT",
            {
              tracks: [{ mid }],
              force: true,
            },
          );
          return Response.json(data, { headers: { "Cache-Control": "no-store" } });
        }

        return jsonError("Unsupported operation", 400);
      } catch (error) {
        console.error("Cloudflare Realtime operation failed", operation, error);
        return jsonError("Cloud relay request failed", 502);
      }
    },
  ),
};
