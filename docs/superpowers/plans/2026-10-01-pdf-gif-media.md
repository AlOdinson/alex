# PDF and animated GIF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution or superpowers:subagent-driven-development if explicitly selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вставлять PDF с общим перелистыванием и анимированные GIF через Image с сохранением, историей и совместной работой.

**Architecture:** Байты файлов хранятся по SHA-256 отдельно от объектов и истории. Существующий надёжный WebRTC-канал передаёт файлы частями с низким приоритетом; объект хранит ссылку и текущую страницу. Независимый медиарuntime управляет PDF-рендером, GIF-композицией, восстановлением Fabric и освобождением ресурсов.

**Tech Stack:** React 19.2.8, Fabric 7.4.0, Vite 8.1.5, IndexedDB, WebRTC, PDF.js, GIF decoder с поддержкой disposal. Точные версии новых зависимостей фиксируются в lockfile после проверки официальной документации.

**Spec:** docs/superpowers/specs/2026-10-01-pdf-gif-media-design.md — утверждён пользователем 2026-10-01.

## Global Constraints

- PDF — 25 MiB, GIF — 10 MiB; суммарная выделенная память кешей PDF/GIF — 64 MiB на доску.
- Части ограничены существующими 16 384 байтами кадра; короткие операции получают очередь между частями.
- Новые серверы, TURN и live-события через Ably не добавляются.
- Страница PDF общая; права редактирования и существующие блокировки обязательны.
- Смена страницы сохраняет центр, угол и ширину; высота соответствует пропорциям новой страницы.
- Кадры GIF, PDF-render tasks и исходные байты не сериализуются в историю операций.
- RU/EN и текущие форматы изображений сохраняются; PDF worker поставляется сайтом без внешнего CDN.
- Парольные PDF отклоняются; заметки остаются самостоятельными объектами.
- PNG/PDF экспорт и миниатюры статические, показывают текущую страницу/кадр.

## Review Focus

1. Перенос копии PDF между досками: новая комната получает доступ к байтам, прежняя история остаётся работоспособной — Tasks 1, 5.
2. Входящий assetId другой комнаты: запрос отклоняется без передачи файла — Task 2.
3. Переключение страницы и удаление объекта во время рендера: устаревший результат не возвращает удалённый объект — Task 3.
4. GIF с disposal=3 и конечным числом повторов: воспроизводится как исходный файл — Task 4.
5. Превышение квоты IndexedDB: нет ложного сообщения об успешном сохранении — Tasks 1, 5.

## Task 1: Хранилище файлов и бюджет памяти

**Files:** создать src/lib/mediaAssetStore.js, src/lib/mediaMemoryBudget.js, scripts/test-media-asset-store.mjs; изменить src/lib/imageStorage.js только в Task 5.

**Interfaces:**
- createMediaAssetStore({ indexedDB, crypto, onPersistenceError }) -> { importFile(boardId, file), get(boardId, assetId), register(boardId, assetId), dispose() }.
- importFile -> Promise<{ assetId, kind: 'pdf'|'gif', name, mime, size, persisted: boolean }>.
- get -> Promise<{ metadata, blob }|null>; чужая комната получает null.
- createMediaMemoryBudget(limitBytes=64*1024*1024) -> { reserve(key, bytes, release), touch(key), remove(key), dispose(), usedBytes() }; вытеснение вызывает release и не превышает бюджет.

- [ ] Написать тесты: одинаковый файл получает один SHA-256, register разрешает вторую комнату, чужой boardId возвращает null; magic bytes важнее расширения; файл PDF >25 MiB/GIF >10 MiB отклонён; ошибка IndexedDB вызывает onPersistenceError и persisted=false; LRU освобождает ресурс до превышения 64 MiB.
- [ ] Запустить `node --test scripts/test-media-asset-store.mjs`; проверить ожидаемое падение на отсутствующей реализации.
- [ ] Реализовать интерфейсы, отдельную IndexedDB-базу с blobs и room membership; память — резерв. Не вводить автоматическое удаление файлов, которые могут требоваться другой доске/истории.
- [ ] Повторить тест; все сценарии проходят, байты и лимиты проверены.
- [ ] Коммит `feat: add board media asset storage and memory budget`.

## Task 2: Передача файлов через существующий канал

**Files:** создать src/lib/mediaAssetTransfer.js, scripts/test-media-asset-transfer.mjs; изменить src/lib/peerProtocol.js, peerDataChannel.js, teacherPeerHub.js, studentPeerSession.js, teacherBoardRuntime.js, studentBoardRuntime.js, studentPeerNetwork.js, browserBoardSession.js.

**Interfaces:**
- createMediaAssetTransfer({ boardId, store, send, canUpload, onError }) -> { handleMessage(message), ensureRemote(assetId), request(assetId), close() }.
- send(type, payload) -> Promise<void>; для частей использовать низкоприоритетный путь, не одну огромную операцию очереди.
- session.ensureMediaAsset(assetId) -> Promise<void>; student ждёт asset-result авторитетного узла перед upsert; teacher подтверждает локальное наличие.
- session.requestMediaAsset(assetId) -> Promise<{ metadata, blob }>; peerHub маршрутизирует по peerId и комнате.
- capability mediaVersion:1 объявляется в head-request/head; отсутствие поддержки сообщает об обновлении и запрещает отправку несовместимых медиа этому клиенту.

- [ ] Написать тесты fake transport: файл собирается только после полного набора частей и SHA-256; чужая комната и view-only upload отклонены; ack/рисование проходит между частями; закрытие очищает ожидания; повторный файл не передаёт байты; несовместимый клиент получает понятную ошибку.
- [ ] Запустить `node --test scripts/test-media-asset-transfer.mjs`; проверить ожидаемое падение.
- [ ] Добавить asset-request/start/chunk/end/result в протокол. payload частей: boardId, transferId, assetId, index, base64Chunk. Старт содержит проверенные metadata и totalChunks; лимиты/таймеры контролируют сборку; SHA-256 и размер проверяются до store/register.
- [ ] Привязать transfer lifecycle к peer/session, getSnapshot и room membership; новые файлы принимаются только от редактора. asset-request может обслуживать зрителя комнаты. Потери соединения не требуют изменения авторитетной ревизии доски.
- [ ] Проверить `node --test scripts/test-media-asset-transfer.mjs scripts/test-peer-protocol.mjs scripts/test-peer-data-channel.mjs scripts/test-teacher-peer-hub.mjs scripts/test-student-peer-session.mjs`.
- [ ] Коммит `feat: transfer media assets over reliable peer channel`.

## Task 3: PDF renderer и устаревшие задачи

**Files:** создать src/lib/pdfMedia.js, scripts/test-pdf-media.mjs; изменить package.json и package-lock.json.

**Interfaces:**
- createPdfMedia({ blob, budget, onError }) -> Promise<{ pageCount, renderPage(pageNumber, { pixelWidth, signal }), dispose() }>.
- renderPage -> Promise<{ element: HTMLCanvasElement, width, height }>; pageNumber начинается с 1.
- Новые задачи получают собственный canvas; кеш ограничен бюджетом Task 1 и тремя страницами на документ.

- [ ] Написать тесты с подменяемым PDF backend: страницы разных пропорций; границы; устаревший рендер отменён; dispose освобождает worker/document и кеш; парольный PDF даёт понятную ошибку; budget не превышен.
- [ ] Запустить `node --test scripts/test-pdf-media.mjs`; проверить ожидаемое падение.
- [ ] Проверить официальную документацию PDF.js, установить и зафиксировать поддерживаемую версию pdfjs-dist. Worker и модуль загружаются лениво из Vite-сборки. Рендер ограничен 4 млн пикселей на страницу; кеш и активный canvas учитываются в общем бюджете. Повышение качества при зуме запускается после завершения жеста.
- [ ] Повторить тесты и проверить реальный многостраничный PDF в браузерном fixture, включая быстрые переключения и очистку после удаления.
- [ ] Коммит `feat: render PDF pages with bounded cancellable cache`.

## Task 4: GIF playback без полноразмерного массива кадров

**Files:** создать src/lib/gifMedia.js, src/lib/boardMediaRuntime.js, scripts/test-gif-media.mjs; изменить package.json и package-lock.json.

**Interfaces:**
- createGifMedia({ blob, budget }) -> Promise<{ element, width, height, advance(now), restart(), dispose() }>.
- advance(now) -> { changed: boolean, nextDelayMs: number|null }; конечные повторы завершаются, исходные задержки сохраняются.
- createBoardMediaRuntime({ canvas, store, requestAsset, budget, onError }) -> { hydrate(object), update(object), remove(object), suspend(hidden), dispose() }.
- hydrate/update используют mediaKind/mediaAssetId/pageNumber, сохраняют сериализуемые параметры и заменяют только элемент/локальное состояние. Runtime не посылает операции доски.

- [ ] Написать тесты: прозрачные частичные кадры, disposal 2/3, конечные повторы, разные задержки; один планировщик для нескольких объектов; невидимый объект/скрытая вкладка не рисуют; повторная hydrate не создаёт второй player; remove/dispose отменяет таймеры и освобождает память.
- [ ] Запустить `node --test scripts/test-gif-media.mjs`; проверить ожидаемое падение.
- [ ] Выбрать decoder по официальному исходнику/документации; проверить доступ к отдельным compressed frames, расширению loop и disposal. Фиксировать зависимость. Декодировать кадры по мере воспроизведения, использовать один composition canvas и резервную область для disposal=3, учитывать память в Task 1; не декодировать все RGBA-кадры заранее.
- [ ] Реализовать общий scheduler по задержкам и canvas visibility, без React-state на кадр. Отделить runtime map от данных объекта и предоставлять текущий canvas для экспорта.
- [ ] Повторить unit tests и браузерный fixture с прозрачной GIF; проверить изменение пикселей, конечное завершение и остановку после удаления.
- [ ] Коммит `feat: play animated GIF media with bounded lifecycle`.

## Task 5: Вставка, UI, история, восстановление и выпуск

**Files:** изменить src/components/Board.jsx, Toolbar.jsx, src/lib/imageStorage.js, exportBoard.js, boardThumbnail.js, src/i18n.js, src/styles.css, package.json; создать src/components/PdfPageControls.jsx, scripts/test-board-media.mjs, scripts/test-board-media-browser.mjs и браузерные fixtures.

**Interfaces:**
- PdfPageControls({ pageNumber, pageCount, canEdit, busy, position, onPageChange }) не пропускает pointer events в canvas.
- Board serializes mediaKind, mediaAssetId, mediaName, pageNumber, pageCount и логические размеры; src содержит только небольшую статическую заглушку, не оригинальные байты/кадры.
- Объект остаётся FabricImage с отдельными media metadata; runtime запускается через canvas object:added/object:removed и на изменение media fields, охватывая все enliven/loadFromJSON пути.
- Смена страницы использует существующий lock и patch action/history, вызывает runtime.update после принятия; width/center/angle сохраняются. Уже подтверждённая pageNumber сохраняется при локальной ошибке отображения и может повторно загружаться.

- [ ] Написать интеграционные тесты: input/drop/paste принимают PDF/GIF; GIF не попадает в JPEG-компрессию; stale render после delete не оживляет объект; copy/Undo/Redo/reload восстанавливает файл и страницу; ошибки IndexedDB не дают ложного успешного сохранения; две вкладки видят одну страницу; read-only не перелистывает; экспорт/белые миниатюры содержат текущую страницу/кадр; старые PNG/JPEG работают.
- [ ] Запустить `node --test scripts/test-board-media.mjs`; проверить ожидаемое падение.
- [ ] Встроить Task 1–4 в вставку и все пути восстановления. Копирование между досками регистрирует существующие файлы в новой комнате; Home копирования и thumbnail path проверяются отдельно. В i18n добавить RU/EN загрузку, страницу, формат, пароль, размер и persistence errors.
- [ ] Добавить профильный npm script test:media и browser fixture. Зафиксировать версии всех новых зависимостей в lockfile; версия релиза выбирается после сравнения свежего main.
- [ ] Выполнить `npm run test:media`, `npm run test:menu`, `npm run test:connections`, `npm run test:browser-authority`, `npm run build`; выполнить browser fixture для двух участников, крупных PDF и нескольких GIF, включая перерисовку заполненной доски. Сообщить точные ограничения проверки реального iPad.
- [ ] Самостоятельно проверить весь diff относительно spec и Review Focus. Любая правка после проверок повторяет затронутый профиль. Коммит `feat: insert shared PDFs and animated GIFs on board`.
- [ ] После согласования способа выполнения и разрешения GitHub upload отправить feature branch; проверить CI. Перед main перепроверить head, избежать перезаписи чужих изменений. Публиковать только проверенную реализацию; подтверждение live результата отдельно от успешной сборки.

## Self-review

Дизайн покрыт Tasks 1–5; лимиты, общий номер страницы, отдельные байты, низкий
приоритет, lifecycle и ошибки включены в тесты. Названия интерфейсов согласованы.
Review Focus привязан к владельцам изменений. Публичных API/Supabase изменений
не требуется. Изменение зависимостей и код продукта ждут обязательного просмотра
этого плана и выбора native/subagent-driven execution.
