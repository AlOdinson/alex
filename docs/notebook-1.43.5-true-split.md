# Alex Board 1.43.5 — true notebook fragments

## User-facing contract

Partial capture produces physically separate contents, rather than two complete copies with inverse clipping masks. The outside object really has the captured region removed; the page owns only the intersection. Disjoint remnants remain one logical object. A central hole can retain a large bounding rectangle, but its removed pixels/geometry are absent.

Ordinary solid-colour paths and supported shapes remain vector outlines, including fill/stroke order, caps, joins, dashes, transforms, opacity, groups and holes. Curves are flattened once during cutting with a target tolerance of 0.01 board units; rendering and zooming do not repeat the split. This is a geometry representation change, not a claim that every resulting path has fewer vertices than its source.

Images are rendered into bounded new pixel surfaces and trimmed. Derived fragments do not retain the old storagePath/media asset or full original image. Partial text uses option A: independently cropped static images; text that is entirely transferred without losing actual paint remains editable. Text is normally rendered at 2x its local size. Shadows and non-solid paint effects use a raster rendering path to retain appearance rather than unsupported vector colour reconstruction.

A false-positive bounding-box intersection creates no notebook fragment and, for a single new source, requests no notebook lease/controller. Old nested clipping masks are materialized during a new cut; this release does not destructively migrate saved lessons. Pure preparation preserves the source; asynchronous single-source preparation checks for a newer gesture before consuming it.

## Integration boundaries

Existing atomic operations/history/outbox are retained. Undo restores the original published source (including editable text); redo restores the real fragments. Original source data in history is necessary for reversibility and is not embedded in the derived objects. First image upload/paste remains independent and is captured only after a later intentional drop. Read-only student viewing, transport, screen-share settings and notebook navigation are unchanged.

This change is not a complete fix for all previously reported disappearing-stroke or zoom-cache issues. Resource checks reject pathological coordinates, excessive curve subdivision and raster surfaces over 16,777,216 pixels / 16,384 pixels per side before replacing the input. An existing application-level failed-new-stroke persistence problem remains outside this release; rejection is not a successful save.

## Verification

New Node/Fabric tests assert real empty regions with no masks, bounded image pixels, no old source asset references, source immutability, curves/joins/dashes/dots, transparent gaps, compound holes, legacy nested masks, group opacity, and shadow rendering. Two-participant authority tests verify vector and image remnants plus undo/redo. Browser gates cover native pencil strokes, first image insertion, later native drop, option-A text, original restoration and persisted reload. Browser results are recorded per engine; physical iPad/iPhone/Apple Pencil are not claimed to have been tested.

Pinned dependency: clipper-lib 6.4.2, Boost Software License 1.0. No network or database schema dependency added.
