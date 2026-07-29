export function createCreationInputController({
  getSelectedToolId,
  getTool,
  createContext,
  normalizeEvent,
  canStart,
  onError = (error) => console.error(error),
}) {
  let activeSession = null;
  let sessionCounter = 0;

  function ownsEvent(event, session = activeSession) {
    if (!session || event?.pointerId == null) return false;
    return String(session.pointerId) === String(event.pointerId);
  }

  function stopPointerBeforeOtherHandlers(event, { preventDefault = true } = {}) {
    if (preventDefault) event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
  }

  function start(event) {
    if (activeSession) {
      // One physical contact owns the creation session. Keep secondary PointerEvents
      // away from Fabric while leaving the separate TouchEvent stream available for zoom.
      stopPointerBeforeOtherHandlers(event, { preventDefault: false });
      return true;
    }

    const toolId = getSelectedToolId?.();
    const tool = toolId ? getTool?.(toolId) : null;
    if (!tool || canStart?.(event, toolId) === false) return false;

    const input = normalizeEvent(event);
    if (!input) return false;

    const session = {
      id: `creation-${Date.now().toString(36)}-${(++sessionCounter).toString(36)}`,
      pointerId: event.pointerId,
      pointerType: event.pointerType || 'unknown',
      toolId,
      tool,
      captureTarget: event.currentTarget ?? null,
      startedAt: performance.now(),
      input,
      data: null,
      finished: false,
    };

    activeSession = session;
    stopPointerBeforeOtherHandlers(event);
    try {
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is an optimization, not a requirement.
    }

    try {
      session.data = tool.begin?.(createContext(session), session, input) ?? null;
      return true;
    } catch (error) {
      activeSession = null;
      session.finished = true;
      try {
        tool.cancel?.(createContext(session), session, input, 'begin-error');
      } catch {
        // Preserve the original begin error.
      }
      onError(error, { phase: 'begin', session });
      return true;
    }
  }

  function move(event) {
    const session = activeSession;
    if (!session) return false;
    if (!ownsEvent(event, session)) {
      stopPointerBeforeOtherHandlers(event, { preventDefault: false });
      return true;
    }

    stopPointerBeforeOtherHandlers(event);
    const input = normalizeEvent(event);
    if (!input) return true;
    try {
      session.tool.move?.(createContext(session), session, input);
    } catch (error) {
      onError(error, { phase: 'move', session });
      cancel('move-error', event);
    }
    return true;
  }

  function finish(event, phase = 'end') {
    const session = activeSession;
    if (!session || !ownsEvent(event, session)) return false;

    // Free the input synchronously before commit/realtime/path finalization. A new
    // physical contact may therefore start another tool without waiting for any timer.
    activeSession = null;
    session.finished = true;
    stopPointerBeforeOtherHandlers(event);

    const input = normalizeEvent(event) ?? session.input;
    try {
      if (phase === 'cancel') {
        session.tool.cancel?.(createContext(session), session, input, event?.type || 'pointercancel');
      } else {
        session.tool.end?.(createContext(session), session, input);
      }
    } catch (error) {
      onError(error, { phase, session });
    } finally {
      try {
        (event.currentTarget ?? session.captureTarget)?.releasePointerCapture?.(event.pointerId);
      } catch {
        // Ignore browsers that released capture automatically.
      }
    }
    return true;
  }

  function end(event) {
    return finish(event, 'end');
  }

  function cancel(reason = 'cancelled', event = null) {
    const session = activeSession;
    if (!session) return false;
    activeSession = null;
    session.finished = true;
    if (event) stopPointerBeforeOtherHandlers(event);
    try {
      session.tool.cancel?.(
        createContext(session),
        session,
        event ? (normalizeEvent(event) ?? session.input) : session.input,
        reason,
      );
    } catch (error) {
      onError(error, { phase: 'cancel', session });
    } finally {
      try {
        session.captureTarget?.releasePointerCapture?.(session.pointerId);
      } catch {
        // Ignore browsers that released capture automatically.
      }
    }
    return true;
  }

  return {
    start,
    move,
    end,
    cancelEvent(event) {
      return finish(event, 'cancel');
    },
    cancel,
    getActiveSession() {
      return activeSession;
    },
    ownsEvent,
  };
}
