export const CONNECTION_PROGRESS_EVENT = 'alex-board-connection-progress';

export function reportConnectionProgress(callback, step, detail, extra = {}) {
  try { callback?.({ step, detail, ...extra }); } catch { /* UI must never interrupt connection */ }
}

export const CONNECTION_STEPS = [
  'Подключаемся к комнате', 'Ожидаем готовности учителя',
  'Устанавливаем соединение с учителем', 'Открываем канал передачи доски',
  'Синхронизируем содержимое доски', 'Отображаем доску',
];
const DETAILS = {
  room: 'Устанавливаем служебную связь',
  'room-error': 'Не удалось подключиться к служебной комнате — повторяем',
  'teacher-pending': 'Учитель в комнате, его доска ещё запускается',
  'teacher-offline': 'Учитель пока не подключён к комнате',
  candidate: 'Проверяем доступные сетевые адреса',
  recovering: 'Восстанавливаем сетевой маршрут',
  'live-repair': 'Восстанавливаем живое рисование',
  teacher: 'Ищем учителя и ждём готовности его доски',
  negotiating: 'Обмениваемся параметрами подключения',
  offer: 'Предложение отправлено — ожидаем ответ учителя',
  answer: 'Ответ отправлен — ищем сетевой маршрут',
  route: 'Ищем рабочий сетевой маршрут',
  channel: 'Соединение установлено — ожидаем канал данных',
  handshake: 'Канал открыт — ожидаем ответ приложения учителя',
  'snapshot-wait': 'Запрос отправлен — ожидаем содержимое доски',
  receiving: 'Получаем сообщения от учителя',
  sync: 'Получаем недостающие изменения',
  painting: 'Применяем полученные данные',
};

export function updateConnectionProgress(previous, event = {}, now = Date.now()) {
  const current = previous ?? { step: 1, detail: 'room', since: now, startedAt: now, attempt: 0 };
  const changed = event.restart === true || event.newAttempt === true || (event.step != null
    && (event.step !== current.step || event.detail !== current.detail || (event.path != null && event.path !== current.path)));
  return { ...current, ...event, step: event.step ?? current.step, detail: event.detail ?? current.detail,
    path: event.path ?? (event.newAttempt ? '' : current.path),
    startedAt: current.startedAt ?? current.since ?? now,
    since: changed ? now : current.since,
    attempt: (current.attempt ?? 0) + (event.newAttempt === true ? 1 : 0),
    retrying: event.retrying ?? (changed ? false : current.retrying) };
}

export function connectionProgressText(progress, now = Date.now()) {
  const step = Math.max(1, Math.min(6, Number(progress?.step) || 1));
  const elapsed = Math.max(0, Math.floor((now - (progress?.since ?? now)) / 1000));
  const path = progress?.path === 'student-initiated' ? 'Инициатор: ученик'
    : progress?.path === 'owner-initiated' ? 'Инициатор: учитель' : '';
  const total = Math.max(0, Math.floor((now - (progress?.startedAt ?? progress?.since ?? now)) / 1000));
  const counter = progress?.startedAt != null ? `Всего ${total} с · Попытка ${Math.max(1, progress.attempt ?? 1)} · Этап ` : '';
  return `Шаг ${step} из 6 · ${CONNECTION_STEPS[step - 1]}\n${DETAILS[progress?.detail] ?? DETAILS.room}${path ? ` · ${path}` : ''}\n${progress?.retrying ? 'Попытка не завершилась — повторяем подключение · ' : ''}${counter}${elapsed} с`;
}
