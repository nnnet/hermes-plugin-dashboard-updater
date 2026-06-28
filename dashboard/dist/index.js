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

  // --- Own "Update Hermes" button (only when upstream hides its own) ---------
  //
  // Upstream renders its Update control unless ``can_update_hermes === false``
  // (it is false inside containers: ``can_update_hermes = not is_container()``).
  // When upstream DOES render it, our fetch overlay above already redirects its
  // action to the sidecar — so we must NOT draw a second button (that would
  // duplicate it in non-container installs). We draw our own ONLY when the
  // upstream render condition is unmet, i.e. there is no native button to
  // intercept. The check is the exact native render condition, not DOM-guessing.
  var BTN_ATTR = "data-dashboard-updater-btn";
  var updating = false;

  // Dashboard 0.17.0 gates every API behind secure login: requests must carry
  // the session token in the X-Hermes-Session-Token header (the SPA reads it
  // from window.__HERMES_SESSION_TOKEN__). Plain fetch without it gets 401 —
  // which is what made the Update button report "failed". Attach it ourselves.
  function authHeaders(extra) {
    var h = extra || {};
    try {
      var t = window.__HERMES_SESSION_TOKEN__;
      if (t) h["X-Hermes-Session-Token"] = t;
    } catch (e) { /* ignore */ }
    return h;
  }

  function findRestartButton() {
    var els = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].getAttribute(BTN_ATTR)) continue;
      var t = (els[i].textContent || "").trim().toLowerCase();
      if (t.indexOf("restart gateway") !== -1) return els[i];
    }
    return null;
  }

  // Live log panel — the sidecar streams build output into the status log; show
  // its tail under the button (this is what the old flow displayed during an
  // update).
  function renderLog(lines) {
    var box = document.getElementById("dashboard-updater-log");
    if (!box) {
      box = document.createElement("pre");
      box.id = "dashboard-updater-log";
      box.style.cssText =
        "max-height:220px;overflow:auto;font-size:11px;line-height:1.35;" +
        "white-space:pre-wrap;word-break:break-word;background:#0a0a0a;" +
        "color:#9fe6c8;padding:8px;margin:6px 0 0;border:1px solid #2a2a2a;" +
        "border-radius:4px;font-family:ui-monospace,Menlo,monospace";
      var btn = document.querySelector("[" + BTN_ATTR + "]");
      if (btn && btn.parentNode) btn.parentNode.insertBefore(box, btn.nextSibling);
    }
    if (lines && lines.length) box.textContent = lines.slice(-50).join("\n");
    box.scrollTop = box.scrollHeight;
  }

  function pollStatus() {
    var btn = document.querySelector("[" + BTN_ATTR + "]");
    origFetch("/api/plugins/dashboard-updater/status/hermes-update", {
      credentials: "same-origin",
      headers: authHeaders(),
    })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && s.lines) renderLog(s.lines);
        if (s && s.running) {
          if (btn) btn.textContent = "Updating…";
          setTimeout(pollStatus, 2000);
        } else {
          var ok = s && s.exit_code === 0;
          if (btn) btn.textContent = ok ? "Updated ✓ — reloading…" : "Update failed";
          updating = false;
          if (ok) setTimeout(function () { location.reload(); }, 4000);
        }
      })
      .catch(function () { setTimeout(pollStatus, 5000); });
  }

  function onUpdateClick() {
    if (updating) return;
    updating = true;
    var btn = document.querySelector("[" + BTN_ATTR + "]");
    if (btn) btn.textContent = "Updating…";
    origFetch("/api/plugins/dashboard-updater/update", {
      method: "POST",
      credentials: "same-origin",
      headers: authHeaders(),
    })
      .then(function (r) { return r.json(); })
      .then(function () { pollStatus(); })
      .catch(function () {
        if (btn) btn.textContent = "Update failed";
        updating = false;
      });
  }

  function tryInsertButton() {
    if (document.querySelector("[" + BTN_ATTR + "]")) return true;
    var restart = findRestartButton();
    if (!restart || !restart.parentNode) return false;
    var btn = document.createElement(restart.tagName);
    btn.className = restart.className; // mimic native styling
    btn.setAttribute(BTN_ATTR, "1");
    btn.setAttribute("type", "button");
    btn.textContent = "Update Hermes";
    btn.addEventListener("click", onUpdateClick);
    restart.parentNode.insertBefore(btn, restart.nextSibling);
    return true;
  }

  function installOwnButton() {
    if (tryInsertButton()) { /* present immediately */ }
    // SPA renders async and re-renders (React may drop our node) — keep it alive.
    try {
      var obs = new MutationObserver(function () { tryInsertButton(); });
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    var tries = 0;
    var iv = setInterval(function () {
      if (++tries > 120) { clearInterval(iv); return; }
      tryInsertButton();
    }, 1000);
  }

  function maybeDrawOwnButton() {
    // Use origFetch so this status probe is never rewritten by our overlay.
    origFetch("/api/status", { credentials: "same-origin", headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        // Only draw ours when upstream will NOT render its own Update control.
        if (s && s.can_update_hermes === false) installOwnButton();
      })
      .catch(function () { /* ignore */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeDrawOwnButton);
  } else {
    maybeDrawOwnButton();
  }

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
