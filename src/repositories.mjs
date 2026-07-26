import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { run } from "./process.mjs";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function defaultCacheDirectory() {
  return resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "discord-plugin-installer", "plugins");
}

export async function prepareRepositories(plugins, options = {}) {
  const cacheDirectory = resolve(options.cacheDirectory || defaultCacheDirectory());
  await mkdir(cacheDirectory, { recursive: true });

  const prepared = new Map();
  for (const plugin of plugins) {
    const override = options.overrides?.get(plugin.name);
    if (override) {
      const repositoryDirectory = resolve(override);
      if (!await exists(resolve(repositoryDirectory, "index.ts")) && !await exists(resolve(repositoryDirectory, "index.tsx"))) {
        throw new Error(`Invalid local repository for ${plugin.name}: ${repositoryDirectory}`);
      }
      prepared.set(plugin.name, repositoryDirectory);
      continue;
    }
    const repositoryDirectory = resolve(cacheDirectory, plugin.name);
    if (await exists(resolve(repositoryDirectory, ".git"))) {
      if (options.update !== false) {
        console.log(`Updating ${plugin.name}`);
        await run("git", ["pull", "--ff-only"], { cwd: repositoryDirectory });
      }
    } else {
      console.log(`Cloning ${plugin.name}`);
      await run("git", ["clone", "--depth", "1", plugin.repository, repositoryDirectory]);
    }
    prepared.set(plugin.name, repositoryDirectory);
  }

  return prepared;
}

export async function buildRevengePlugins(plugins, repositories) {
  for (const plugin of plugins) {
    const directory = repositories.get(plugin.name);
    console.log(`Building ${plugin.name} for Revenge`);
    if (!await exists(resolve(directory, "node_modules"))) {
      await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: directory });
    }
    await run("npm", ["run", "build"], { cwd: directory });
  }
}
