# Alex Board 1.08

Base: 1.07

- Fixed Fabric 7 ActiveSelection detection using class/API checks instead of the obsolete lowercase string.
- Group move/scale/rotate now records one transform history action with member IDs and absolute matrices.
- Undo returns the whole moved selection to its previous position.
- ActiveSelection is no longer serialized or sent as a giant standalone board object.
- Native marquee selections receive outer-only controls immediately, preventing per-child control rendering stalls.
- Existing old-version selection transaction receive compatibility remains unchanged.
