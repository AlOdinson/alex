# Notebook performance design

Status: proposed implementation plan; no runtime changes authorized by this document.
Baseline: Alex Board 1.42.0, commit 1cb55c5852de77a439916d80036ca23bedbcbe95.

## Goal

Сделать стоимость нового штриха почти независимой от количества старых страниц. Сохранить отзывчивость письма при получении демонстрации экрана, качество изображения, редактируемость целого текста и точную совместную историю.

## Evidence

Chromium synthetic fixture: 100 strokes per page, 40 points per stroke; one additional stroke on the active page. Preparation includes notebook before/after serialization and forward/inverse patch generation, not transport or persistence.

| Pages | Preparation | Forward JSON | Local inverse JSON |
|---|---:|---:|---:|
| 1 | 18 ms | 344 KiB | 344 KiB |
| 6 | 108 ms | 2016 KiB | 2016 KiB |
| 12 | 209 ms | 4022 KiB | 4022 KiB |

Current page hydration serializes 5,050 / 45,150 / 180,300 child records for 100 / 300 / 600 strokes. A compositor test requests full scene rendering on every simulated video frame while any object is selected, or an active-page child uses destination-out. This establishes the rendering fallback, not real video FPS or codec load.

## Preserved behavior

- Unlimited user-created pages; only the visible page has live Fabric objects.
- Shared current page; page navigation creates no editing-history entry.
- Pencil, lines, shapes, text and static images. PDF/GIF stay outside notebooks.
- Exact boundary clipping; crossing text becomes a noneditable image, undo restores editable text.
- Corner-only proportional notebook resize, existing movement/copy/delete/export.
- One split and its outside fragment form an all-or-nothing history action.
- Existing file deduplication and final-reference cleanup across boards/devices.
- Existing connection architecture; no new servers, TURN, periodic full-board scans or scheduled snapshot compaction.
- Preserve current screen-share quality settings; no automatic FPS/resolution reduction as the main fix.

## Proposed architecture

Keep the notebook as one top-level board object and lock target. Preserve the readable legacy notebookPages representation for full checkpoints/export, but never build a full notebook record for an ordinary stroke. Introduce versioned notebook child operations applied to the authority model, journal, replicas and live page incrementally. IDs belong to individual children; page numbers are stable addresses because page insertion/reordering is not part of this feature.

Operation shape: {type:'notebook', version:1, id, pageNumber, changes, atomicGroup?}. A change is insert {object,zIndex,ifAbsent:true}, patch {id,patch,unset?,ifFields?,ifAbsent?}, or delete {id,ifObjectVersion}. Inserts/restores use child tombstones and mutation identity equivalent to the existing board-object history guards. Whole compound groups preflight against a common revision, with sequential simulation inside the group so dependent changes are evaluated consistently. operationObjectIds returns the parent notebook ID for authorization, leases and delivery.

Record only changed child data and inverse operations in editing history. Persist/replay those same operations. Full notebook snapshots are reserved for existing load/export/recovery boundaries. Local drawing publishes an immediate preview and immutable ordered operation; acknowledgement is asynchronous. Local pending state is derived from confirmed state plus the ordered pending operations, so rejection cannot erase later accepted work.

Separate content dirtiness from placement/selection. Cache the current page's completed scene and keep the active stroke/selection controls in the existing transient overlay. Video frames reuse scene caches when selected static geometry is unchanged. Destination-out contained in an isolated notebook cache must be distinguished from board-wide compositing.

## Acceptance targets, not measured promises

- No hidden-page child serialization, revival or image decoding on an ordinary stroke.
- At most 2N child serialization visits during hydration of N children; no 1+2+...+N growth.
- The 40-point-stroke forward operation AND inverse each fit within 16 KiB, excluding a new image asset transfer.
- For the same active-page content, operation payload growth from 1 to 20 pages is <= 5%; measured median preparation growth <= 25% on the same device after warmup.
- Target p95 notebook-specific main-thread preparation <= 16 ms on the fixed desktop fixture; no individual notebook task over 50 ms. Report actual iPad measurements separately.
- The selected, stationary notebook causes zero additional full-scene geometry renders during 60 video-only presentations after cache warmup. Check pixel equivalence and controls, not only counters.
- At most two current-page raster cache surfaces per visible notebook, aggregate budget 32 MiB per notebook and 64 MiB for notebook caches per board. Evict least recently used caches; hidden pages do not accumulate canvases. Existing screen-share cache budget is reported separately.
- 20 pages x 300 strokes, 300 rapid input strokes, 1080p/60 and 720p/60 receive scenarios: no lost/duplicated strokes, bounded cache memory, identical teacher/student state after acknowledgement/reconnect.

## Release boundaries

A: rendering/hydration/cache improvements under the existing format.
B: negotiated notebook child operations, incremental history/storage/live application and asynchronous local editing, enabled together after all consumers support them.
C: optimize image encoding and validate sustained screen-share sessions; enabled only after lifecycle and visual gates pass.

Old clients must never silently receive operations they cannot apply. On boards using the new notebook protocol, unsupported editing is explicitly blocked with a reload requirement; offer a correct flattened read-only representation if that compatibility path is implemented and tested. Preserve the prior saved board and validate conversion before switching the stored format. No automatic downgrade of a migrated board to an older writer.
