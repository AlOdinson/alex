# Alex Board 1.24.1

## Hotfix

- Fixed the completely blank board screen introduced in 1.23 and inherited by 1.24.
- `selectInsertedObjects` was referenced in a React hook dependency array before the callback was initialized, causing an immediate JavaScript `ReferenceError` when `BoardWorkspace` rendered.
- Removed the invalid dependency; the callback was not used by that hook.
- All 1.23 and 1.24 functionality remains included.
