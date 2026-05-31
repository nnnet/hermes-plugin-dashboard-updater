"""Backend routes для dashboard-updater плагина.

Монтируются upstream'ским scanner'ом на префикс ``/api/plugins/dashboard-updater/``.
Frontend overlay (dashboard/dist/index.js) перенаправляет fetch с upstream-путей
``/api/gateway/restart``, ``/api/hermes/update``, ``/api/actions/{name}/status``
на наши.

restart/update handler пишет файл-сигнал в ``HERMES_HOME/triggers/``; sidecar
``hermes-updater`` (docker.sock) видит его и делает реальную работу
(git pull + docker compose build + recreate).

status handler читает ``HERMES_HOME/logs/{gateway-restart,hermes-update}.log``
и распознаёт ``[DONE]`` / ``[FAIL]`` маркеры, которые sidecar пишет в конце
каждой операции. Upstream ``/api/actions/{name}/status`` этой логики НЕ знает —
он только опрашивает ``proc.poll()``, а в sidecar-режиме process'a нет, поэтому
upstream вернул бы ``running=False`` сразу же.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException

router = APIRouter()
_log = logging.getLogger(__name__)

_ACTION_LOG_FILES = {
    "restart": "gateway-restart.log",
    "update": "hermes-update.log",
}
_ACTION_LABELS = {
    "restart": "gateway-restart",
    "update": "hermes-update",
}
_STATUS_NAME_TO_KEY = {
    "gateway-restart": "restart",
    "hermes-update": "update",
}


def _hermes_home() -> Path:
    """Same fallback chain как upstream ``hermes_cli.config.get_hermes_home``."""
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    return Path.home() / ".hermes"


def _tail_lines(path: Path, n: int) -> List[str]:
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    lines = text.splitlines()
    return lines[-n:] if n > 0 else lines


def _touch_trigger(action: str) -> Path:
    home = _hermes_home()
    triggers_dir = home / "triggers"
    triggers_dir.mkdir(parents=True, exist_ok=True)
    trigger_path = triggers_dir / action
    trigger_path.touch()

    log_dir = home / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / _ACTION_LOG_FILES[action]
    label = _ACTION_LABELS[action]
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(
            f"\n=== {label} triggered at "
            f"{time.strftime('%Y-%m-%d %H:%M:%S')} ===\n"
        )
        f.write(f"Trigger file: {trigger_path}\n")
        f.write("Waiting for hermes-updater sidecar...\n\n")

    _log.info(
        "dashboard-updater: %s trigger touched (%s)", action, trigger_path
    )
    return trigger_path


@router.post("/restart")
async def restart_gateway():
    try:
        path = _touch_trigger("restart")
    except Exception as exc:
        _log.exception("Failed to touch restart trigger")
        raise HTTPException(status_code=500, detail=f"Trigger failed: {exc}")
    return {
        "ok": True,
        "via": "hermes-updater",
        "name": "gateway-restart",
        "trigger": str(path),
    }


@router.post("/update")
async def update_hermes():
    try:
        path = _touch_trigger("update")
    except Exception as exc:
        _log.exception("Failed to touch update trigger")
        raise HTTPException(status_code=500, detail=f"Trigger failed: {exc}")
    return {
        "ok": True,
        "via": "hermes-updater",
        "name": "hermes-update",
        "trigger": str(path),
    }


@router.get("/status/{name}")
async def get_action_status(name: str, lines: int = 200):
    """Sidecar-aware status. Reads HERMES_HOME/logs/<name>.log и распознаёт
    маркеры ``[DONE]`` / ``[FAIL]``. Без маркера — считаем что header без
    закрытия = sidecar ещё работает."""
    key = _STATUS_NAME_TO_KEY.get(name)
    if key is None:
        raise HTTPException(status_code=404, detail=f"Unknown action: {name}")

    home = _hermes_home()
    log_path = home / "logs" / _ACTION_LOG_FILES[key]
    tail = _tail_lines(log_path, min(max(lines, 1), 2000))

    last_lines = "\n".join(tail[-30:]) if tail else ""
    running: bool
    exit_code: Optional[int]
    if "[DONE]" in last_lines:
        running = False
        exit_code = 0
    elif "[FAIL]" in last_lines:
        running = False
        exit_code = 1
    else:
        header_count = sum(
            1 for line in tail
            if "=== " in line and (" triggered" in line or " started" in line)
        )
        done_count = sum(
            1 for line in tail
            if "[DONE]" in line or "[FAIL]" in line
        )
        running = header_count > done_count
        exit_code = None if running else 0

    return {
        "name": name,
        "running": running,
        "exit_code": exit_code,
        "pid": None,
        "lines": tail,
        "via": "hermes-updater",
    }


@router.get("/health")
async def health():
    home = _hermes_home()
    return {
        "ok": True,
        "hermes_home": str(home),
        "triggers_dir": str(home / "triggers"),
        "logs_dir": str(home / "logs"),
    }
