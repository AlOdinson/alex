# Alex Board 1.13.2

Text creation and first-edit behavior fix.

- New text objects are created with the placeholder `text` instead of `Текст`.
- The placeholder is marked explicitly with `textPlaceholder` and is serialized with the object.
- On the first entry into text editing, the placeholder is removed automatically and the caret is placed at position 0.
- Existing user-authored text equal to `text` is not cleared unless it was created as the placeholder.
- No drawing, selection, eraser, history, storage, or realtime message formats were changed.
