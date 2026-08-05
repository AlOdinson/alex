# Alex Board 1.31.4

First-contact direct Apple Pencil selection and live-drag fix.

- The first Pencil pointerdown on an unselected object is now owned in native capture phase instead of waiting for Fabric's compatibility mouse route.
- The object becomes active immediately on that same first contact, so its border and controls are available before movement begins.
- That first physical gesture now uses the same cropped live compositor as a preselected object, including on small boards.
- Pointer moves are coalesced to one visual update per animation frame and move only the selected object's overlay.
- Pointerup commits the same lightweight transform operation used by the existing fast path; no full object serialization or board snapshot is added.
- A simple Pencil tap selects the object and leaves its frame visible without requiring a second tap.
- Preselected object/group, finger, mouse, marquee and hand-handle behavior remain unchanged.
