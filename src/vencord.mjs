import { spawn } from "node:child_process";
import { access, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { delay, run, shellQuote } from "./process.mjs";

export const VENCORD_RUNTIME_FILES = [
  "vencordDesktopMain.js",
  "vencordDesktopPreload.js",
  "vencordDesktopRenderer.js",
  "vencordDesktopRenderer.css"
];

export const VENCORD_REPOSITORY = "https://github.com/Vendicated/Vencord.git";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function prepareVencordWorkspace(sourceDirectory, options = {}) {
  const source = resolve(sourceDirectory);
  const runCommand = options.run || run;

  if (!await exists(source)) {
    await mkdir(dirname(source), { recursive: true });
    console.log(`Cloning Vencord into ${source}`);
    await runCommand("git", [
      "clone",
      "--depth", "1",
      options.repository || VENCORD_REPOSITORY,
      source
    ]);
  } else if (!await exists(resolve(source, ".git"))) {
    throw new Error(`Vencord workspace is not a Git checkout: ${source}`);
  } else if (options.update !== false) {
    console.log(`Updating Vencord in ${source}`);
    await runCommand("git", ["pull", "--ff-only"], { cwd: source });
  }

  await runCommand("corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: source });
  return source;
}

export async function copyPluginSource(repositoryDirectory, destination) {
  if (resolve(repositoryDirectory) === resolve(destination)) return;
  await Promise.all([
    rm(resolve(destination, "index.ts"), { force: true }),
    rm(resolve(destination, "index.tsx"), { force: true }),
    rm(resolve(destination, "common"), { recursive: true, force: true }),
    rm(resolve(destination, "vencord"), { recursive: true, force: true })
  ]);
  await mkdir(destination, { recursive: true });
  const entry = await exists(resolve(repositoryDirectory, "index.ts")) ? "index.ts" : "index.tsx";
  await copyFile(resolve(repositoryDirectory, entry), resolve(destination, entry));
  await cp(resolve(repositoryDirectory, "common"), resolve(destination, "common"), { recursive: true });
  await cp(resolve(repositoryDirectory, "vencord"), resolve(destination, "vencord"), { recursive: true });
}

export async function buildVencordPlugins(sourceDirectory, operation, plugins, repositories, options = {}) {
  if (!["install", "reinstall", "uninstall"].includes(operation)) {
    throw new Error(`Unsupported Vencord lifecycle operation: ${operation}`);
  }
  const source = resolve(sourceDirectory);
  const runCommand = options.run || run;
  const userplugins = resolve(source, "src", "userplugins");
  await mkdir(userplugins, { recursive: true });

  if (operation === "uninstall") {
    for (const plugin of plugins) {
      console.log(`Removing ${plugin.name} source from Vencord`);
      await rm(resolve(userplugins, plugin.directory), { recursive: true, force: true });
    }
  } else {
    const repositoryDirectories = new Set(
      [...repositories.values()].map(directory => resolve(directory))
    );
    for (const directory of new Set(options.managedDirectories || [])) {
      const destination = resolve(userplugins, directory);
      if (!repositoryDirectories.has(destination)) {
        await rm(destination, { recursive: true, force: true });
      }
    }

    for (const plugin of plugins) {
      console.log(`${operation === "install" ? "Installing" : "Reinstalling"} ${plugin.name} source in Vencord`);
      await copyPluginSource(repositories.get(plugin.name), resolve(userplugins, plugin.directory));
    }
  }

  await runCommand("corepack", ["pnpm", "run", "build", "--standalone"], { cwd: source });
  return resolve(source, "dist");
}

async function localVencordDirectory() {
  const configDirectory = resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "vesktop");
  try {
    const state = JSON.parse(await readFile(resolve(configDirectory, "state.json"), "utf8"));
    if (state.vencordDir) return resolve(state.vencordDir);
  } catch {
    // Vesktop uses its managed runtime directory when no readable override exists.
  }
  return resolve(configDirectory, "sessionData", "vencordFiles");
}

async function remoteVencordDirectory(host) {
  try {
    const stateText = await run("ssh", [host, "cat \"$HOME/.config/vesktop/state.json\""], { capture: true });
    const state = JSON.parse(stateText);
    if (state.vencordDir) return state.vencordDir;
  } catch {
    // Use Vesktop's managed runtime directory when no readable override exists.
  }
  const home = (await run("ssh", [host, "printf %s \"$HOME\""], { capture: true })).trim();
  return `${home}/.config/vesktop/sessionData/vencordFiles`;
}

async function deployLocal(buildDirectory, explicitDirectory) {
  const destination = explicitDirectory ? resolve(explicitDirectory) : await localVencordDirectory();
  await mkdir(destination, { recursive: true });
  if (resolve(buildDirectory) !== destination) {
    for (const filename of VENCORD_RUNTIME_FILES) {
      await copyFile(resolve(buildDirectory, filename), resolve(destination, filename));
    }
  }
  await writeFile(resolve(destination, "package.json"), "{}");
  return destination;
}

async function deployRemote(buildDirectory, host, explicitDirectory) {
  const destination = explicitDirectory || await remoteVencordDirectory(host);
  const setup = `mkdir -p ${shellQuote(destination)} && printf '{}' > ${shellQuote(`${destination}/package.json`)}`;
  await run("ssh", [host, setup]);
  await run("scp", [
    ...VENCORD_RUNTIME_FILES.map(filename => resolve(buildDirectory, filename)),
    `${host}:${destination}/`
  ]);
  return `${host}:${destination}`;
}

function updatePluginSettings(settings, plugins, operation) {
  settings.plugins ??= {};
  for (const plugin of plugins) {
    if (operation === "uninstall") {
      delete settings.plugins[plugin.name];
    } else {
      settings.plugins[plugin.name] = {
        ...settings.plugins[plugin.name],
        enabled: operation === "enable"
      };
    }
  }
  return settings;
}

async function configureLocalVencord(plugins, operation, explicitFile) {
  const file = explicitFile
    ? resolve(explicitFile)
    : resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "vesktop", "settings", "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  updatePluginSettings(settings, plugins, operation);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 4)}\n`);
  await rename(temporary, file);
  return file;
}

async function configureRemoteVencord(host, plugins, operation, explicitFile) {
  const home = (await run("ssh", [host, "printf %s \"$HOME\""], { capture: true })).trim();
  const file = explicitFile || `${home}/.config/vesktop/settings/settings.json`;
  const readCommand = `if test -f ${shellQuote(file)}; then cat ${shellQuote(file)}; else printf '{}'; fi`;
  const settings = JSON.parse(await run("ssh", [host, readCommand], { capture: true }));
  updatePluginSettings(settings, plugins, operation);
  const encoded = Buffer.from(`${JSON.stringify(settings, null, 4)}\n`).toString("base64");
  const temporary = `${file}.tmp-${process.pid}`;
  const writeCommand = [
    `mkdir -p ${shellQuote(dirname(file))}`,
    `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(temporary)}`,
    `mv ${shellQuote(temporary)} ${shellQuote(file)}`
  ].join(" && ");
  await run("ssh", [host, writeCommand]);
  return `${host}:${file}`;
}

export async function configureVencordPlugins(targets, plugins, operation, options = {}) {
  if (!["enable", "disable", "uninstall"].includes(operation)) {
    throw new Error(`Unsupported Vencord settings operation: ${operation}`);
  }
  const configured = [];
  for (const target of targets) {
    const file = target === "local"
      ? await configureLocalVencord(plugins, operation, options.file)
      : await configureRemoteVencord(target, plugins, operation, options.file);
    const verb = operation === "uninstall"
      ? "Removed settings for"
      : `${operation === "enable" ? "Enabled" : "Disabled"}`;
    console.log(`${verb} ${plugins.map(plugin => plugin.name).join(", ")} in ${file}`);
    configured.push(file);
  }
  return configured;
}

async function restartVesktop(target) {
  if (target === "local") {
    await run("pkill", ["-x", "vesktop"], { capture: true }).catch(() => {});
    await delay(1000);
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
    const child = spawn("/opt/Vesktop/vesktop", [], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":0",
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
        XDG_RUNTIME_DIR: runtimeDirectory,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDirectory}/bus`
      }
    });
    child.unref();
    await delay(1500);
    await run("pgrep", ["-x", "vesktop"], { capture: true });
  } else {
    const command = "pkill -x vesktop >/dev/null 2>&1 || true; sleep 1; uid=$(id -u); runtime=/run/user/$uid; set -- $runtime/.mutter-Xwaylandauth.*; xauthority=$1; nohup env DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=$runtime DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime/bus XAUTHORITY=$xauthority /opt/Vesktop/vesktop >/dev/null 2>&1 </dev/null &";
    await run("ssh", [target, command]);
    await delay(1500);
    await run("ssh", [target, "pgrep -x vesktop >/dev/null"]);
  }
  console.log(`Restarted Vesktop on ${target}`);
}

export async function deployVencord(buildDirectory, targets, options = {}) {
  const installed = [];
  for (const target of targets) {
    const destination = target === "local"
      ? await deployLocal(buildDirectory, options.directory)
      : await deployRemote(buildDirectory, target, options.directory);
    console.log(`Installed Vencord bundle at ${destination}`);
    if (options.restart) await restartVesktop(target);
    installed.push(destination);
  }
  return installed;
}
