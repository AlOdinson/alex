function durableObjectId(value) {
  const id = String(value?.boardObjectId ?? '').trim();
  return id || null;
}

export function planCanonicalBoardClear({
  visibleRecords = [],
  authoritySnapshot = null,
} = {}) {
  const safeVisibleRecords = (Array.isArray(visibleRecords) ? visibleRecords : [])
    .filter((record) => durableObjectId(record?.object));

  const deleteIds = new Set(
    safeVisibleRecords.map((record) => durableObjectId(record.object)).filter(Boolean),
  );

  const authorityObjects = Array.isArray(authoritySnapshot?.canvas?.objects)
    ? authoritySnapshot.canvas.objects
    : [];
  for (const object of authorityObjects) {
    const id = durableObjectId(object);
    if (id) deleteIds.add(id);
  }

  return {
    deleteIds: [...deleteIds],
    undoRecords: safeVisibleRecords,
  };
}
