# Alex Board 1.18

- Fixed the remaining Apple Pencil freeze after a successful eyedropper sample.
- The consumed Pencil contact still cannot leak into Pencil, line or shape creation.
- The sampling pointerup is now allowed to reach Fabric so Canvas can finish and clear its internal pointer/transform lifecycle.
- Drawing mode is restored on the next animation frame, after the sampling contact has fully ended.
- The fast finger eyedropper path, realtime protocol, persistence and serialized board format are unchanged.
