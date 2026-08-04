# Alex Board 1.24

## Changes

- Opening a previously created board from its student/share link in the same browser now automatically uses the locally remembered owner key and opens the teacher panel.
- A stale remembered owner key falls back safely to the key contained in the opened URL.
- Image drag-and-drop no longer relies on iterable `DataTransferItemList`, improving Safari and older-browser compatibility.
- Finder/Desktop image drops are read from both `dataTransfer.files` and `DataTransferItem.getAsFile()` and de-duplicated.
- Drag enter/over is accepted in Safari even when file types are hidden until drop.
- Unsupported file drops are blocked from navigating away from the board and show a clear format message.
- Invalid Safari drop coordinates fall back to the current viewport centre instead of placing the image off-screen.
