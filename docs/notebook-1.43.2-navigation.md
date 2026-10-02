# Notebook 1.43.2: persistent protected navigation

The notebook's previous/next arrows and current page number are always visible,
inside its bottom-left corner, bottom-right corner, and bottom centre. The old
selection-only floating panel is removed. Selection still supplies the native
frame resize handles. Double-clicking page text still opens the existing editor.

Each notebook has three opaque DOM islands, with small clean padding. They sit
above both canvas surfaces and above ordinary board content; the rest of the
page and footer remain usable. This is view-only chrome: it does not erase or
clip underlying stored objects, create history entries, or alter PNG/PDF content.
Existing capture, clipping, insertion, drag-to-notebook, history, and transport
semantics are unchanged.

Navigation addresses an explicit notebook ID instead of the active selection.
Relative taps are processed in the existing notebook mutation queue. Editing
permissions and leases are retained. A live text draft is finalized by the
existing text exit/capture handler before the turn, on its original page; this
specific exit preserves the chosen tool.

A down/up on an arrow performs one turn. Crossing, ending a stroke on an arrow,
a cancelled contact, or a drag away from the button does not. While an outside
gesture is active, all three islands still paint but do not participate in hit
testing, leaving the existing canvas input pipeline in charge. This lasts
through the native release task and compatibility click. Pointer and TouchEvent
ownership, cancellation, blur/pagehide and cleanup are covered independently.

The frame tracker indexes notebook objects on add/remove. Render/video ticks
read only frame geometry and page numbers, never child records, hidden pages,
or a fresh scan of all scene objects. CSS matrices follow the same full object,
group and viewport transforms as Fabric, without changing notebook geometry.

## Verification entry points

- `npm run test:notebook` includes navigation model, real React/DOM, input gating,
  draft preservation and no-scene-scan tests alongside existing notebook tests.
- `npm run test:notebook:browser` retains existing notebook and deliberate-drop
  regressions and adds native mouse/touch navigation with all tools, keyboard,
  screenshot pixel masks, crossing strokes, frame movement, resize and zoom.
- Existing notebook performance and received-video scenarios remain release gates.

Scripted touch and pen event tests are not physical Apple Pencil/iPad testing.
