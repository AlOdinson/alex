# Alex Board 1.31.10

Large-board Apple Pencil selection-frame fix.

- Keeps the 1.31.9 hit-test, repeat-drag and spatial-index fixes.
- For boards with 90+ Fabric objects, the fast cropped Pencil compositor now creates a dedicated lightweight controls layer.
- The active border, rotation square and group hand handle are captured together and translated with exactly the same CSS transform as the moving object/group layer.
- Fabric's stationary top layer is cleared and temporarily suppressed during the isolated drag, preventing a second frame from remaining at the origin.
- The controls layer is never composited into the board's lower canvas; it is discarded at pointer-up and Fabric renders one final frame at the destination.
- No full-board render is added to pointermove.
