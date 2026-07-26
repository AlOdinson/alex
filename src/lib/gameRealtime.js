import { isSupabaseConfigured, supabase } from './supabase.js';

const CONNECT_TIMEOUT = 9000;
const GAME_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function normalizeParticipant(member) {
  const data = member?.data ?? {};
  const clientId = String(member?.clientId ?? data.clientId ?? '');
  if (!clientId) return null;
  return {
    clientId,
    name: String(data.name ?? 'Участник'),
    permission: String(data.permission ?? 'view'),
    joinedAt: Number(data.joinedAt ?? Date.now()),
  };
}

function sortParticipants(participants) {
  return participants.slice().sort((left, right) => (
    Number(left.joinedAt ?? 0) - Number(right.joinedAt ?? 0)
    || String(left.clientId).localeCompare(String(right.clientId))
  ));
}

function createLocalFallback({ roomTopic, controlTopic, clientId, participant, onEvent, onParticipants, onForceExit, onStatus }) {
  const room = new BroadcastChannel(`alex-board:${roomTopic}`);
  const control = new BroadcastChannel(`alex-board:${controlTopic}`);
  const members = new Map([[clientId, participant]]);
  let disconnected = false;

  const refresh = () => onParticipants?.(sortParticipants([...members.values()]));
  const announcePresence = () => {
    room.postMessage({ event: 'presence', payload: participant, senderId: clientId });
  };

  room.onmessage = ({ data }) => {
    if (!data || data.senderId === clientId) return;
    if (data.event === 'presence') {
      const next = data.payload;
      if (next?.clientId) members.set(String(next.clientId), next);
      refresh();
      room.postMessage({ event: 'presence-ack', payload: participant, senderId: clientId });
      return;
    }
    if (data.event === 'presence-ack') {
      const next = data.payload;
      if (next?.clientId) members.set(String(next.clientId), next);
      refresh();
      return;
    }
    if (data.event === 'leave') {
      members.delete(String(data.payload?.clientId ?? ''));
      refresh();
      return;
    }
    onEvent?.(data.event, data.payload);
  };

  control.onmessage = ({ data }) => {
    if (!data || data.senderId === clientId) return;
    if (data.event === 'force-exit') onForceExit?.(data.payload ?? {});
  };

  refresh();
  announcePresence();
  onStatus?.('local');

  return {
    kind: 'local',
    publish(event, payload) {
      if (disconnected) return Promise.resolve('closed');
      room.postMessage({ event, payload, senderId: clientId });
      return Promise.resolve('ok');
    },
    async disconnect() {
      if (disconnected) return;
      disconnected = true;
      room.postMessage({ event: 'leave', payload: { clientId }, senderId: clientId });
      room.close();
      control.close();
    },
  };
}

export async function connectGameRealtime({
  boardId,
  boardKey,
  realtimeKey,
  gameId,
  clientId,
  name,
  permission,
  onEvent,
  onParticipants,
  onForceExit,
  onStatus,
}) {
  if (!GAME_ID_PATTERN.test(String(gameId ?? ''))) throw new Error('Некорректный идентификатор игры');

  const roomTopic = `game:${boardId}:${realtimeKey}:${gameId}`;
  const controlTopic = `game:${boardId}:${realtimeKey}:control`;
  const joinedAt = Date.now();
  const participant = { clientId, name, permission, joinedAt };

  if (!isSupabaseConfigured || !window.Ably?.Realtime) {
    return createLocalFallback({
      roomTopic,
      controlTopic,
      clientId,
      participant,
      onEvent,
      onParticipants,
      onForceExit,
      onStatus,
    });
  }

  let disconnected = false;
  let roomChannel = null;
  let controlChannel = null;
  let client = null;

  try {
    client = new window.Ably.Realtime({
      clientId,
      useTokenAuth: true,
      echoMessages: false,
      authCallback: async (_tokenParams, callback) => {
        try {
          const { data, error } = await supabase.functions.invoke('ably-game-token', {
            body: { boardId, boardKey, clientId, gameId },
          });
          if (error) throw error;
          if (!data?.token) throw new Error('Игровой token endpoint не вернул токен');
          callback(null, data);
        } catch (error) {
          callback(error, null);
        }
      },
      disconnectedRetryTimeout: 5000,
      suspendedRetryTimeout: 15000,
    });

    client.connection.on((change) => {
      const state = change?.current ?? client?.connection?.state;
      onStatus?.(state ?? 'unknown');
    });

    await withTimeout(
      client.connection.once('connected'),
      CONNECT_TIMEOUT,
      'Не удалось подключиться к игровому Ably',
    );
    if (disconnected) throw new Error('Игровое соединение закрыто');

    roomChannel = client.channels.get(roomTopic);
    controlChannel = client.channels.get(controlTopic);

    await withTimeout(
      roomChannel.subscribe((message) => onEvent?.(message?.name, message?.data ?? {})),
      CONNECT_TIMEOUT,
      'Не удалось подключиться к игровой комнате',
    );
    await withTimeout(
      controlChannel.subscribe('force-exit', (message) => onForceExit?.(message?.data ?? {})),
      CONNECT_TIMEOUT,
      'Не удалось подключиться к управляющему каналу игротеки',
    );

    const refreshParticipants = async () => {
      if (disconnected || !roomChannel) return;
      try {
        const members = await roomChannel.presence.get();
        const unique = new Map();
        members.forEach((member) => {
          const normalized = normalizeParticipant(member);
          if (normalized) unique.set(normalized.clientId, normalized);
        });
        onParticipants?.(sortParticipants([...unique.values()]));
      } catch (error) {
        console.warn('Не удалось обновить участников игровой комнаты', error);
      }
    };

    roomChannel.presence.subscribe(refreshParticipants);
    await roomChannel.presence.enter(participant);
    await refreshParticipants();
    onStatus?.('connected');

    return {
      kind: 'ably',
      publish(event, payload) {
        if (disconnected || !roomChannel) return Promise.resolve('closed');
        return roomChannel.publish(event, payload);
      },
      async disconnect() {
        if (disconnected) return;
        disconnected = true;
        try {
          await roomChannel?.presence.leave();
        } catch {
          // Connection can already be gone on mobile sleep or page close.
        }
        try {
          roomChannel?.presence.unsubscribe();
          roomChannel?.unsubscribe();
          controlChannel?.unsubscribe();
        } catch {
          // Ignore detach errors.
        }
        try {
          client?.close();
        } catch {
          // Ignore close errors.
        }
      },
    };
  } catch (error) {
    try {
      client?.close();
    } catch {
      // Ignore close errors.
    }
    onStatus?.('solo');
    console.warn('Игровой Ably недоступен, игра продолжит работу в одиночном режиме', error);
    return {
      kind: 'solo',
      publish() {
        return Promise.resolve('solo');
      },
      disconnect() {
        disconnected = true;
        return Promise.resolve();
      },
    };
  }
}

export async function forceExitGameParticipants({ boardId, boardKey, reason = 'library-closed' }) {
  if (!isSupabaseConfigured) {
    // Local development fallback: broadcast to every game control room is not enumerable,
    // so Board.jsx additionally persists the hidden flag and open game tabs verify it on focus.
    return { delivered: false, local: true };
  }
  const { data, error } = await supabase.functions.invoke('ably-game-control', {
    body: { boardId, boardKey, action: 'force-exit', reason },
  });
  if (error) throw error;
  return data ?? { delivered: true };
}
