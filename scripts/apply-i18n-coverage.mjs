import fs from 'node:fs';

function patchFile(path, from, to) {
  const source = fs.readFileSync(path, 'utf8');
  if (source.includes(to)) return false;
  if (!source.includes(from)) throw new Error(`Missing localization coverage anchor in ${path}: ${from.slice(0, 90)}`);
  fs.writeFileSync(path, source.replace(from, to));
  return true;
}

const i18nPath = 'src/i18n.js';
let i18n = fs.readFileSync(i18nPath, 'utf8');
if (!i18n.includes('/* Extended UI coverage */')) {
  const marker = '\nconst RAW_EN_PATTERNS = [';
  if (!i18n.includes(marker)) throw new Error('RAW_EN_PATTERNS anchor not found');
  const extra = `

/* Extended UI coverage */
const EXTRA_RAW_EN = {
  'Редактирует': 'Editing:',
  'Загрузка изображения…': 'Loading image…',
  'Изображение догружается…': 'Image is still loading…',
  'Открываю игротеку для участников…': 'Opening games for participants…',
  'Скрываю игротеку…': 'Hiding games…',
  'Игротека открыта для всех': 'Games are open to everyone',
  'Игротека скрыта, игры закрыты': 'Games hidden; active games closed',
  'Не удалось изменить видимость игротеки': 'Could not change game-library visibility',
  'Открываю игротеку…': 'Opening games…',
  'Не удалось создать временную группу': 'Could not create a temporary group',
  'Временная группа повреждена': 'Temporary group is corrupted',
  'Не удалось завершить групповое выделение': 'Could not finish group selection',
  'Сервер не вернул снимок для сжатия': 'The server did not return a snapshot for compaction',
  'Сервер сохранил снимок более старой ревизии': 'The server saved a snapshot from an older revision',
  'Слишком много страниц журнала синхронизации': 'Too many synchronization log pages',
  'Не удалось восстановить локальный объект': 'Could not restore a local object',
  'Серверная ревизия недоступна': 'Server revision is unavailable',
  'Слишком много страниц журнала конфликта': 'Too many conflict log pages',
  'Журнал операций недоступен или содержит разрыв': 'The operation log is unavailable or has a gap',
  'Обработчик адресной синхронизации не готов': 'Targeted synchronization handler is not ready',
  'Нет адресной серверной версии конфликтующего объекта': 'No targeted server version exists for the conflicting object',
  'Конфликтующие объекты ещё используются локально': 'Conflicting objects are still in use locally',
  'Серверный снимок недоступен': 'Server snapshot is unavailable',
  'Сервер не подтвердил безопасную отмену': 'The server did not confirm safe undo',
  'Один из объектов сейчас редактирует другой участник': 'Another participant is currently editing one of these objects',
  'Составная замена больше не поддерживается историей': 'Compound replacement is no longer supported by history',
  'Локальная адресная проверка подтверждённого действия не пройдена': 'Local targeted verification of the confirmed action failed',
  'Сохраняю…': 'Saving…',
  'Не удалось проверить аккаунт': 'Could not verify the account',
  'Сервер не вернул токен Ably': 'The server did not return an Ably token',
  'Ably не подключился': 'Ably did not connect',
  'Supabase Realtime не подключился': 'Supabase Realtime did not connect',
  'Канал аккаунта не подключился': 'Account channel did not connect',
  'Канал демонстрации не подключился': 'Screen-share channel did not connect',
  'экономный режим': 'data saver',
  'текст и указатель': 'text and pointer',
  'прокрутка и движение': 'scrolling and movement',
  'iPhone и iPad не разрешают веб-странице захватывать другую вкладку. Для показа сайтов запустите Alex Browser Server на Mac.': 'iPhone and iPad do not allow a web page to capture another tab. To share websites, start Alex Browser Server on a Mac.',
  'Этот браузер или устройство не поддерживает передачу экрана через веб-страницу.': 'This browser or device does not support screen sharing from a web page.',
  'Сервер отклонил часть большой операции': 'The server rejected part of a large operation',
  'Сервер отклонил изменение доски': 'The server rejected the board change',
  'Supabase v8 не вернул точный набор применённых операций': 'Supabase v8 did not return the exact set of applied operations',
  'Сначала запустите supabase/game_library_visibility_upgrade_0.8.1.sql': 'Run supabase/game_library_visibility_upgrade_0.8.1.sql first',
  'Одно из ожидающих действий конфликтует с сервером. Откройте доску и дождитесь восстановления.': 'One pending action conflicts with the server. Open the board and wait for recovery.',
  'Не удалось получить актуальный урок для копирования': 'Could not get the current lesson for copying',
  'Не удалось открыть созданную копию': 'Could not open the created copy',
  'В Supabase не создано хранилище board-assets. Запусти SQL обновления 0.3.7.': 'The board-assets storage bucket is missing in Supabase. Run the 0.3.7 SQL update.',
  'Сервер слишком долго подтверждает очередь изменений': 'The server is taking too long to confirm the change queue',
  'Сервер не подтвердил ни одного действия пакета': 'The server did not confirm any action in the batch',
  'Сервер вернул неполное подтверждение пакета': 'The server returned an incomplete batch confirmation',
  'Не удалось подключиться к игровому Ably': 'Could not connect to game Ably',
  'Не удалось подключиться к игровой комнате': 'Could not connect to the game room',
  'Не удалось подключиться к управляющему каналу игротеки': 'Could not connect to the game-library control channel',
  'Игровой Ably недоступен, игра продолжит работу в одиночном режиме': 'Game Ably is unavailable; the game will continue in solo mode',
  ' — копия': ' — copy',
  'До ': 'Up to ',
  ' досок на этом устройстве. При создании новой удаляется самая старая.': ' boards on this device. Creating a new one removes the oldest.',
  'Убираю старые доски сверх лимита 50: ': 'Removing old boards over the 50-board limit: ',
  ' из ': ' of ',
  'Последний урок: ': 'Last lesson: ',
  'Выбрано: ': 'Selected: ',
  'Зрителей: ': 'Viewers: ',
  ' кадр/с': ' fps',
  'Выполнен вход: ': 'Signed in: ',
  'Сейчас играет: ': 'Playing now: ',
  'Управляет: ': 'Controlled by: ',
  'Экран: ': 'Screen: ',
};
for (const [source, translated] of Object.entries(EXTRA_RAW_EN)) RAW_EN.set(source, translated);
`;
  i18n = i18n.replace(marker, `${extra}${marker}`);
  fs.writeFileSync(i18nPath, i18n);
}

// Protect user-created values from the DOM localization bridge.
patchFile(
  'src/components/GameLibrary.jsx',
  '<span>{participantName} · {boardTitle}</span>',
  '<span><span data-i18n-skip>{participantName}</span> · <span data-i18n-skip>{boardTitle}</span></span>',
);
patchFile(
  'src/components/GameLibrary.jsx',
  '<p>{participantName} · {boardTitle}</p>',
  '<p><span data-i18n-skip>{participantName}</span> · <span data-i18n-skip>{boardTitle}</span></p>',
);
patchFile(
  'src/components/Home.jsx',
  'const { language, t, formatDate } = useLanguage();',
  'const { language, t, ui, formatDate } = useLanguage();',
);
patchFile(
  'src/components/Home.jsx',
  "const nextTitle = window.prompt('Название копии', `${board.title ?? 'Доска'} — копия`);",
  "const nextTitle = window.prompt('Название копии', `${board.title ?? t('home.newBoard')}${ui(' — копия')}`);",
);

console.log('Extended i18n coverage applied.');
