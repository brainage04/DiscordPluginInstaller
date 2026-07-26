import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  BRIDGE_HOST,
  BRIDGE_NAME,
  BRIDGE_SCHEME,
  BRIDGE_TOKEN,
  BRIDGE_VERSION,
  prepareBridgeRepository
} from "./bridge.mjs";
import { AndroidController } from "./android.mjs";
import { run } from "./process.mjs";

const CONTENT_TYPES = {
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function createPluginServer(plugins, repositories, options = {}) {
  const routes = new Map();
  const bridgeWaiters = new Map();
  for (const plugin of plugins) {
    const dist = resolve(repositories.get(plugin.name), "dist");
    for (const filename of ["manifest.json", "index.js"]) {
      const file = resolve(dist, filename);
      if (!await exists(file)) throw new Error(`Missing Revenge build output: ${file}`);
      routes.set(`/${encodeURIComponent(plugin.name)}/${filename}`, file);
    }
  }


  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const resultMatch = pathname.match(/^\/__discord-plugin-installer\/([0-9a-f-]+)$/i);
    if (request.method === "POST" && resultMatch) {
      const chunks = [];
      let size = 0;
      request.on("data", chunk => {
        size += chunk.length;
        if (size <= 65_536) chunks.push(chunk);
      });
      request.on("end", () => {
        if (size > 65_536) {
          response.writeHead(413).end("Result too large");
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          bridgeWaiters.get(resultMatch[1])?.resolve(result);
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end("Invalid result");
        }
      });
      return;
    }

    const file = routes.get(pathname);
    if (!file) {
      response.writeHead(404).end("Not found");
      return;
    }
    const extension = file.endsWith(".json") ? ".json" : ".js";
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": CONTENT_TYPES[extension]
    });
    createReadStream(file).pipe(response);
  });

  const requestedPort = Number(options.port ?? 8765);
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, options.bind || "0.0.0.0", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" ? address.port : requestedPort;
  const publicBaseUrl = options.publicUrl
    ? options.publicUrl.replace(/\/+$/, "")
    : `http://127.0.0.1:${port}`;

  return {
    server,
    urls: new Map(plugins.map(plugin => [
      plugin.name,
      `${publicBaseUrl}/${encodeURIComponent(plugin.name)}/`
    ])),
    callbackUrl(requestId) {
      return `${publicBaseUrl}/__discord-plugin-installer/${requestId}`;
    },
    waitForBridgeResult(requestId, timeout = 10_000) {
      return new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => {
          bridgeWaiters.delete(requestId);
          reject(new Error("Revenge installer bridge did not respond"));
        }, timeout);
        bridgeWaiters.set(requestId, {
          resolve(result) {
            clearTimeout(timer);
            bridgeWaiters.delete(requestId);
            resolveResult(result);
          }
        });
      });
    }
  };
}

async function verifyPhoneCanReach(target, url) {
  if (target.startsWith("adb:")) return;
  const manifest = await run("ssh", [target, "curl", "-fsS", `${url}manifest.json`], { capture: true });
  const parsed = JSON.parse(manifest);
  if (!parsed.name) throw new Error(`Invalid manifest served from ${url}`);
}

async function requestThroughBridge(controller, pluginServer, options) {
  const requestId = randomUUID();
  const resultPromise = pluginServer.waitForBridgeResult(requestId, options.timeout);
  void resultPromise.catch(() => {});
  const link = new URL(`${BRIDGE_SCHEME}//${options.host}`);
  link.searchParams.set("token", options.token);
  link.searchParams.set("request", requestId);
  link.searchParams.set("action", options.action);
  link.searchParams.set("callback", pluginServer.callbackUrl(requestId));
  if (options.name) link.searchParams.set("name", options.name);
  if (options.source) link.searchParams.set("source", options.source);
  if (options.enabled !== undefined) link.searchParams.set("enabled", String(options.enabled));
  await controller.openUrl(link.toString());
  const result = await resultPromise;
  if (!result?.ok) throw new Error(result?.error || "Revenge plugin manager bridge rejected the request");
  return result;
}

async function requireManagerBridge(controller, pluginServer, source) {
  let status;
  try {
    status = await requestThroughBridge(controller, pluginServer, {
      host: BRIDGE_HOST,
      token: BRIDGE_TOKEN,
      action: "status",
      timeout: 5_000
    });
  } catch (error) {
    throw new Error(
      `${BRIDGE_NAME} is not installed. Programmatic Revenge lifecycle operations require the manager bridge.`,
      { cause: error }
    );
  }
  if (status.bridgeVersion === BRIDGE_VERSION) return;

  const refresh = await requestThroughBridge(controller, pluginServer, {
    host: BRIDGE_HOST,
    token: BRIDGE_TOKEN,
    action: "reinstall",
    name: BRIDGE_NAME,
    source,
    timeout: 10_000
  });
  if (!refresh.restartRequired) {
    throw new Error(`${BRIDGE_NAME} could not activate bridge version ${BRIDGE_VERSION}.`);
  }

  throw new Error(
    `${BRIDGE_NAME} was updated and will activate after Revenge next restarts; retry afterward`
  );
}

export async function manageRevengePlugins(operation, plugins, repositories, options) {
  if (!["install", "reinstall", "uninstall"].includes(operation)) {
    throw new Error(`Unsupported Revenge lifecycle operation: ${operation}`);
  }
  let publicUrl;
  try {
    publicUrl = new URL(options.publicUrl);
  } catch {
    throw new Error("Programmatic Revenge lifecycle operations require an HTTPS --public-url.");
  }
  if (publicUrl.protocol !== "https:") {
    throw new Error("Programmatic Revenge lifecycle operations require an HTTPS --public-url.");
  }

  const controller = new AndroidController(options.target);
  const bridgeDirectory = await mkdtemp(join(tmpdir(), "discord-plugin-manager-bridge-"));
  const bridgeRepository = await prepareBridgeRepository(bridgeDirectory);
  const includesPluginSources = operation !== "uninstall";
  const servedPlugins = [
    { name: BRIDGE_NAME },
    ...(includesPluginSources ? plugins : [])
  ];
  const servedRepositories = new Map(includesPluginSources ? repositories : []);
  servedRepositories.set(BRIDGE_NAME, bridgeRepository);
  const pluginServer = await createPluginServer(servedPlugins, servedRepositories, options);

  try {
    const bridgeSource = pluginServer.urls.get(BRIDGE_NAME);
    await verifyPhoneCanReach(options.target, bridgeSource);
    await controller.waitUntilReady({ wait: options.waitForRevenge });
    await requireManagerBridge(controller, pluginServer, bridgeSource);

    for (const plugin of plugins) {
      const result = await requestThroughBridge(controller, pluginServer, {
        host: BRIDGE_HOST,
        token: BRIDGE_TOKEN,
        action: operation,
        name: plugin.name,
        source: includesPluginSources ? pluginServer.urls.get(plugin.name) : undefined,
        timeout: 15_000,
      });
      if (operation === "uninstall") {
        console.log(`Uninstalled ${plugin.name} through the Revenge manager bridge`);
      } else {
        const verb = operation === "install" && !result.installed ? "Already installed" : `${operation}ed`;
        console.log(`${verb[0].toUpperCase()}${verb.slice(1)} ${plugin.name} through the Revenge manager bridge`);
        if (result.removed?.length) {
          console.log(`Removed ${result.removed.length} stale ${plugin.name} source(s)`);
        }
      }
    }

    if (options.restart) await controller.restartApp();
  } finally {
    await new Promise(resolveClose => pluginServer.server.close(resolveClose));
    await rm(bridgeDirectory, { recursive: true, force: true });
  }
}
