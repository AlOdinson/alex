# Addressed deletion state and recoverable local-storage migration

Continuation of the approved no-video notebook plan after indexed-pipeline commit
`8ef82c062995dc2463fb8c84864c2bfe1b5bf210`. This is candidate code, not a deployed release.

## Scope

The session, canonical preflight and browser authority use a persistent AVL deletion
index. One top-level deletion changes a logarithmic tree path; conditional restore
still checks the original deleting client and mutation. Snapshot/handoff exports
return independent plain records, never an object containing index methods.

IndexedDB schema 4 adds `boardTombstones`, `boardTombstoneMigrations`, and
`boardTombstoneBackups`. New boards store deletion entries separately from hot board
metadata. A normal confirmed action changes only its addressed deletion rows, child
rows, journal entry, revision and fixed metadata in one transaction. An action that
does not change deletion state does not rewrite it. The immutable lesson baseline is
not read/written per action. Wire operations, including retirement of temporary
source strokes, are unchanged.

## Legacy data

Schema upgrade creates stores without moving a full existing deletion table inside
the version-change transaction. A legacy board is copied on demand before its first
new confirmed write. Read-only loading continues to use the original table until
migration completes. Writes to that board await migration; no accepted outbox entry
is discarded. Batches use 128 entries by default. Cursor and row copies commit
atomically, so a quota error or interruption resumes from durable progress.

Before copying, a separate immutable backup preserves the original deletion table
and source revision. This is a deletion-table recovery copy, NOT a complete external
backup of all site data. Existing snapshot, journal, child tombstones, media and
outbox are left intact. The final transaction validates source identity/revision,
progress and copied-row count, then switches the metadata marker and removes only
the legacy inline field. The backup remains until explicit board deletion. Unknown
future formats are rejected rather than downgraded. Old schema-3 writers cannot
open the schema-4 database; the existing blocked-tab message says not to clear data.

Two migration callers share durable progress. Deleting the board also deletes all
migration rows and backup so a paused caller cannot resurrect it. No arbitrary
expiry, full snapshot compaction, periodic full sync or new server is introduced.

## Recovery build

The compatible recovery source is the previous drawing implementation `52a65f38`
plus this exact `browserAuthorityStore.js` and `boardTombstoneIndex.js`. It reads the
CURRENT row-based deletion table and latest journal, not the stale migration backup.
Plainly reverting to old schema-3 storage code after migration is not safe.

Local recovery-source verification includes the previous 254 notebook tests,
authority suite, migration/storage fault tests and storage-deadline tests with only
the schema/import fixtures updated. CI also tests real v3->v4 interrupted migration,
page reload, parallel callers, conditional restoration and undo on the recovery
source. This does not replace independent release review or a user's external
backup before deploying a data-format change.

## Evidence and remaining work

New tests verify 10,000 existing deletions without full-table enumeration or copying
in a local notebook capture and serial authority, one-row IndexedDB writes, quota
failures during copying/final switch/commit/import, retained outbox and media,
abort/retry/concurrent callers, old-tab conflicts, future formats and corrupted
migration metadata. Browser verification results must be read for the exact commit
before calling it verified. Unit or structural counts are not physical pen latency.

The earlier 8ef82 indexed block passed native Chromium and macOS WebKit run
37308905733, including three alternating baseline/candidate rounds. Against52,
5000-neighbor pooled release-to-after:render medians were27.6->21.6ms in Chromium
and45.5->36.5ms in WebKit (48 strokes, 3 rounds each). Other cases remained mixed;
6-page WebKit p95 worsened49->86ms. This is not proof that all freezes are removed.

Those reports measured final after:render correctly, but their optional controller
CPU counter retained a replaced controller in most scenarios. The next fixture
observes the live React controller ref and requires recorded enqueue samples.
There is no production tracing hook or test-only bypass in the model/store.

Still outstanding: full page-child addressing, general damaged-region rendering,
eraser/undo/zoom optimization, split worker, bounded preparation scheduler, startup
work, deeper memory/latency attribution and physical iPad/Pencil acceptance. All
screen-sharing product files and behavior remain excluded.
