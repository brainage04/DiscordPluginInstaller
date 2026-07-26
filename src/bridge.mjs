import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const BRIDGE_NAME = "DiscordPluginManagerBridge";
export const BRIDGE_VERSION = 4;
export const BRIDGE_TOKEN = "61dff13bd429adc9abbd0649e6fe6c911c5d6534986c477c7c14e98073ef15a0";
export const BRIDGE_SCHEME = "discord-plugin-installer:";
export const BRIDGE_HOST = "manage";

const BRIDGE_SOURCE = `(() => {
  const TOKEN = ${JSON.stringify("61dff13bd429adc9abbd0649e6fe6c911c5d6534986c477c7c14e98073ef15a0")};
  const HOST = ${JSON.stringify("manage")};
  const VERSION = ${JSON.stringify(BRIDGE_VERSION)};
  const STATE_KEY = "__discordPluginManagerBridgeState";
  const state = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = {
    handled: Object.create(null),
    subscription: undefined
  });
  let subscription;

  function notify(message) {
    vendetta.ui.toasts.showToast(message);
  }

  function report(callback, payload) {
    if (!callback) return Promise.resolve();
    let parsed;
    try {
      parsed = new URL(callback);
    } catch {
      return Promise.resolve();
    }
    if (parsed.protocol !== "https:") return Promise.resolve();
    return fetch(parsed.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => undefined);
  }

  function canonicalizeSource(source) {
    let parsed;
    try {
      parsed = new URL(source);
    } catch {
      throw new Error("Invalid plugin source URL");
    }
    if (parsed.protocol !== "https:") throw new Error("Plugin source must use HTTPS");
    if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    return parsed.toString();
  }

  function matchingIds(name, source) {
    return Object.keys(vendetta.plugins.plugins).filter(id => {
      const plugin = vendetta.plugins.plugins[id];
      return id === source || Boolean(name && plugin?.manifest?.name === name);
    });
  }

  function sequence(items, operation) {
    return items.reduce(
      (promise, item) => promise.then(() => operation(item)),
      Promise.resolve()
    );
  }

  function removeById(id) {
    if (id === vendetta.plugin?.id) {
      return Promise.reject(new Error("The manager bridge cannot remove itself"));
    }
    return Promise.resolve(vendetta.plugins.removePlugin(id));
  }

  function install(name, source) {
    const duplicates = matchingIds(name, source).filter(id => id !== source);
    return sequence(duplicates, removeById).then(() => {
      if (vendetta.plugins.plugins[source]) {
        return { source, removed: duplicates, installed: false };
      }
      return Promise.resolve(vendetta.plugins.installPlugin(source, true))
        .then(() => ({ source, removed: duplicates, installed: true }));
    });
  }

  function reinstall(name, source) {
    const duplicates = matchingIds(name, source).filter(id => id !== source);
    return sequence(duplicates, removeById).then(() => {
      const existing = vendetta.plugins.plugins[source];
      if (!existing) {
        return Promise.resolve(vendetta.plugins.installPlugin(source, true))
          .then(() => ({ source, removed: duplicates, installed: true }));
      }
      if (source === vendetta.plugin?.id) {
        return Promise.resolve(vendetta.plugins.fetchPlugin(source))
          .then(() => ({ source, removed: duplicates, installed: false, restartRequired: true }));
      }
      if (existing.enabled === true) vendetta.plugins.stopPlugin(source, false);
      return Promise.resolve(vendetta.plugins.fetchPlugin(source))
        .then(() => vendetta.plugins.startPlugin(source))
        .then(() => ({ source, removed: duplicates, installed: false }));
    });
  }

  function uninstall(name, source) {
    const ids = matchingIds(name, source);
    return sequence(ids, removeById).then(() => ({ uninstalled: ids }));
  }

  function setEnabled(name, source, enabled) {
    const ids = matchingIds(name, source);
    if (ids.length === 0) throw new Error("Plugin is not installed");
    return sequence(ids, id => {
      const plugin = vendetta.plugins.plugins[id];
      if (enabled && plugin?.enabled !== true) {
        return Promise.resolve(vendetta.plugins.startPlugin(id));
      }
      if (!enabled && plugin?.enabled === true) {
        return Promise.resolve(vendetta.plugins.stopPlugin(id));
      }
      return Promise.resolve();
    }).then(() => ({ ids, enabled }));
  }

  function remember(requestId) {
    if (state.handled[requestId]) return false;
    state.handled[requestId] = true;
    const requestIds = Object.keys(state.handled);
    if (requestIds.length > 256) {
      requestIds.slice(0, 128).forEach(id => delete state.handled[id]);
    }
    return true;
  }

  function handleUrl(input) {
    let link;
    try {
      link = new URL(input);
    } catch {
      return;
    }
    if (link.protocol !== "discord-plugin-installer:" || link.hostname !== HOST) return;
    if (link.searchParams.get("token") !== TOKEN) return;

    const requestId = link.searchParams.get("request") || "";
    if (!requestId || !remember(requestId)) return;

    const callback = link.searchParams.get("callback") || "";
    const action = link.searchParams.get("action") || "";
    const name = link.searchParams.get("name") || "";
    let source = link.searchParams.get("source") || "";

    if (action === "status") {
      const plugins = Object.keys(vendetta.plugins.plugins).map(id => {
        const plugin = vendetta.plugins.plugins[id];
        return {
          id,
          name: plugin?.manifest?.name || id,
          enabled: plugin?.enabled === true
        };
      });
      void report(callback, { requestId, ok: true, action, bridgeVersion: VERSION, plugins });
      return;
    }

    try {
      if (source) source = canonicalizeSource(source);
      if ((action === "install" || action === "reinstall") && !source) {
        throw new Error("Plugin source is required");
      }
      if ((action === "uninstall" || action === "set-enabled") && !source && !name) {
        throw new Error("Plugin name or source is required");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void report(callback, { requestId, ok: false, action, error: reason });
      return;
    }

    let operation;
    try {
      if (action === "install") operation = install(name, source);
      else if (action === "reinstall") operation = reinstall(name, source);
      else if (action === "uninstall") operation = uninstall(name, source);
      else if (action === "set-enabled") {
        operation = setEnabled(name, source, link.searchParams.get("enabled") === "true");
      } else {
        throw new Error("Unsupported action: " + action);
      }
    } catch (error) {
      operation = Promise.reject(error);
    }

    Promise.resolve(operation)
      .then(result => report(callback, { requestId, ok: true, action, ...result }))
      .catch(error => {
        const reason = error instanceof Error ? error.message : String(error);
        notify("Plugin " + action + " failed: " + reason);
        return report(callback, { requestId, ok: false, action, error: reason });
      });
  }

  return {
    onLoad() {
      const Linking = vendetta.metro.common.ReactNative.Linking;
      state.subscription?.remove?.();
      subscription = Linking.addEventListener("url", event => handleUrl(event.url));
      state.subscription = subscription;
      Linking.getInitialURL().then(url => url && handleUrl(url));
    },
    onUnload() {
      subscription?.remove?.();
      if (state.subscription === subscription) state.subscription = undefined;
      subscription = undefined;
    }
  };
})()`;

export async function prepareBridgeRepository(directory) {
  const repository = resolve(directory);
  const dist = resolve(repository, "dist");
  await mkdir(dist, { recursive: true });
  const hash = createHash("sha256").update(BRIDGE_SOURCE).digest("hex");
  const manifest = {
    name: BRIDGE_NAME,
    description: "Programmatically installs, reinstalls, and uninstalls Revenge plugins.",
    authors: [{ name: "brainage04", id: "0" }],
    main: "index.js",
    vendetta: { icon: "WrenchIcon" },
    hash
  };
  await Promise.all([
    writeFile(resolve(dist, "index.js"), BRIDGE_SOURCE),
    writeFile(resolve(dist, "manifest.json"), JSON.stringify(manifest))
  ]);
  return repository;
}
