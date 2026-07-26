import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

type ControlBody = {
  boardId?: unknown;
  boardKey?: unknown;
  action?: unknown;
  reason?: unknown;
};

const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const BOARD_KEY_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
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

      let body: ControlBody;
      try { body = await req.json(); } catch { return jsonError("Invalid JSON body", 400); }
      const boardId = typeof body.boardId === "string" ? body.boardId.trim() : "";
      const boardKey = typeof body.boardKey === "string" ? body.boardKey.trim() : "";
      const action = typeof body.action === "string" ? body.action.trim() : "";
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 120) : "library-closed";

      if (!BOARD_ID_PATTERN.test(boardId)) return jsonError("Invalid boardId", 400);
      if (!BOARD_KEY_PATTERN.test(boardKey)) return jsonError("Invalid boardKey", 400);
      if (action !== "force-exit") return jsonError("Unsupported action", 400);

      const keyHash = await sha256(boardKey);
      const { access, error } = await getBoardAccess(ctx, boardId, keyHash);
      if (error) return jsonError("Could not verify board access", 500);
      if (!access || String(access.permission ?? "") !== "owner") return jsonError("Owner access required", 403);

      const realtimeKey = String(access.realtime_key ?? "");
      if (!REALTIME_KEY_PATTERN.test(realtimeKey)) return jsonError("Board realtime configuration error", 500);

      const apiKey = Deno.env.get("ABLY_GAME_API_KEY") ?? Deno.env.get("ABLY_API_KEY");
      if (!apiKey) return jsonError("ABLY_GAME_API_KEY is missing", 500);
      const controlChannel = `game:${boardId}:${realtimeKey}:control`;
      const payload = {
        name: "force-exit",
        data: {
          boardId,
          reason,
          requestedAt: Date.now(),
          permission: "owner",
        },
      };

      try {
        const response = await fetch(
          `https://main.realtime.ably.net/channels/${encodeURIComponent(controlChannel)}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${btoa(apiKey)}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(payload),
          },
        );
        const text = await response.text();
        if (!response.ok) {
          console.error("Ably game force-exit failed", response.status, text);
          return jsonError("Could not publish force-exit", 502);
        }
        return Response.json({ delivered: true, channel: controlChannel }, {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        console.error("Ably game control connection error", error);
        return jsonError("Could not connect to game Ably", 502);
      }
    },
  ),
};
