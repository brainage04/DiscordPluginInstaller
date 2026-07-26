import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  BRIDGE_HOST,
  BRIDGE_NAME,
  BRIDGE_VERSION,
  BRIDGE_TOKEN,
  prepareBridgeRepository
} from "../src/bridge.mjs";

test("manager bridge installs, reinstalls, configures, and uninstalls by manifest name", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "discord-plugin-manager-bridge-test-"));
  const originalFetch = globalThis.fetch;
  try {
    await prepareBridgeRepository(root);
    const source = await readFile(resolve(root, "dist", "index.js"), "utf8");
    const manifest = JSON.parse(await readFile(resolve(root, "dist", "manifest.json"), "utf8"));
    assert.equal(manifest.name, BRIDGE_NAME);
    assert.doesNotMatch(source, /\basync\b/);

    const managerSource = "https://plugins.example/Manager/";
    const oldSource = "https://plugins.example/Example-v1/";
    const currentSource = "https://plugins.example/Example/";
    const manifests = {
      [managerSource]: { name: BRIDGE_NAME },
      [currentSource]: { name: "Example" }
    };
    const installed = {
      [managerSource]: { enabled: true, manifest: manifests[managerSource] },
      [oldSource]: { enabled: true, manifest: { name: "Example" } }
    };
    const operations = [];
    const reports = new Map();
    let urlListener;

    globalThis.fetch = async (_url, options) => {
      const report = JSON.parse(options.body);
      reports.set(report.requestId, report);
      return {};
    };
    const vendetta = {
      metro: {
        common: {
          ReactNative: {
            Linking: {
              addEventListener(_event, listener) {
                urlListener = listener;
                return { remove() {} };
              },
              getInitialURL() {
                return Promise.resolve(null);
              }
            }
          }
        }
      },
      plugin: { id: managerSource },
      plugins: {
        plugins: installed,
        installPlugin(id, enabled) {
          operations.push(["install", id, enabled]);
          installed[id] = { enabled, manifest: manifests[id] };
          return Promise.resolve();
        },
        fetchPlugin(id) {
          operations.push(["fetch", id]);
          return Promise.resolve();
        },
        startPlugin(id) {
          operations.push(["start", id]);
          installed[id].enabled = true;
          return Promise.resolve();
        },
        stopPlugin(id, persist = true) {
          operations.push(["stop", id, persist]);
          if (persist) installed[id].enabled = false;
        },
        removePlugin(id) {
          operations.push(["remove", id]);
          delete installed[id];
          return Promise.resolve();
        }
      },
      ui: { toasts: { showToast() {} } }
    };
    const plugin = Function("vendetta", `return ${source}`)(vendetta);
    plugin.onLoad();

    let sequence = 0;
    async function request(action, options = {}) {
      const requestId = `request-${sequence += 1}`;
      const link = new URL(`discord-plugin-installer://${BRIDGE_HOST}`);
      link.searchParams.set("token", BRIDGE_TOKEN);
      link.searchParams.set("request", requestId);
      link.searchParams.set("action", action);
      link.searchParams.set("callback", "https://callback.example/result");
      for (const [key, value] of Object.entries(options)) {
        link.searchParams.set(key, String(value));
      }
      urlListener({ url: link.toString() });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
      return reports.get(requestId);
    }

    const first = await request("install", { name: "Example", source: currentSource });
    assert.equal(first.ok, true);
    assert.equal(first.installed, true);
    assert.deepEqual(first.removed, [oldSource]);
    assert.equal(installed[oldSource], undefined);
    assert.equal(installed[currentSource].enabled, true);

    operations.length = 0;
    const alreadyInstalled = await request("install", { name: "Example", source: currentSource });
    assert.equal(alreadyInstalled.ok, true);
    assert.equal(alreadyInstalled.installed, false);
    assert.deepEqual(operations, []);

    const second = await request("reinstall", { name: "Example", source: currentSource });
    assert.equal(second.ok, true);
    assert.equal(second.installed, false);
    assert.deepEqual(operations, [
      ["stop", currentSource, false],
      ["fetch", currentSource],
      ["start", currentSource]
    ]);

    assert.equal((await request("set-enabled", {
      name: "Example",
      enabled: false
    })).ok, true);
    assert.equal(installed[currentSource].enabled, false);
    assert.equal((await request("set-enabled", {
      name: "Example",
      enabled: true
    })).ok, true);
    assert.equal(installed[currentSource].enabled, true);

    const status = await request("status");
    assert.equal(status.ok, true);
    assert.equal(status.bridgeVersion, BRIDGE_VERSION);
    assert.deepEqual(
      status.plugins.map(entry => [entry.name, entry.enabled]).sort(),
      [["Example", true], [BRIDGE_NAME, true]].sort()
    );

    const uninstalled = await request("uninstall", { name: "Example" });
    assert.equal(uninstalled.ok, true);
    assert.deepEqual(uninstalled.uninstalled, [currentSource]);
    assert.equal(installed[currentSource], undefined);

    const selfRemoval = await request("uninstall", { name: BRIDGE_NAME });
    assert.equal(selfRemoval.ok, false);
    assert.match(selfRemoval.error, /cannot remove itself/i);
    assert.ok(installed[managerSource]);
    plugin.onUnload();
  } finally {
    delete globalThis.__discordPluginManagerBridgeState;
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
