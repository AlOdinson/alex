# Alex Board 1.17

- Changed the eyedropper toolbar action for Apple Pencil from touchstart to touchend.
- Prevented the sampling Pencil contact from leaking into Pencil, line or shape creation.
- Restored the active drawing tool only after the sampling Pencil has been lifted.
- Suppressed only the consumed Pencil move/up events; the existing fast finger path is unchanged.
- No realtime, persistence or serialized board format changes.
