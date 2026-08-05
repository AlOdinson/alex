# Alex Board 1.31.3

Direct single-object Apple Pencil live-drag hotfix.

- A direct Pencil contact on an unselected object now activates that object synchronously before Fabric handles the same pointerdown.
- The single-object selection border and controls are visible from the first contact instead of appearing only after release.
- Fabric mouse-compatibility events belonging to an active Pencil session are now classified as Pencil in `before:transform`.
- The cropped live compositor starts before the object moves its first pixel, preserving the true origin and preventing teleporting.
- Spatial hit-testing remains as a fallback for thin paths when Safari does not return a Fabric target.
- Preselected object/group, finger, mouse and marquee behavior are unchanged.
