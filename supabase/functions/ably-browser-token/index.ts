import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

type TokenRequestBody = {
  boardId?: unknown;
  roomKey?: unknown;
  clientId?: unknown;
};

const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const ROOM_KEY_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

function jsonError(message: string, status: number) {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function requestAblyToken({
  boardId,
  roomKey,
  clientId,
}: {
  boardId: string;
  roomKey: string;
  clientId: string;
}) {
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
  const channelName = `board:${boardId}:${roomKey}`;
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

    return new Response(responseText, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Ably connection error", error);
    return jsonError("Could not connect to Ably", 502);
  }
}

export default {
  fetch: withSupabase(
    { auth: "publishable" },
    async (req) => {
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
      const roomKey = typeof body.roomKey === "string" ? body.roomKey.trim() : "";
      const requestedClientId = typeof body.clientId === "string" ? body.clientId.trim() : "";

      if (!BOARD_ID_PATTERN.test(boardId)) return jsonError("Invalid boardId", 400);
      if (!ROOM_KEY_PATTERN.test(roomKey)) return jsonError("Invalid roomKey", 400);

      const clientId = CLIENT_ID_PATTERN.test(requestedClientId)
        ? requestedClientId
        : `guest-${crypto.randomUUID()}`;

      // The room secret is carried by the board link and is intentionally the only
      // authorization material for board realtime. No board row, snapshot, or other
      // durable data is read here.
      return requestAblyToken({ boardId, roomKey, clientId });
    },
  ),
};
