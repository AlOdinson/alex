# Alex Board 1.32.1 — Apple Pencil transform responsiveness

## Перенос объектов на iPad

- Apple Pencil теперь использует тот же стабильный путь Fabric-отрисовки, что и палец.
- Удалён временный трёхслойный raster-композитор, выделявший новые retina-canvas при каждом переносе.
- Код больше не заменяет `requestRenderAll`, `renderAll` и `renderTop`, поэтому отрисовка не может остаться заблокированной до бездействия.
- Движения Pencil ограничиваются по времени до 120 Гц без зависимости от `requestAnimationFrame`.
- `pointerup`, `pointercancel` и `lostpointercapture` завершают сессию ввода синхронно.

## Группы и инструменты

- Перемещение большой группы не запускает дорогую попиксельную отрисовку всей `ActiveSelection` при повторном касании.
- Лёгкая transform-операция группы ставится в очередь сразу, без ожидания следующего кадра.
- Команды панели и зум после отпускания Pencil выполняются сразу.

## Синхронизация

- Authoritative operation log v8, координаты, ревизии, live-preview и точечная страховочная синхронизация не изменялись.
- Новая SQL-миграция не требуется: используется установленная `supabase/authoritative_log_v8.sql`.

## Проверка

- Production-сборка Vite.
- Sync convergence fence.
- Authoritative v8 multi-client convergence.
- Регрессионные инварианты для 30 последовательных Pencil-сессий, группового commit и аварийного освобождения pointer capture.
