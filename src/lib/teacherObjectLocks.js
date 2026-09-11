const DEFAULT_TTL_MS = 12_000;
const MIN_TTL_MS = 6_000;
const MAX_TTL_MS = 30_000;
const MAX_OBJECT_IDS = 10_000;

function cleanString(value) {
  return String(value ?? '').trim();
}

function uniqueObjectIds(value) {
  const ids = [...new Set((Array.isArray(value) ? value : [])
    .map(cleanString)
    .filter(Boolean))];
  if (!ids.length || ids.length > MAX_OBJECT_IDS) {
    throw new Error('Invalid object lock count');
  }
  return ids;
}

function safeTtl(value) {
  const requested = Number(value);
  const ttl = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(ttl)));
}

export function createTeacherObjectLockAuthority({ now = () => Date.now() } = {}) {
  const locks = new Map();

  const cleanupExpired = () => {
    const timestamp = Number(now());
    for (const [objectId, lock] of locks) {
      if (Number(lock?.expiresAt ?? 0) <= timestamp) locks.delete(objectId);
    }
    return timestamp;
  };

  return {
    acquire({ clientId, lockToken, objectIds, ttlMs } = {}) {
      const safeClientId = cleanString(clientId);
      const safeLockToken = cleanString(lockToken);
      if (!safeClientId) throw new Error('clientId is required');
      if (safeLockToken.length < 8) throw new Error('Invalid lock token');
      const safeIds = uniqueObjectIds(objectIds);
      const timestamp = cleanupExpired();

      const conflicts = safeIds.flatMap((objectId) => {
        const lock = locks.get(objectId);
        if (!lock || lock.clientId === safeClientId) return [];
        return [{
          objectId,
          clientId: lock.clientId,
          expiresAt: lock.expiresAt,
        }];
      });
      if (conflicts.length) {
        return {
          granted: false,
          objectIds: safeIds,
          lockToken: safeLockToken,
          conflicts,
        };
      }

      const expiresAt = timestamp + safeTtl(ttlMs);
      const requestedIds = new Set(safeIds);
      for (const [objectId, lock] of locks) {
        if (lock.clientId === safeClientId && !requestedIds.has(objectId)) locks.delete(objectId);
      }
      safeIds.forEach((objectId) => {
        locks.set(objectId, {
          objectId,
          clientId: safeClientId,
          lockToken: safeLockToken,
          acquiredAt: timestamp,
          expiresAt,
        });
      });

      return {
        granted: true,
        objectIds: safeIds,
        lockToken: safeLockToken,
        expiresAt,
        conflicts: [],
      };
    },

    refresh({ clientId, lockToken, ttlMs } = {}) {
      const safeClientId = cleanString(clientId);
      const safeLockToken = cleanString(lockToken);
      if (!safeClientId) throw new Error('clientId is required');
      if (safeLockToken.length < 8) throw new Error('Invalid lock token');
      const timestamp = cleanupExpired();
      const objectIds = [...locks.entries()]
        .filter(([, lock]) => lock.clientId === safeClientId && lock.lockToken === safeLockToken)
        .map(([objectId]) => objectId)
        .sort();
      if (!objectIds.length) {
        return {
          refreshed: false,
          objectIds: [],
          lockToken: safeLockToken,
          expiresAt: timestamp,
        };
      }

      const expiresAt = timestamp + safeTtl(ttlMs);
      objectIds.forEach((objectId) => {
        const lock = locks.get(objectId);
        if (lock) locks.set(objectId, { ...lock, expiresAt });
      });
      return {
        refreshed: true,
        objectIds,
        lockToken: safeLockToken,
        expiresAt,
      };
    },

    release({ clientId, lockToken = null } = {}) {
      const safeClientId = cleanString(clientId);
      const safeLockToken = lockToken == null ? null : cleanString(lockToken);
      if (!safeClientId) throw new Error('clientId is required');
      cleanupExpired();
      const objectIds = [];
      for (const [objectId, lock] of locks) {
        if (lock.clientId !== safeClientId) continue;
        if (safeLockToken != null && lock.lockToken !== safeLockToken) continue;
        locks.delete(objectId);
        objectIds.push(objectId);
      }
      objectIds.sort();
      return {
        released: objectIds.length,
        objectIds,
      };
    },
  };
}
