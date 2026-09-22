# pure-luna-admin-api

Минимальный Cloudflare Worker: отдаёт JSON-контент из Google Sheets для сборки статических лэндингов на Cloudflare Pages.

## Как это работает

1. Контент хранится в Google Таблице (ячейка `export_json_bundle!A2:A2`).
2. При сборке Pages вызывает `GET /api/v1/content-bundle` с Bearer-токеном.
3. Worker читает таблицу, проверяет структуру бандла и возвращает JSON.

## Быстрый старт (локально)

```bash
npm install
copy .dev.vars.example .dev.vars   # Windows
# заполните .dev.vars реальными значениями
npm run dev
```

Проверка:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8787/api/v1/content-bundle
```

## Настройка Google Sheets

1. Создайте Service Account в Google Cloud (роль не нужна, достаточно доступа к таблице).
2. Скачайте JSON-ключ — **не коммитьте его в git**.
3. Откройте Google Таблицу → «Поделиться» → добавьте email service account с правом **Читатель**.
4. В `.dev.vars` укажите:
   - `GOOGLE_SHEETS_ID` — ID из URL таблицы
   - `GOOGLE_CLIENT_EMAIL` — email service account
   - `GOOGLE_PRIVATE_KEY` — приватный ключ (с `\n` вместо переносов строк)

## Деплой в Cloudflare

```bash
npx wrangler login
npm run secrets:put    # загрузит секреты из .dev.vars в Worker
npm run deploy
```

После деплоя URL Worker будет вида:

```
https://pure-luna-admin-api-mvp-v1.<your-subdomain>.workers.dev/api/v1/content-bundle
```

Этот URL используйте в Cloudflare Pages как `CONTENT_API_URL` при сборке.

## Секреты Worker

| Переменная | Где хранить |
|---|---|
| `PURE_LUNA_BUILD_TOKEN` | secret |
| `GOOGLE_SHEETS_ID` | secret |
| `GOOGLE_CLIENT_EMAIL` | secret |
| `GOOGLE_PRIVATE_KEY` | secret |
| `GOOGLE_SHEET_RANGE` | wrangler.toml [vars] |
| `EXPECTED_*` | wrangler.toml [vars] |

## GitLab CI

В GitLab → Settings → CI/CD → Variables добавьте:

- `CLOUDFLARE_API_TOKEN` — токен с правом Workers Scripts: Edit
- `CLOUDFLARE_ACCOUNT_ID` — ID аккаунта Cloudflare

При push в `main` пайплайн автоматически задеплоит Worker.

## Структура проекта

```
src/index.ts      — Worker (единственный endpoint)
wrangler.toml     — конфиг Cloudflare
.dev.vars         — локальные секреты (не в git)
.dev.vars.example — шаблон секретов
```

## Безопасность

- **Никогда** не коммитьте `.dev.vars`, JSON-ключи Google и `pureluna*.txt`.
- Если секреты попали в git — перевыпустите ключ service account и смените `PURE_LUNA_BUILD_TOKEN`.
