# PDF and GIF media — 1.40.0

Image accepts PDF, GIF and existing image formats through the picker, file drop and clipboard files. PDF pages share one object ID and one page number. The selected PDF has previous/next controls; page changes use existing edit permissions, selection locks, patches and Undo/Redo. PDF width, center and angle are preserved; height follows the page aspect ratio. GIF decoding runs in a worker and compositing preserves transparency, disposal and loop counts.

Original bytes live in the device's separate IndexedDB media store, referenced by SHA-256. They are requested/uploaded over the existing peer data channel. Ably remains signaling only. A new device needs a connected participant with the original file. Browser storage deletion removes its local originals. Clients without the media capability must update before new media can be inserted in their session.

Limits: PDF 25 MiB; GIF 10 MiB; PDF raster 4 million pixels; shared raster budget 64 MiB. Password protected PDFs are rejected. Quota failures prevent insertion or transfer confirmation instead of reporting a successful durable save.

## Verification

- `npm run test:media`: 56 tests passed, including identity, room scoping, limits, corrupt transfers, receiver quota failure, disposal, cancellation, grouped media, late hydration, GIF transparency/finite loops and copying references. Integration regressions cover verification handshakes, authority-before-paste, legacy update notices/journal gating, teacher publication checks, durable room registration and parallel PDF renders.
- `npm run test:menu`, `npm run test:connections`, `npm run test:browser-authority`: passed.
- `npm run build`: passed. Existing bundle-size advisory remains.
- `MEDIA_SKIP_WEBRTC=1 CHROMIUM_EXECUTABLE=/tmp/chromium npm run test:media:browser`: passed in headless Chromium. Actual PDF.js and GIF workers, a 60-page PDF, multiple GIFs, reference serialization/revival, current-page export with white background, file transfer protocol with separate IndexedDB stores, 1,000 other objects, full Board picker/drop/paste, PDF page controls/reload, GIF Undo/Redo, Home duplication, storage quota errors and read-only controls were exercised.

The explicit skip flag only changes the test fixture. Production still uses the existing WebRTC channel. A real RTC pair was attempted with no ICE servers and with loopback enabled: both peers remained `new` and produced zero ICE candidates in this execution sandbox. Real network/device verification is therefore outstanding; it is not reported as passing. No real iPad or Safari test was available. The software-rendered headless load fixture is a correctness check, not evidence of interactive iPad performance.

Changes have not been published to main or the live board.

The final review found five important integration issues. Each was reproduced by a failing behavioral regression and fixed. Legacy peers receive a normal read-only Textbox update notice through the existing snapshot/control protocol; compatible media clients receive a fresh snapshot on their first handshake so an earlier notice cannot survive an update. Concurrent PDF jobs own distinct budget reservations and cache trimming preserves displayed pinned pages.
