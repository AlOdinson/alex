# Alex Board 1.29.1

Hotfix for Apple Pencil selection getting stuck after moving an object or group.

- Fixed a null z-index map crash in the new 1.29 lightweight transform pipeline.
- Transform cleanup now runs even if building the persistence patch fails.
- Tool switching forcibly clears stale Pencil selection capture, marquee state, live transform state and collaboration locks.
- Existing lightweight transform operations and 1.29 storage compatibility are preserved.
