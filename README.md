# Alex Board 0.6.0 — Ably 20 Hz

Совместная онлайн-доска для занятий с GitHub Pages, Supabase и Ably.

## Что изменено

- мгновенные действия переведены на Ably Pub/Sub;
- курсор, рисование и перемещение объектов отправляются не чаще 20 раз в секунду (каждые 50 мс);
- готовые изменения по-прежнему сохраняются в Supabase;
- Ably получает только временный токен через Supabase Edge Function;
- полный `ABLY_API_KEY` не попадает в GitHub и браузер;
- если Ably временно недоступен, доска автоматически возвращается к Supabase Realtime;
- без настроенного Supabase сохраняется локальный режим между вкладками браузера.

## Перед загрузкой кода в GitHub

Сначала обновите код Edge Function `ably-token` в Supabase кодом из:

```text
supabase/functions/ably-token/index.ts
```

Подробные шаги находятся в файле `ABLY_20HZ_SETUP_RU.txt`.

## GitHub Pages

Проект настроен для адреса:

```text
https://alodinson.github.io/alex/
```

После загрузки файлов в ветку `main` GitHub Actions автоматически соберёт и опубликует новую версию.
