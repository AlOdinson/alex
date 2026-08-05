# Alex Board 1.30

Apple Pencil transform rendering is isolated from the size of the static board.

- On boards with 90+ objects, a Pencil drag renders the selected object(s) once into a transparent overlay.
- The rest of the board is rendered once as a frozen static scene and is not redrawn on every pointer move.
- Every move frame updates only one CSS transform on the overlay while Fabric continues calculating the authoritative object matrix.
- On release, the overlay is composited into the lower canvas immediately; a full Fabric reconciliation waits for genuine input idle.
- Pending reconciliation is cancelled as soon as the next Pencil contact begins, preventing background rendering from landing between consecutive drags.
- Mouse, finger, small boards, scaling and rotation keep their existing paths.
- The lightweight 1.29 transform persistence pipeline remains unchanged.
