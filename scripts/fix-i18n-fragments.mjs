import fs from 'node:fs';

const path = 'src/i18n.js';
let source = fs.readFileSync(path, 'utf8');
const replacements = [
  ["  ' — копия': ' — copy',", "  '— копия': '— copy',"],
  ["  'До ': 'Up to ',", "  'До': 'Up to',"],
  ["  ' досок на этом устройстве. При создании новой удаляется самая старая.': ' boards on this device. Creating a new one removes the oldest.',", "  'досок на этом устройстве. При создании новой удаляется самая старая.': 'boards on this device. Creating a new one removes the oldest.',"],
  ["  'Убираю старые доски сверх лимита 50: ': 'Removing old boards over the 50-board limit: ',", "  'Убираю старые доски сверх лимита 50:': 'Removing old boards over the 50-board limit:',"],
  ["  ' из ': ' of ',", "  'из': 'of',"],
  ["  'Последний урок: ': 'Last lesson: ',", "  'Последний урок:': 'Last lesson:',"],
  ["  'Выбрано: ': 'Selected: ',", "  'Выбрано:': 'Selected:',"],
  ["  'Зрителей: ': 'Viewers: ',", "  'Зрителей:': 'Viewers:',"],
  ["  ' кадр/с': ' fps',", "  'кадр/с': 'fps',"],
  ["  'Выполнен вход: ': 'Signed in: ',", "  'Выполнен вход:': 'Signed in:',"],
  ["  'Сейчас играет: ': 'Playing now: ',", "  'Сейчас играет:': 'Playing now:',"],
  ["  'Управляет: ': 'Controlled by: ',", "  'Управляет:': 'Controlled by:',"],
  ["  'Экран: ': 'Screen: ',", "  'Экран:': 'Screen:',"],
];
for (const [from, to] of replacements) {
  if (source.includes(to)) continue;
  if (!source.includes(from)) throw new Error(`Missing fragment anchor: ${from}`);
  source = source.replace(from, to);
}
fs.writeFileSync(path, source);
console.log('Dynamic JSX translation fragments normalized.');
