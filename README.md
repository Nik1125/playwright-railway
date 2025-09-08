
# Playwright Persist API (Railway)

Лёгкий API-сервис на **Playwright** с **persistent-профилем** (куки хранятся на диске). Подходит, чтобы логиниться один раз и потом автоматизировать Instagram без передачи `sessionid` в пайплайне.

## Быстрый старт на Railway

1. Сделай репозиторий из этого проекта (или импортируй ZIP).
2. На [Railway](https://railway.app):
   - **New Project → Deploy from GitHub** → выбери этот репозиторий.
   - **Add Volume** → Mount path: `/data` (обязательно).
   - **Variables**:
     - `AUTH_TOKEN=<любой_секрет>` (требуется для запросов)
     - `DEFAULT_UA=<твоя UA-строка>` (опционально)
     - `USER_DATA_DIR=/data/ig-profile` (опционально)
3. После деплоя открой **Networking** и создай публичный домен.

### Проверки
```bash
# здоровье
curl "https://<your>.up.railway.app/health" \
  -H "Authorization: Bearer <AUTH_TOKEN>"

# проверка логина (вернёт isLoggedIn и apiStatus)
curl -X POST "https://<your>.up.railway.app/run" \
  -H "Authorization: Bearer <AUTH_TOKEN>" -H "Content-Type: application/json" \
  -d '{"action":"loginCheck"}'
```

## Роуты

### `GET /health`
Проверка, что контекст поднят.

### `POST /seed-cookies`
Однократно «посеять» куки из твоего браузера (если не хочешь логиниться скриптом).
Body:
```json
{ "cookies": [{ "name": "sessionid", "value": "..." }, ...] }
```

### `POST /run`
Общий экшн с телом:
```json
{ "action": "<loginCheck|openSettings|followersLinks>", "username": "miki", "targetUser": "nik_112524", "needScreenshot": false }
```

- **`loginCheck`** – открывает главную и дергает закрытый API `/api/v1/accounts/edit/web_form_data/`. `apiStatus: 200` ⇒ вы залогинены.
- **`openSettings`** – открывает `/accounts/edit/`.
- **`followersLinks`** – открывает профиль, кликает `Followers` (или переходит напрямую), ждёт модалку и собирает ссылки профилей `{href,text}`. Если передан `targetUser`, вернёт `foundTarget: true`, если такой ник найден.

## Вызов из n8n

**HTTP Request (POST)** → `https://<your>.up.railway.app/run`  
Headers:
```
Authorization: Bearer <AUTH_TOKEN>
Content-Type: application/json
```
Пример тела:
```json
{ "action": "loginCheck" }
```

## Заметки
- Профиль сохраняется в volume `/data/ig-profile`. Это переживает перезапуск контейнера.
- Не запускайте много параллельных запросов: в коде есть очередь; при необходимости масштабируйте сервис.
- Для IG не используем `networkidle`, чтобы избежать подвисаний; используем `domcontentloaded` и гонки.

MIT License.
