// Transient previews only: durable actions/history never use or await this lane.
// Opted-in boards keep one send and one newest pending preview, not a backlog of
// obsolete mouse/Pencil frames. Old boards do not instantiate the lane.
const MAX_OBJECTS = 100;
const MAX_BYTES = 48_000;
const encoder = new TextEncoder();
export function createBoundedTransformPreviewSender(publish) {
  let active = false;
  let closed = false;
  let pending = null;
  const run = async () => {
    if (active || closed) return;
    active = true;
    try {
      while (pending && !closed) {
        const entry = pending; pending = null;
        let outcome = 'ok';
        try {
          const objects = entry.payload.objects;
          for (let offset = 0; offset < objects.length && !closed; offset += MAX_OBJECTS) {
            const payload = { ...entry.payload,
              // The receiver fences sequence/end per session. Reusing the parent
              // id for all chunks would discard every chunk after the first.
              sessionId: `${entry.payload.sessionId}:bounded:${offset / MAX_OBJECTS}`,
              objects: objects.slice(offset, offset + MAX_OBJECTS),
            };
            if (encoder.encode(JSON.stringify(payload)).byteLength > MAX_BYTES) {
              // An exceptional oversized metadata field is not sent as a broken
              // preview. The complete durable transform still uses its own path.
              outcome = 'too-large'; continue;
            }
            await publish('transform', payload);
          }
        } catch {
          // A preview is optional. A failed broker publish must not become an
          // unhandled rejection or prevent object:modified from recording history.
          outcome = 'failed';
        }
        entry.resolve(closed ? 'closed' : outcome);
      }
    } finally { active = false; }
  };
  return {
    send(payload) {
      if (closed) return Promise.resolve('closed');
      return new Promise((resolve) => {
        pending?.resolve('superseded');
        pending = { payload, resolve };
        void run();
      });
    },
    close() {
      closed = true;
      pending?.resolve('closed'); pending = null;
    },
  };
}
