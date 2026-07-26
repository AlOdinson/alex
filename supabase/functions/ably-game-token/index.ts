import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

type TokenRequestBody = {
  boardId?: unknown;
  boardKey?: unknown;
  clientId?: unknown;
  gameId?: unknown;
};

const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const BOARD_KEY_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const GAME_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;
const REALTIME_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function getBoardAccess(ctx: any, boardId: string, keyHash: string) {
  let data;
  let error;
  ({ data, error } = await ctx.supabase.rpc("get_board_access_v5", {
    p_id: boardId,
    p_key_hash: keyHash,
  }));
  if (error && /function .* does not exist/i.test(error.message ?? "")) {
    ({ data, error } = await ctx.supabase.rpc("get_board_access_v4", {
      p_id: boardId,
      p_key_hash: keyHash,
    }));
  }
  if (error && /function .* does not exist/i.test(error.message ?? "")) {
    ({ data, error } = await ctx.supabase.rpc("get_board_access", {
      p_id: boardId,
      p_key_hash: keyHash,
    }));
  }
  return { access: Array.isArray(data) ? data[0] : data, error };
}

export default {
  fetch: withSupabase(
    { auth: ["publishable", "secret"] },
    async (req, ctx) => {
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

      let body: TokenRequestBody;
      try { body = await req.json(); } catch { return jsonError("Invalid JSON body", 400); }

      const boardId = typeof body.boardId === "string" ? body.boardId.trim() : "";
      const boardKey = typeof body.boardKey === "string" ? body.boardKey.trim() : "";
      const requestedClientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      const gameId = typeof body.gameId === "string" ? body.gameId.trim() : "";

      if (!BOARD_ID_PATTERN.test(boardId)) return jsonError("Invalid boardId", 400);
      if (!BOARD_KEY_PATTERN.test(boardKey)) return jsonError("Invalid boardKey", 400);
      if (!GAME_ID_PATTERN.test(gameId)) return jsonError("Invalid gameId", 400);

      const clientId = CLIENT_ID_PATTERN.test(requestedClientId)
        ? requestedClientId
        : `game-${crypto.randomUUID()}`;
      const keyHash = await sha256(boardKey);
      const { access, error } = await getBoardAccess(ctx, boardId, keyHash);

      if (error) {
        console.error("Board access check failed", error);
        return jsonError("Could not verify board access", 500);
      }
      if (!access || String(access.permission ?? "") === "closed") return jsonError("Board access denied", 403);

      const realtimeKey = String(access.realtime_key ?? "");
      if (!REALTIME_KEY_PATTERN.test(realtimeKey)) return jsonError("Board realtime configuration error", 500);

      const apiKey = Deno.env.get("ABLY_GAME_API_KEY") ?? Deno.env.get("ABLY_API_KEY");
      if (!apiKey) return jsonError("ABLY_GAME_API_KEY is missing", 500);
      const separatorIndex = apiKey.indexOf(":");
      if (separatorIndex <= 0 || separatorIndex === apiKey.length - 1) return jsonError("Invalid Ably API key", 500);

      const keyName = apiKey.slice(0, separatorIndex);
      const roomChannel = `game:${boardId}:${realtimeKey}:${gameId}`;
      const controlChannel = `game:${boardId}:${realtimeKey}:control`;
      const capability = {
        [roomChannel]: ["publish", "subscribe", "presence"],
        [controlChannel]: ["subscribe"],
      };

      try {
        const response = await fetch(
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
        const text = await response.text();
        if (!response.ok) {
          console.error("Ably game token request failed", response.status, text);
          return jsonError("Could not create game token", 502);
        }
        return Response.json(JSON.parse(text), { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error("Ably game token connection error", error);
        return jsonError("Could not connect to game Ably", 502);
      }
    },
  ),
};
