# Alex Board 1.19

## Apple Pencil eyedropper contact-lifecycle fix

- Apple Pencil no longer applies the sampled style during `pointerdown`.
- The target point is remembered and the style is committed only after the Pencil `pointerup` has reached Fabric.
- Removed pointer capture from the eyedropper path.
- Removed the normal post-stroke palm grace delay for eyedropper contacts.
- The finger/mouse eyedropper path remains immediate.
- Pencil, line and shape modes are restored after the old contact is fully closed, so the next Pencil stroke can begin without waiting for the hand to leave the screen.
