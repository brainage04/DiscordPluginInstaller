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
    if (names.has(plugin.name)) throw new Error(`Duplicate plugin name: ${plugin.name}`);
    names.add(plugin.name);
  }

  return catalog.plugins;
}

export function selectPlugins(catalog, platform, requested = []) {
  const available = catalog.filter(plugin => plugin.platforms.includes(platform));
  if (requested.length === 0 || requested.includes("default")) {
    return available.filter(plugin => plugin.default);
  }
  if (requested.includes("all")) return available;

  const selected = [];
  for (const name of requested) {
    const plugin = available.find(candidate => candidate.name.toLowerCase() === name.toLowerCase());
    if (!plugin) throw new Error(`Unknown ${platform} plugin: ${name}`);
    if (!selected.includes(plugin)) selected.push(plugin);
  }
  return selected;
}
