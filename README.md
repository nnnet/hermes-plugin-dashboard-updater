# hermes-plugin-dashboard-updater

Перенаправляет кнопки Dashboard `Restart` / `Update` на sidecar
`hermes-updater`.

## Зачем

Upstream-эндпоинты `POST /api/gateway/restart` и `POST /api/hermes/update`
запускают `subprocess.Popen([sys.executable, "-m", "hermes_cli.main", ...])`
ВНУТРИ контейнера. Для Docker-сборки это бесполезно:

- subprocess не пересоздаёт сам контейнер
- subprocess не делает `git pull` на хосте
- subprocess не пересобирает image

Upstream `GET /api/actions/{name}/status` тоже не подходит: он опрашивает
`proc.poll()`, а в sidecar-режиме `_ACTION_PROCS[name]` всегда `None` →
возвращает `running=False` сразу же.

## Решение

```
Dashboard кнопка ─fetch overlay─▶ POST /api/plugins/dashboard-updater/restart
                                         │
                                         ▼
                              api.py: touch HERMES_HOME/triggers/restart
                                         │
                                         ▼
                              sidecar контейнер hermes-updater (docker.sock):
                              видит trigger-файл, делает реальный
                              ``docker compose restart`` / ``git pull`` +
                              rebuild + recreate
                                         │
                                         ▼
                              пишет [DONE] / [FAIL] в HERMES_HOME/logs/*.log
                                         │
                                         ▼
Dashboard poll ──fetch overlay──▶ GET /api/plugins/dashboard-updater/status/<name>
                                         │
                                         ▼
                              api.py: tail log, парсит [DONE]/[FAIL] маркеры
```

## Wire-up

Подключён upstream'ским dashboard plugin scanner'ом
(`hermes_cli/web_server.py:_discover_dashboard_plugins`). Backend routes
монтируются на префикс `/api/plugins/dashboard-updater/` через
`app.include_router` (см. `_mount_plugin_api_routes`). Frontend bundle
грузится через `<script src=".../dashboard-plugins/dashboard-updater/dist/index.js">`.

Манифест `dashboard/manifest.json` помечен `tab.hidden=true` —
плагин не добавляет вкладку в Dashboard, только инжектит fetch overlay.

## Зависимости

В compose должен крутиться sidecar `hermes-updater` с:
- бинд-маунт `/var/run/docker.sock`
- бинд-маунт `${REPO_ROOT}` (для git pull + docker build)
- бинд-маунт `HERMES_HOME/triggers/` (read-only watch)
- бинд-маунт `HERMES_HOME/logs/` (write-append)

Запуск: `hermes up hermes-updater` (см. `docker-compose.hermes-core.yml`).

## Конфиг

```yaml
plugins:
  enabled:
    - dashboard-updater
```

При загрузке плагин залогирует:

```
INFO dashboard-updater: plugin package loaded
```

И при первом нажатии Restart/Update в Dashboard:

```
INFO dashboard-updater: restart trigger touched (HERMES_HOME/triggers/restart)
```
