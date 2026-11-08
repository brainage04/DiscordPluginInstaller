import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadCatalog(path = resolve(ROOT, "catalog.json")) {
  const catalog = JSON.parse(await readFile(path, "utf8"));
  if (catalog.version !== 1 || !Array.isArray(catalog.plugins)) {
    throw new Error(`Unsupported plugin catalog: ${path}`);
  }

  const names = new Set();
  for (const plugin of catalog.plugins) {
    if (!plugin.name || !plugin.repository || !plugin.directory || !Array.isArray(plugin.platforms)) {
      throw new Error(`Invalid plugin catalog entry: ${JSON.stringify(plugin)}`);
    }
    plugin.renamedFrom ??= [];
    if (!Array.isArray(plugin.renamedFrom)
      || plugin.renamedFrom.some(former => !former?.name || !former.directory)) {
      throw new Error(`Invalid renamedFrom in catalog entry: ${plugin.name}`);
    }
    if (plugin.revengeSource !== undefined && !isPublishedSource(plugin.revengeSource)) {
      throw new Error(`Invalid revengeSource in catalog entry: ${plugin.name} (must be an https URL ending in /)`);
    }
    for (const name of [plugin.name, ...plugin.renamedFrom.map(former => former.name)]) {
      const key = name.toLowerCase();
      if (names.has(key)) throw new Error(`Duplicate plugin name: ${name}`);
      names.add(key);
    }
  }

  return catalog.plugins;
}

function isPublishedSource(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname.endsWith("/") && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Names the plugin is or was installed under; earlier names come from catalog renames. */
export function knownNames(plugin) {
  return [plugin.name, ...(plugin.renamedFrom ?? []).map(former => former.name)];
}

/**
 * Splits Revenge plugins into those installed from their published source URL and those that must be
 * built and served locally (no published source, or a --repository override).
 */
export function partitionRevengeSources(plugins, overrides = new Map()) {
  const published = new Map();
  const local = [];
  for (const plugin of plugins) {
    if (plugin.revengeSource && !overrides.has(plugin.name)) published.set(plugin.name, plugin.revengeSource);
    else local.push(plugin);
  }
  return { published, local };
}

/** Vencord userplugin directories the plugin is or was installed in. */
export function pluginDirectories(plugin) {
  return [plugin.directory, ...(plugin.renamedFrom ?? []).map(former => former.directory)];
}

export function selectPlugins(catalog, platform, requested = []) {
  const available = catalog.filter(plugin => plugin.platforms.includes(platform));
  if (requested.length === 0 || requested.includes("default")) {
    return available.filter(plugin => plugin.default);
  }
  if (requested.includes("all")) return available;

  const selected = [];
  for (const name of requested) {
    const plugin = available.find(candidate =>
      knownNames(candidate).some(known => known.toLowerCase() === name.toLowerCase())
    );
    if (!plugin) throw new Error(`Unknown ${platform} plugin: ${name}`);
    if (!selected.includes(plugin)) selected.push(plugin);
  }
  return selected;
}
