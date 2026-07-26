import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBoardAccess } from '../lib/boardRepository.js';
import { connectGameRealtime } from '../lib/gameRealtime.js';
import { randomToken } from '../lib/ids.js';

const MAX_GAME_PARTICIPANTS = 4;
const STATE_INTERVAL_MS = 100;
const ACTIVE_DISCONNECT_GRACE_MS = 3000;

const GAMES = [
  {
    id: 'percentage-ladybug-maze',
    title: 'Жучок и процентный лабиринт',
    description: 'Проведи божью коровку через лабиринт, решай задачи на проценты и успей добраться до мёда раньше воды.',
    tags: ['Проценты', 'Лабиринт', 'WASD, стрелки и джойстик'],
    icon: '🐞',
    path: 'games/percentage-ladybug-maze/index.html?embedded=1',
  },
];

function sortParticipants(participants) {
  return participants.slice().sort((left, right) => (
    Number(left.joinedAt ?? 0) - Number(right.joinedAt ?? 0)
    || String(left.clientId).localeCompare(String(right.clientId))
  ));
}

function participantLabel(participant) {
  if (!participant) return 'Участник';
  return participant.permission === 'owner'
    ? `${participant.name} · учитель`
    : participant.name;
}

export default function GameLibrary({
  boardId,
  boardKey,
  realtimeKey,
  boardTitle,
  participantName,
  participantClientId,
  permission,
  onExit,
}) {
  const [selectedGameId, setSelectedGameId] = useState(null);
  const [gameStatus, setGameStatus] = useState('Загрузка…');
  const [networkStatus, setNetworkStatus] = useState('Одиночный режим');
  const [participants, setParticipants] = useState([]);
  const [controlState, setControlState] = useState({
    activePlayerId: null,
    epoch: 0,
    issuedAt: 0,
  });
  const [frameReady, setFrameReady] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [roomFull, setRoomFull] = useState(false);
  const [hasInitialState, setHasInitialState] = useState(false);

  const frameRef = useRef(null);
  const realtimeRef = useRef(null);
  const participantsRef = useRef([]);
  const controlStateRef = useRef(controlState);
  const hasInitialStateRef = useRef(false);
  const wasActiveRef = useRef(false);
  const selectedGameIdRef = useRef(null);
  const actionSequenceRef = useRef(0);
  const stateTickRef = useRef(0);
  const pendingFullRequestsRef = useRef(new Map());
  const pendingTransferRef = useRef(null);
  const missingActiveTimerRef = useRef(null);
  const onExitRef = useRef(onExit);

  const selectedGame = useMemo(
    () => GAMES.find((game) => game.id === selectedGameId) ?? null,
    [selectedGameId],
  );
  const isOwner = permission === 'owner';
  const activeParticipant = participants.find((item) => item.clientId === controlState.activePlayerId) ?? null;
  const isActivePlayer = Boolean(selectedGameId && controlState.activePlayerId === participantClientId);

  useEffect(() => { onExitRef.current = onExit; }, [onExit]);
  useEffect(() => { participantsRef.current = participants; }, [participants]);
  useEffect(() => {
    controlStateRef.current = controlState;
  }, [controlState]);
  useEffect(() => { selectedGameIdRef.current = selectedGameId; }, [selectedGameId]);
  useEffect(() => { hasInitialStateRef.current = hasInitialState; }, [hasInitialState]);

  const postToGame = useCallback((type, payload = {}) => {
    const target = frameRef.current?.contentWindow;
    if (!target) return;
    target.postMessage({
      source: 'alex-board-host',
      type,
      payload,
      sentAt: Date.now(),
    }, window.location.origin);
  }, []);

  const focusGameInput = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    try { frame.focus({ preventScroll: true }); } catch { frame.focus?.(); }
    try { frame.contentWindow?.focus?.(); } catch { /* Same-origin iframe focus can still be rejected transiently. */ }
    postToGame('GAME_FOCUS_INPUT');
  }, [postToGame]);

  const applyControlState = useCallback((message) => {
    const nextEpoch = Number(message?.epoch ?? 0);
    const nextActive = String(message?.activePlayerId ?? '');
    if (!nextActive || !Number.isFinite(nextEpoch)) return;

    const current = controlStateRef.current;
    if (nextEpoch < Number(current.epoch ?? 0)) return;

    if (nextEpoch === Number(current.epoch ?? 0) && current.activePlayerId && current.activePlayerId !== nextActive) {
      const ordered = sortParticipants(participantsRef.current);
      const currentIndex = ordered.findIndex((item) => item.clientId === current.activePlayerId);
      const nextIndex = ordered.findIndex((item) => item.clientId === nextActive);
      if (currentIndex >= 0 && (nextIndex < 0 || currentIndex < nextIndex)) return;
    }

    const next = {
      activePlayerId: nextActive,
      epoch: nextEpoch,
      issuedAt: Number(message?.issuedAt ?? Date.now()),
    };
    controlStateRef.current = next;
    setControlState(next);
    setTransferBusy(false);
    if (nextActive === participantClientId) {
      window.requestAnimationFrame(() => focusGameInput());
    }
  }, [focusGameInput, participantClientId]);

  const publishControl = useCallback(async (activePlayerId, epoch, reason) => {
    const payload = {
      activePlayerId,
      epoch,
      reason,
      actorId: participantClientId,
      actorPermission: permission,
      issuedAt: Date.now(),
    };
    applyControlState(payload);
    await realtimeRef.current?.publish('control', payload);
  }, [applyControlState, participantClientId, permission]);

  const publishFullState = useCallback(async (state, {
    requestId = null,
    targetClientId = null,
    activePlayerId = controlStateRef.current.activePlayerId,
    epoch = controlStateRef.current.epoch,
    reason = 'snapshot',
  } = {}) => {
    await realtimeRef.current?.publish('full-state', {
      senderId: participantClientId,
      requestId,
      targetClientId,
      activePlayerId,
      epoch,
      reason,
      state,
      sentAt: Date.now(),
    });
  }, [participantClientId]);

  const finishTransferWithState = useCallback(async (transfer, state) => {
    if (!transfer || !state) return;
    const nextEpoch = Math.max(Number(controlStateRef.current.epoch ?? 0) + 1, Number(transfer.epoch ?? 0));
    await publishFullState(state, {
      requestId: transfer.requestId,
      targetClientId: transfer.targetClientId,
      activePlayerId: transfer.targetClientId,
      epoch: nextEpoch,
      reason: transfer.reason,
    });
    await publishControl(transfer.targetClientId, nextEpoch, transfer.reason);
    pendingTransferRef.current = null;
    setTransferBusy(false);
  }, [publishControl, publishFullState]);

  const requestLocalFullState = useCallback((meta) => {
    const requestId = meta?.requestId ?? randomToken(14);
    pendingFullRequestsRef.current.set(requestId, meta ?? {});
    postToGame('GAME_GET_FULL_STATE', { requestId });
    return requestId;
  }, [postToGame]);

  const beginTransfer = useCallback(async (targetClientId, reason = 'voluntary-transfer') => {
    const target = participantsRef.current.find((item) => item.clientId === targetClientId);
    if (!target || transferBusy) return;

    const current = controlStateRef.current;
    const allowed = current.activePlayerId === participantClientId || isOwner;
    if (!allowed) return;

    const requestId = randomToken(16);
    const transfer = {
      requestId,
      targetClientId,
      epoch: Number(current.epoch ?? 0) + 1,
      reason,
    };
    pendingTransferRef.current = transfer;
    setTransferBusy(true);
    if (targetClientId === participantClientId) focusGameInput();
    postToGame('GAME_SET_CONTROL_ENABLED', { enabled: false });

    if (current.activePlayerId === participantClientId) {
      requestLocalFullState({ kind: 'transfer', transfer, requestId });
      return;
    }

    // Teacher can take control while observing. Ask the current player for the freshest
    // full state; if they do not answer, use the teacher's latest 10 Hz observer state.
    await realtimeRef.current?.publish('state-request', {
      requestId,
      requesterId: participantClientId,
      targetActivePlayerId: current.activePlayerId,
      purpose: 'teacher-take-control',
      sentAt: Date.now(),
    });

    window.setTimeout(() => {
      if (pendingTransferRef.current?.requestId !== requestId) return;
      requestLocalFullState({ kind: 'transfer', transfer, requestId });
    }, 900);
  }, [focusGameInput, isOwner, participantClientId, postToGame, requestLocalFullState, transferBusy]);

  const handleRealtimeEventRef = useRef(null);
  handleRealtimeEventRef.current = async (event, payload) => {
    if (!payload || payload.senderId === participantClientId) return;

    if (event === 'control') {
      applyControlState(payload);
      return;
    }

    if (event === 'state') {
      const incomingEpoch = Number(payload.epoch ?? -1);
      if (payload.activePlayerId && incomingEpoch >= Number(controlStateRef.current.epoch ?? 0)) {
        applyControlState(payload);
      }
      const current = controlStateRef.current;
      if (incomingEpoch !== Number(current.epoch ?? 0)) return;
      if (String(payload.activePlayerId ?? '') !== String(current.activePlayerId ?? '')) return;
      if (payload.activePlayerId === participantClientId) return;
      if (!hasInitialStateRef.current) return;
      postToGame('GAME_APPLY_SYNC_STATE', {
        state: payload.state,
        tick: payload.tick,
        sentAt: payload.sentAt,
      });
      return;
    }

    if (event === 'action') {
      const current = controlStateRef.current;
      if (Number(payload.epoch ?? -1) !== Number(current.epoch ?? 0)) return;
      if (String(payload.senderId ?? '') !== String(current.activePlayerId ?? '')) return;
      postToGame('GAME_APPLY_ACTION', { action: payload.action });
      return;
    }

    if (event === 'state-request') {
      if (controlStateRef.current.activePlayerId !== participantClientId) return;
      if (payload.targetActivePlayerId && payload.targetActivePlayerId !== participantClientId) return;
      requestLocalFullState({
        kind: 'state-response',
        requestId: payload.requestId,
        targetClientId: payload.requesterId,
      });
      return;
    }

    if (event === 'full-state') {
      const targetClientId = String(payload.targetClientId ?? '');
      if (targetClientId && targetClientId !== participantClientId) return;

      const pendingTransfer = pendingTransferRef.current;
      if (pendingTransfer && payload.requestId === pendingTransfer.requestId && isOwner) {
        hasInitialStateRef.current = true;
        setHasInitialState(true);
        postToGame('GAME_APPLY_FULL_STATE', { state: payload.state });
        await finishTransferWithState(pendingTransfer, payload.state);
        return;
      }

      const incomingEpoch = Number(payload.epoch ?? 0);
      if (incomingEpoch < Number(controlStateRef.current.epoch ?? 0)) return;
      if (payload.activePlayerId && incomingEpoch >= Number(controlStateRef.current.epoch ?? 0)) {
        applyControlState(payload);
      }
      hasInitialStateRef.current = true;
      setHasInitialState(true);
      postToGame('GAME_APPLY_FULL_STATE', { state: payload.state });
    }
  };

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const updateViewportSize = () => {
      const viewport = window.visualViewport;
      const width = Math.max(1, Math.round(viewport?.width ?? window.innerWidth));
      const height = Math.max(1, Math.round(viewport?.height ?? window.innerHeight));
      root.style.setProperty('--alex-game-viewport-width', `${width}px`);
      root.style.setProperty('--alex-game-viewport-height', `${height}px`);
    };
    updateViewportSize();
    root.classList.add('game-viewport-locked');
    body.classList.add('game-viewport-locked');
    window.addEventListener('resize', updateViewportSize);
    window.visualViewport?.addEventListener('resize', updateViewportSize);
    window.visualViewport?.addEventListener('scroll', updateViewportSize);
    return () => {
      root.classList.remove('game-viewport-locked');
      body.classList.remove('game-viewport-locked');
      root.style.removeProperty('--alex-game-viewport-width');
      root.style.removeProperty('--alex-game-viewport-height');
      window.removeEventListener('resize', updateViewportSize);
      window.visualViewport?.removeEventListener('resize', updateViewportSize);
      window.visualViewport?.removeEventListener('scroll', updateViewportSize);
    };
  }, []);

  useEffect(() => {
    if (!selectedGame) return undefined;
    let cancelled = false;
    setParticipants([]);
    setControlState({ activePlayerId: null, epoch: 0, issuedAt: 0 });
    controlStateRef.current = { activePlayerId: null, epoch: 0, issuedAt: 0 };
    setNetworkStatus('Подключение к игровой комнате…');
    setRoomFull(false);
    hasInitialStateRef.current = false;
    setHasInitialState(false);
    wasActiveRef.current = false;

    connectGameRealtime({
      boardId,
      boardKey,
      realtimeKey,
      gameId: selectedGame.id,
      clientId: participantClientId,
      name: participantName,
      permission,
      onEvent: (event, payload) => handleRealtimeEventRef.current?.(event, payload),
      onParticipants: (nextParticipants) => {
        const ordered = sortParticipants(nextParticipants);
        participantsRef.current = ordered;
        setParticipants(ordered);
        setRoomFull(ordered.length > MAX_GAME_PARTICIPANTS
          && ordered.slice(0, MAX_GAME_PARTICIPANTS).every((item) => item.clientId !== participantClientId));
      },
      onForceExit: () => onExitRef.current?.({ gameLibraryVisible: false, reason: 'force-exit' }),
      onStatus: (status) => {
        if (status === 'connected') setNetworkStatus('Общая игровая комната');
        else if (status === 'solo') setNetworkStatus('Одиночный режим · игровой Ably недоступен');
        else if (status === 'local') setNetworkStatus('Локальная тестовая комната');
        else if (status === 'disconnected' || status === 'suspended') setNetworkStatus('Переподключение…');
      },
    }).then((connection) => {
      if (cancelled) {
        connection.disconnect();
        return;
      }
      realtimeRef.current = connection;
      window.setTimeout(() => {
        const current = controlStateRef.current;
        if (current.activePlayerId === participantClientId && connection.kind !== 'solo') {
          connection.publish('control', {
            activePlayerId: current.activePlayerId,
            epoch: current.epoch,
            reason: 'connection-ready',
            actorId: participantClientId,
            actorPermission: permission,
            issuedAt: Date.now(),
          });
        }
      }, 0);
      if (connection.kind === 'solo') {
        const soloParticipant = {
          clientId: participantClientId,
          name: participantName,
          permission,
          joinedAt: Date.now(),
        };
        participantsRef.current = [soloParticipant];
        setParticipants([soloParticipant]);
        hasInitialStateRef.current = true;
        setHasInitialState(true);
        applyControlState({ activePlayerId: participantClientId, epoch: 1, issuedAt: Date.now() });
      }
    });

    return () => {
      cancelled = true;
      window.clearTimeout(missingActiveTimerRef.current);
      missingActiveTimerRef.current = null;
      realtimeRef.current?.disconnect();
      realtimeRef.current = null;
      participantsRef.current = [];
      pendingFullRequestsRef.current.clear();
      pendingTransferRef.current = null;
    };
  }, [
    applyControlState,
    boardId,
    boardKey,
    participantClientId,
    participantName,
    permission,
    realtimeKey,
    selectedGame,
  ]);

  useEffect(() => {
    if (!selectedGame || !participants.length || roomFull) return undefined;
    const current = controlStateRef.current;
    const ordered = sortParticipants(participants).slice(0, MAX_GAME_PARTICIPANTS);
    const activeStillPresent = ordered.some((item) => item.clientId === current.activePlayerId);

    if (!current.activePlayerId) {
      const candidate = ordered[0];
      if (candidate?.clientId === participantClientId) {
        publishControl(participantClientId, Math.max(1, Number(current.epoch ?? 0) + 1), 'initial-player');
      }
      return undefined;
    }

    if (activeStillPresent) {
      window.clearTimeout(missingActiveTimerRef.current);
      missingActiveTimerRef.current = null;
      return undefined;
    }

    postToGame('GAME_APPLY_ACTION', { action: { kind: 'input', x: 0, y: 0 } });
    window.clearTimeout(missingActiveTimerRef.current);
    missingActiveTimerRef.current = window.setTimeout(() => {
      const latest = sortParticipants(participantsRef.current).slice(0, MAX_GAME_PARTICIPANTS);
      const teacher = latest.find((item) => item.permission === 'owner');
      const candidate = teacher ?? latest[0];
      if (candidate?.clientId === participantClientId) {
        publishControl(candidate.clientId, Number(controlStateRef.current.epoch ?? 0) + 1, 'active-player-disconnected');
      }
    }, ACTIVE_DISCONNECT_GRACE_MS);

    return () => window.clearTimeout(missingActiveTimerRef.current);
  }, [participantClientId, participants, publishControl, roomFull, selectedGame]);

  useEffect(() => {
    if (!selectedGame || !frameReady) return;
    postToGame('GAME_SET_NETWORK_MODE', {
      mode: participants.length <= 1 ? 'solo' : (isActivePlayer ? 'active' : 'observer'),
      controlEnabled: isActivePlayer && !transferBusy,
      activePlayerId: controlState.activePlayerId,
      participantClientId,
      participantName,
    });

    if (isActivePlayer && !transferBusy) {
      window.requestAnimationFrame(() => focusGameInput());
    }

    if (!isActivePlayer && wasActiveRef.current && participants.length >= 2) {
      hasInitialStateRef.current = false;
      setHasInitialState(false);
    }
    if (isActivePlayer) {
      hasInitialStateRef.current = true;
      setHasInitialState(true);
    }
    wasActiveRef.current = isActivePlayer;
  }, [
    controlState.activePlayerId,
    focusGameInput,
    frameReady,
    isActivePlayer,
    participantClientId,
    participantName,
    participants.length,
    postToGame,
    selectedGame,
    transferBusy,
  ]);

  useEffect(() => {
    if (!selectedGame || !frameReady || isActivePlayer || participants.length < 2 || hasInitialState) {
      return undefined;
    }
    const request = () => {
      realtimeRef.current?.publish('state-request', {
        requestId: randomToken(14),
        requesterId: participantClientId,
        targetActivePlayerId: controlState.activePlayerId,
        purpose: 'join-room',
        sentAt: Date.now(),
      });
    };
    request();
    const timer = window.setInterval(request, 900);
    return () => window.clearInterval(timer);
  }, [
    controlState.activePlayerId,
    frameReady,
    hasInitialState,
    isActivePlayer,
    participantClientId,
    participants.length,
    selectedGame,
  ]);

  useEffect(() => {
    if (!selectedGame || !frameReady || !isActivePlayer || participants.length < 2) return undefined;
    const timer = window.setInterval(() => {
      postToGame('GAME_GET_SYNC_STATE', { requestId: `tick-${stateTickRef.current + 1}` });
    }, STATE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [frameReady, isActivePlayer, participants.length, postToGame, selectedGame]);

  useEffect(() => {
    let checking = false;
    const verifyLibraryAccess = async () => {
      if (checking) return;
      checking = true;
      try {
        const access = await getBoardAccess(boardId, boardKey);
        if (!access?.gameLibraryVisible) onExitRef.current?.({ gameLibraryVisible: false, reason: 'library-hidden' });
      } catch {
        // A temporary database failure should not throw a player out of a running game.
      } finally {
        checking = false;
      }
    };
    verifyLibraryAccess();
    const timer = window.setInterval(verifyLibraryAccess, 3000);
    const onFocus = () => verifyLibraryAccess();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [boardId, boardKey]);

  useEffect(() => {
    function handleMessage(event) {
      if (event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || message.source !== 'alex-board-game') return;
      if (message.gameId !== selectedGameIdRef.current) return;

      if (message.type === 'GAME_READY') {
        setFrameReady(true);
        setGameStatus('Готово');
        return;
      }
      if (message.type === 'GAME_STARTED') {
        setGameStatus('Игра идёт');
        return;
      }
      if (message.type === 'GAME_FINISHED') {
        setGameStatus(message.payload?.result === 'won' ? 'Победа' : 'Игра окончена');
        return;
      }

      if (message.type === 'GAME_ACTION') {
        if (controlStateRef.current.activePlayerId !== participantClientId) return;
        if (participantsRef.current.length < 2) return;
        const action = message.payload?.action;
        if (!action) return;
        realtimeRef.current?.publish('action', {
          senderId: participantClientId,
          epoch: controlStateRef.current.epoch,
          sequence: ++actionSequenceRef.current,
          action,
          sentAt: Date.now(),
        });
        return;
      }

      if (message.type === 'GAME_SYNC_STATE') {
        if (controlStateRef.current.activePlayerId !== participantClientId) return;
        if (participantsRef.current.length < 2) return;
        realtimeRef.current?.publish('state', {
          senderId: participantClientId,
          activePlayerId: participantClientId,
          epoch: controlStateRef.current.epoch,
          tick: ++stateTickRef.current,
          state: message.payload?.state,
          sentAt: Date.now(),
        });
        return;
      }

      if (message.type === 'GAME_FULL_STATE_PUSH') {
        if (controlStateRef.current.activePlayerId !== participantClientId) return;
        if (participantsRef.current.length < 2) return;
        publishFullState(message.payload?.state, {
          reason: message.payload?.reason ?? 'authoritative-push',
        });
        return;
      }

      if (message.type === 'GAME_FULL_STATE') {
        const requestId = message.payload?.requestId;
        const state = message.payload?.state;
        const pending = requestId ? pendingFullRequestsRef.current.get(requestId) : null;
        if (requestId) pendingFullRequestsRef.current.delete(requestId);
        if (!state) return;

        if (pending?.kind === 'transfer') {
          finishTransferWithState(pending.transfer, state);
          return;
        }
        if (pending?.kind === 'state-response') {
          publishFullState(state, {
            requestId,
            targetClientId: pending.targetClientId,
            reason: 'state-response',
          });
        }
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [finishTransferWithState, participantClientId, publishFullState]);

  if (selectedGame) {
    const gameUrl = `${import.meta.env.BASE_URL}${selectedGame.path}`;
    const visibleParticipants = sortParticipants(participants).slice(0, MAX_GAME_PARTICIPANTS);
    return (
      <main className="game-player-page">
        <header className="game-player-header">
          <button
            type="button"
            className="game-back-button"
            onClick={() => {
              setSelectedGameId(null);
              setGameStatus('Загрузка…');
              setFrameReady(false);
            }}
          >
            ← Игротека
          </button>

          <div className="game-player-title">
            <strong>{selectedGame.title}</strong>
            <span>{participantName} · {boardTitle}</span>
          </div>

          <div className="game-room-summary">
            <span className="game-status-pill">{gameStatus}</span>
            <span className="game-network-pill">{networkStatus}</span>
          </div>

          <button type="button" className="game-exit-button" onClick={() => onExit()}>
            На доску
          </button>
        </header>

        <section className="game-room-bar" aria-label="Участники игровой комнаты">
          <div className="game-room-active">
            <span>Сейчас играет</span>
            <strong>{participantLabel(activeParticipant)}</strong>
          </div>
          <div className="game-room-participants">
            {visibleParticipants.map((participant) => {
              const isCurrentPlayer = participant.clientId === controlState.activePlayerId;
              const canAssignControl = isOwner || isActivePlayer;
              const transferReason = isOwner ? 'teacher-assign-control' : 'voluntary-transfer';
              return (
                <button
                  type="button"
                  className={isCurrentPlayer ? 'is-active' : ''}
                  key={participant.clientId}
                  disabled={transferBusy || isCurrentPlayer || !canAssignControl}
                  aria-label={isCurrentPlayer
                    ? `${participantLabel(participant)} сейчас играет`
                    : `Передать управление: ${participantLabel(participant)}`}
                  title={isCurrentPlayer
                    ? 'Сейчас управляет игрой'
                    : canAssignControl
                      ? 'Передать управление этому участнику'
                      : 'Только активный игрок или учитель может передавать управление'}
                  onClick={() => beginTransfer(participant.clientId, transferReason)}
                >
                  {participantLabel(participant)}
                </button>
              );
            })}
          </div>
          <div className="game-control-actions">
            {isOwner && !isActivePlayer && (
              <button
                type="button"
                className="teacher-take-control"
                disabled={transferBusy || !activeParticipant}
                onClick={() => beginTransfer(participantClientId, 'teacher-take-control')}
              >
                Забрать управление
              </button>
            )}
          </div>
        </section>

        {roomFull ? (
          <section className="game-room-full">
            <h2>В игровой комнате уже четыре участника</h2>
            <p>Вернись на доску и присоединись, когда освободится место.</p>
            <button type="button" className="game-exit-button" onClick={() => onExit()}>На доску</button>
          </section>
        ) : (
          <section className="game-frame-wrap" aria-label={selectedGame.title}>
            {!isActivePlayer && participants.length >= 2 && !hasInitialState && (
              <div className="game-sync-overlay">Подключение к текущей игре…</div>
            )}
            <iframe
              ref={frameRef}
              key={selectedGame.id}
              className="game-frame"
              src={gameUrl}
              title={selectedGame.title}
              tabIndex={0}
              onLoad={() => {
                if (controlStateRef.current.activePlayerId === participantClientId) focusGameInput();
              }}
              allow="fullscreen"
              sandbox="allow-scripts allow-same-origin"
            />
          </section>
        )}
      </main>
    );
  }

  return (
    <main className="game-library-page">
      <header className="game-library-header">
        <div className="game-library-header-copy">
          <h1>Игротека</h1>
          <p>{participantName} · {boardTitle}</p>
        </div>
        <button type="button" className="game-exit-button" onClick={() => onExit()}>
          Вернуться на доску
        </button>
      </header>

      <section className="game-library-content">
        <p className="game-library-intro">
          Один участник играет, остальные наблюдают. Управление можно добровольно передать,
          а преподаватель в любой момент может забрать его. Движение синхронизируется командами
          и контрольным состоянием десять раз в секунду.
        </p>

        <div className="game-card-grid">
          {GAMES.map((game) => (
            <article className="game-card" key={game.id}>
              <div className="game-card-preview">
                <div>
                  <span className="game-card-preview-icon" aria-hidden="true">{game.icon}</span>
                  <strong>Доберись до мёда</strong>
                </div>
              </div>
              <div className="game-card-body">
                <h2>{game.title}</h2>
                <p>{game.description}</p>
                <div className="game-card-tags">
                  {game.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
                <button
                  type="button"
                  className="game-start-button"
                  onClick={() => {
                    setGameStatus('Загрузка…');
                    setFrameReady(false);
                    setSelectedGameId(game.id);
                  }}
                >
                  Играть
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
