import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

type TokenRequestBody = {
  boardId?: unknown;
  boardKey?: unknown;
  clientId?: unknown;
};

const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const BOARD_KEY_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const REALTIME_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

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

async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToBase64Url(new Uint8Array(digest));
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

      let body: TokenRequestBody;
      try {
        body = await req.json();
      } catch {
        return jsonError("Invalid JSON body", 400);
      }

      const boardId = typeof body.boardId === "string" ? body.boardId.trim() : "";
      const boardKey = typeof body.boardKey === "string" ? body.boardKey.trim() : "";
      const requestedClientId = typeof body.clientId === "string" ? body.clientId.trim() : "";

      if (!BOARD_ID_PATTERN.test(boardId)) return jsonError("Invalid boardId", 400);
      if (!BOARD_KEY_PATTERN.test(boardKey)) return jsonError("Invalid boardKey", 400);

      const clientId = CLIENT_ID_PATTERN.test(requestedClientId)
        ? requestedClientId
        : `guest-${crypto.randomUUID()}`;

      const keyHash = await sha256(boardKey);

      let accessData;
      let accessError;
      ({ data: accessData, error: accessError } = await ctx.supabase.rpc(
        "get_board_access_v4",
        {
          p_id: boardId,
          p_key_hash: keyHash,
        },
      ));

      if (accessError && /function .* does not exist/i.test(accessError.message ?? "")) {
        ({ data: accessData, error: accessError } = await ctx.supabase.rpc(
          "get_board_access",
          {
            p_id: boardId,
            p_key_hash: keyHash,
          },
        ));
      }

      if (accessError) {
        console.error("Board access check failed", accessError);
        return jsonError("Could not verify board access", 500);
      }

      const access = Array.isArray(accessData) ? accessData[0] : accessData;
      if (!access) return jsonError("Board access denied", 403);

      if (String(access.permission ?? "") === "closed") {
        return jsonError("Board access is closed", 403);
      }

      const realtimeKey = String(access.realtime_key ?? "");
      if (!REALTIME_KEY_PATTERN.test(realtimeKey)) {
        console.error("Board has no valid realtime key", boardId);
        return jsonError("Board realtime configuration error", 500);
      }

      const apiKey = Deno.env.get("ABLY_API_KEY");
      if (!apiKey) {
        console.error("ABLY_API_KEY is missing");
        return jsonError("Server configuration error", 500);
      }

      const separatorIndex = apiKey.indexOf(":");
      if (separatorIndex <= 0 || separatorIndex === apiKey.length - 1) {
        console.error("ABLY_API_KEY has an invalid format");
        return jsonError("Server configuration error", 500);
      }

      const keyName = apiKey.slice(0, separatorIndex);
      const channelName = `board:${boardId}:${realtimeKey}`;
      const capability = {
        [channelName]: ["publish", "subscribe", "presence"],
      };

      try {
        const ablyResponse = await fetch(
          `https://main.realtime.ably.net/keys/${encodeURIComponent(keyName)}/requestToken`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${btoa(apiKey)}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              keyName,
              clientId,
              ttl: 60 * 60 * 1000,
              capability: JSON.stringify(capability),
              timestamp: Date.now(),
            }),
          },
        );

        const responseText = await ablyResponse.text();
        if (!ablyResponse.ok) {
          console.error("Ably token request failed", ablyResponse.status, responseText);
          return jsonError("Could not create Ably token", 502);
        }

        const tokenDetails = JSON.parse(responseText);
        return Response.json(tokenDetails, {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        console.error("Ably connection error", error);
        return jsonError("Could not connect to Ably", 502);
      }
    },
  ),
};
