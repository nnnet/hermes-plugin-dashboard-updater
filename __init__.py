"""dashboard-updater — мост к sidecar контейнеру через trigger-файлы.

Backend handlers (dashboard/api.py) монтируются upstream'ским scanner'ом на
``/api/plugins/dashboard-updater/``. Frontend overlay (dashboard/dist/index.js)
перехватывает fetch к старым upstream-путям ``/api/gateway/restart``,
``/api/hermes/update`` и ``/api/actions/{name}/status`` и перенаправляет на
наши новые. См. plugin.yaml.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)
logger.info("dashboard-updater: plugin package loaded")
