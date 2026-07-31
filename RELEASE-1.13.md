# Alex Board 1.13

Base: 1.12
Date: 2026-07-31

## Navigation

- Fixed the owner-only “Ко мне” command.
- View jumps and view requests can be published during the short presence/fanout startup window.
- Navigation text buttons use the Apple Pencil touch-end command path and suppress the duplicate click.
- Added a student-only “Автопилот” button in the navigation position.
- Autopilot follows the teacher's viewport center and zoom, not the teacher cursor.
- Viewport following uses time-based requestAnimationFrame smoothing and updates its target without restarting the animation.
- The teacher sends viewport changes only while panning/zooming, plus a low-frequency reconnect heartbeat.

## Eyedropper

- Removed the bounding-box target shortcut.
- Lines use a transformed segment-distance hit test with a small tolerance.
- Other objects use Fabric pixel transparency checks only for a bounded set of nearby candidates.
- Images require a visible image pixel; their whole rectangular frame is not treated as a hit.

## Permissions

- “Очистить доску” is no longer rendered for students/edit guests.
- The clear-board handler also enforces owner permission, so hiding the button is not the only protection.

## Compatibility

- Durable board operations and snapshot formats are unchanged.
- Drawing, erasers, selection, Undo/Redo and per-tool styles are unchanged from 1.12.
