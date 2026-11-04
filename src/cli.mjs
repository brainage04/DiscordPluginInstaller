#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCatalog, pluginDirectories, selectPlugins } from "./catalog.mjs";
import { buildRevengePlugins, prepareRepositories } from "./repositories.mjs";
import { manageRevengePlugins } from "./revenge.mjs";
import {
  buildVencordPlugins,
  configureVencordPlugins,
  deployVencord,
  prepareVencordWorkspace
} from "./vencord.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Usage:
  discord-plugin-installer vencord <install|reinstall|uninstall> [options]
  discord-plugin-installer revenge <install|reinstall|uninstall> [options]

Shared options:
  --plugins NAME[,NAME]       Plugins to manage; defaults to catalog defaults
  --repository NAME=PATH      Use a local repository for install or reinstall
  --cache PATH                Repository cache directory
  --catalog PATH              Alternate version-1 catalog
  --no-update                 Do not pull cached repositories
  --restart                   Restart the target client after the operation

Vencord options:
  --source PATH               Vencord workspace (default: ../VencordWorkspace)
  --target local|SSH_HOST     Deployment target; repeat for several targets
  --vencord-dir PATH          Override the target's Vesktop Vencord directory
  --vencord-settings PATH     Override the target's Vencord settings JSON
  --enable                    Enable plugins after install or reinstall
  --disable                   Disable plugins after install or reinstall
  --prune                     Remove other unselected catalog plugin sources

Revenge options:
  --target adb:SERIAL|SSH_HOST  Android target (default: phone)
  --public-url URL              Required HTTPS base URL for the temporary server
  --bind ADDRESS                HTTP bind address (default: 0.0.0.0)
  --port PORT                   Temporary plugin-server port (default: 8765)
  --wait-for-revenge            Wait until Revenge is unlocked and foregrounded

Every install, reinstall, and uninstall operation is programmatic. Revenge uses
only its manager bridge and never brings Discord over another foreground app;
Vencord updates source, settings, and runtime files directly without restarting
by default. There is no clipboard, UI automation, legacy bridge, or fallback.
`;

function parseArguments(argv) {
  const rawCommand = argv.shift();
  const command = rawCommand === "--help" || rawCommand === "-h" ? "help" : rawCommand;
  const rawOperation = command && command !== "help" ? argv.shift() : undefined;
  const operation = rawOperation === "--help" || rawOperation === "-h" ? "help" : rawOperation;
  const options = {
    plugins: [],
    repositories: new Map(),
    targets: [],
    update: true
  };

  while (argv.length) {
    const argument = argv.shift();
    if (argument === "--help" || argument === "-h") return { command: "help", operation, options };
    if (argument === "--no-update") {
      options.update = false;
      continue;
    }
    if (argument === "--prune") {
      options.prune = true;
      continue;
    }
    if (argument === "--restart") {
      options.restart = true;
      continue;
    }
    if (argument === "--wait-for-revenge") {
      options.waitForRevenge = true;
      continue;
    }
    if (argument === "--enable" || argument === "--disable") {
      const pluginState = argument.slice(2);
      if (options.pluginState && options.pluginState !== pluginState) {
        throw new Error("--enable and --disable cannot be used together");
      }
      options.pluginState = pluginState;
      continue;
    }
    const value = argv.shift();
    if (value === undefined) throw new Error(`Missing value for ${argument}`);
    switch (argument) {
      case "--plugins":
        options.plugins.push(...value.split(",").filter(Boolean));
        break;
      case "--repository": {
        const separator = value.indexOf("=");
        if (separator < 1) throw new Error("--repository must use NAME=PATH");
        options.repositories.set(value.slice(0, separator), value.slice(separator + 1));
        break;
      }
      case "--target":
        options.targets.push(value);
        break;
      case "--source": options.source = value; break;
      case "--cache": options.cache = value; break;
      case "--catalog": options.catalog = value; break;
      case "--vencord-dir": options.vencordDirectory = value; break;
      case "--vencord-settings": options.vencordSettings = value; break;
      case "--public-url": options.publicUrl = value; break;
      case "--bind": options.bind = value; break;
      case "--port": options.port = Number(value); break;
      default: throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { command, operation, options };
}

async function main() {
  const { command, operation, options } = parseArguments(process.argv.slice(2));
  if (!command || command === "help" || operation === "help") {
    console.log(HELP);
    return;
  }
  if (command !== "vencord" && command !== "revenge") {
    throw new Error(`Unknown platform: ${command}`);
  }
  if (!["install", "reinstall", "uninstall"].includes(operation)) {
    throw new Error(`Unknown lifecycle operation: ${operation || "(missing)"}`);
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (operation === "uninstall" && options.repositories.size) {
    throw new Error("--repository is not valid for uninstall");
  }
  if (operation === "uninstall" && options.prune) {
    throw new Error("--prune is not valid for uninstall");
  }
  if (operation === "uninstall" && options.pluginState) {
    throw new Error("--enable and --disable are not valid for uninstall");
  }
  if (command === "revenge" && options.pluginState) {
    throw new Error("--enable and --disable are Vencord options");
  }

  const catalog = await loadCatalog(options.catalog && resolve(options.catalog));
  const plugins = selectPlugins(catalog, command, options.plugins);
  if (plugins.length === 0) throw new Error(`No ${command} plugins selected.`);
  const repositories = operation === "uninstall"
    ? new Map()
    : await prepareRepositories(plugins, {
      cacheDirectory: options.cache,
      overrides: options.repositories,
      update: options.update
    });

  if (command === "vencord") {
    const source = options.source
      ? resolve(options.source)
      : resolve(ROOT, "..", "VencordWorkspace");
    const targets = options.targets.length ? options.targets : ["local"];
    await prepareVencordWorkspace(source, { update: options.update });
    const managedDirectories = options.prune
      ? catalog.filter(plugin => plugin.platforms.includes("vencord")).flatMap(pluginDirectories)
      : [];
    const buildDirectory = await buildVencordPlugins(
      source,
      operation,
      plugins,
      repositories,
      { managedDirectories }
    );
    if (operation === "uninstall" || options.pluginState) {
      await configureVencordPlugins(
        targets,
        plugins,
        operation === "uninstall" ? "uninstall" : options.pluginState,
        { file: options.vencordSettings }
      );
    }
    await deployVencord(buildDirectory, targets, {
      directory: options.vencordDirectory,
      restart: options.restart
    });
    return;
  }

  if (options.targets.length > 1) {
    throw new Error("Revenge lifecycle operations accept one Android target at a time.");
  }
  if (operation !== "uninstall") {
    await buildRevengePlugins(plugins, repositories);
  }
  await manageRevengePlugins(operation, plugins, repositories, {
    target: options.targets[0] || "phone",
    bind: options.bind,
    publicUrl: options.publicUrl,
    port: options.port,
    waitForRevenge: options.waitForRevenge,
    restart: options.restart,
  });
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
