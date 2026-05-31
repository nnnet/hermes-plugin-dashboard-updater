/*
 * dashboard-updater — fetch overlay for Dashboard Restart/Update buttons.
 *
 * Upstream Dashboard fires:
 *   POST /api/gateway/restart
 *   POST /api/hermes/update
 *   GET  /api/actions/<name>/status
 * which inside Docker hit the upstream subprocess handler (useless — subprocess
 * can't restart its own container, can't run git pull, can't rebuild) and the
 * upstream status handler (which only knows proc.poll() — in sidecar mode the
 * process is None so it returns running=False immediately).
 *
 * This overlay intercepts window.fetch and redirects these three paths to
 *   POST /api/plugins/dashboard-updater/restart
 *   POST /api/plugins/dashboard-updater/update
 *   GET  /api/plugins/dashboard-updater/status/<name>
 * where our backend writes a trigger file consumed by the hermes-updater
 * sidecar (docker.sock + ${REPO_ROOT} mount) and reads sidecar [DONE]/[FAIL]
 * markers from the same log file.
 */
(function () {
  if (window.__dashboardUpdaterOverlayInstalled) return;
  window.__dashboardUpdaterOverlayInstalled = true;

  var STATIC_REDIRECTS = {
    "/api/gateway/restart": "/api/plugins/dashboard-updater/restart",
    "/api/hermes/update": "/api/plugins/dashboard-updater/update",
  };
  // Pattern: /api/actions/<name>/status (any name, optional ?lines=...)
  var STATUS_RX = /(^|\/)\/?api\/actions\/([^\/]+)\/status(\?.*)?$/;

  function rewrite(url) {
    // Exact-prefix static redirects.
    for (var from in STATIC_REDIRECTS) {
      if (!Object.prototype.hasOwnProperty.call(STATIC_REDIRECTS, from)) continue;
      if (url === from || url.indexOf(from + "?") === 0) {
        return url.replace(from, STATIC_REDIRECTS[from]);
      }
      // Same path but with a leading origin/base prefix.
      var idx = url.indexOf(from);
      if (idx > 0 && (idx + from.length === url.length || url.charAt(idx + from.length) === "?")) {
        return url.substring(0, idx) + STATIC_REDIRECTS[from] + url.substring(idx + from.length);
      }
    }
    // /api/actions/<name>/status → /api/plugins/dashboard-updater/status/<name>
    var m = url.match(STATUS_RX);
    if (m) {
      var name = m[2];
      var query = m[3] || "";
      var statusFrom = "/api/actions/" + name + "/status";
      var statusTo = "/api/plugins/dashboard-updater/status/" + name;
      return url.replace(statusFrom, statusTo);
    }
    return url;
  }

  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var rewritten = rewrite(url);
      if (rewritten !== url) {
        return origFetch(rewritten, init);
      }
    } catch (e) {
      // fall through to original on any introspection error
    }
    return origFetch(input, init);
  };

  // Register a no-op component so the plugin loader doesn't mark this plugin
  // as NO_REGISTER (cosmetic — manifest has tab.hidden=true so the component
  // is never rendered).
  try {
    var sdk = window.__HERMES_PLUGIN_SDK__;
    var React = sdk && sdk.React;
    var registry = window.__HERMES_PLUGINS__;
    if (registry && typeof registry.register === "function" && React) {
      registry.register(
        "dashboard-updater",
        function () { return React.createElement("span", { "data-plugin": "dashboard-updater" }); }
      );
    }
  } catch (e) {
    /* ignore */
  }

  // eslint-disable-next-line no-console
  console.log("[dashboard-updater] fetch overlay installed");
})();
