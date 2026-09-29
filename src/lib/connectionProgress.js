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

export function connectionProgressText(progress, now = Date.now()) {
  const step = Math.max(1, Math.min(6, Number(progress?.step) || 1));
  const elapsed = Math.max(0, Math.floor((now - (progress?.since ?? now)) / 1000));
  const path = progress?.path === 'student-initiated' ? 'Инициатор: ученик'
    : progress?.path === 'owner-initiated' ? 'Инициатор: учитель' : '';
  return `Шаг ${step} из 6 · ${CONNECTION_STEPS[step - 1]}\n${DETAILS[progress?.detail] ?? DETAILS.room}${path ? ` · ${path}` : ''}\n${progress?.retrying ? 'Попытка не завершилась — повторяем подключение · ' : ''}${elapsed} с`;
}
