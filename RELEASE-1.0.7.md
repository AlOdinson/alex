# Alex Board 1.0.7 — exclusive Apple Pencil input ownership

## Исправлено

- Fabric переведён на `enablePointerEvents: true`, чтобы он не создавал отдельный `touchstart/mousedown`-цикл Apple Pencil.
- CreationInputController перенесён на capture-фазу родительского `.canvas-host`, поэтому он выполняется раньше внутренних обработчиков Fabric.
- Fabric больше не получает параллельный TouchEvent/compatibility-mouse цикл Apple Pencil при выбранном карандаше, линии или фигуре.
- Добавлено восстановление начала сессии по первому контактному `pointermove`, если Safari задержал или пропустил `pointerdown` после нажатия кнопки инструмента Pencil.
- Palm rejection, двухпальцевый zoom, объектный/частичный ластик, выделение и трансформации остаются на прежних путях.
- Supabase, Ably, RPC, Undo/Redo и форматы данных не изменены.
