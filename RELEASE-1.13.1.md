# Alex Board 1.13.1

Hotfix for the blank Board screen introduced in 1.13.

- Replaces an undefined `clientId` reference in the owner viewport heartbeat effect with `clientIdRef.current`.
- Removes the invalid hook dependency on `clientId`.
- No drawing, selection, eraser, history, storage, or realtime message formats were changed.
