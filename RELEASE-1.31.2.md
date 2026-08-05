# Alex Board 1.31.2

Apple Pencil live-transform animation hotfix.

- Fixed a Pencil-only regression where object coordinates changed during a drag but the lower canvas was intentionally suppressed before the cropped compositor had taken ownership. The object therefore appeared only at pointerup.
- The top-only selection render guard is now used only for an empty-canvas selection/marquee contact.
- A Pencil contact that can hit the active selection or a selectable nearby object keeps normal Fabric rendering until `before:transform`, then the cropped compositor takes over on large boards.
- Small boards now animate through Fabric normally; large boards continue to animate through the lightweight cropped overlay.
- The custom hand handle follows the same path because an existing ActiveSelection is treated as a possible transform from pointerdown.
- Finger and mouse paths are unchanged.
