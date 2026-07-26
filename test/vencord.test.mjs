import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildVencordPlugins,
  configureVencordPlugins,
  copyPluginSource,
  deployVencord,
  prepareVencordWorkspace
} from "../src/vencord.mjs";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("creates and prepares a missing Vencord workspace", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vencord-workspace-"));
  const source = resolve(root, "VencordWorkspace");
  const commands = [];

  try {
    const prepared = await prepareVencordWorkspace(source, {
      repository: "https://example.test/Vencord.git",
      run: async (command, args, options = {}) => {
        commands.push({ command, args, cwd: options.cwd });
        if (command === "git" && args[0] === "clone") {
          await mkdir(resolve(args.at(-1), ".git"), { recursive: true });
        }
      }
    });

    assert.equal(prepared, source);
    assert.deepEqual(commands, [
      {
        command: "git",
        args: [
          "clone",
          "--depth", "1",
          "https://example.test/Vencord.git",
          source
        ],
        cwd: undefined
      },
      {
        command: "corepack",
        args: ["pnpm", "install", "--frozen-lockfile"],
        cwd: source
      }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to replace a non-Git Vencord workspace", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vencord-workspace-"));
  const source = resolve(root, "VencordWorkspace");
  const marker = resolve(source, "dist", "vencordDesktopMain.js");
  await mkdir(resolve(source, "dist"), { recursive: true });
  await writeFile(marker, "preserve");

  try {
    await assert.rejects(
      prepareVencordWorkspace(source, { run: async () => assert.fail("must not run commands") }),
      /not a Git checkout/
    );
    assert.equal(await readFile(marker, "utf8"), "preserve");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks an in-place build as a Vesktop runtime", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vencord-runtime-"));
  const build = resolve(root, "dist");
  await mkdir(build, { recursive: true });

  try {
    assert.deepEqual(
      await deployVencord(build, ["local"], { directory: build }),
      [build]
    );
    assert.equal(await readFile(resolve(build, "package.json"), "utf8"), "{}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updates Vencord files without deleting repository metadata", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vencord-plugin-sync-"));
  const source = resolve(root, "source");
  const destination = resolve(root, "destination");
  await Promise.all([
    mkdir(resolve(source, "common"), { recursive: true }),
    mkdir(resolve(source, "vencord"), { recursive: true }),
    mkdir(resolve(destination, ".git"), { recursive: true }),
    mkdir(resolve(destination, "common"), { recursive: true }),
    mkdir(resolve(destination, "revenge"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(resolve(source, "index.tsx"), "export { default } from './vencord';"),
    writeFile(resolve(source, "common", "shared.ts"), "export const current = true;"),
    writeFile(resolve(source, "vencord", "index.tsx"), "export default {};"),
    writeFile(resolve(destination, "index.ts"), "obsolete"),
    writeFile(resolve(destination, "common", "obsolete.ts"), "obsolete"),
    writeFile(resolve(destination, ".git", "config"), "preserve"),
    writeFile(resolve(destination, "revenge", "index.ts"), "preserve")
  ]);

  try {
    await copyPluginSource(source, destination);
    assert.equal(await readFile(resolve(destination, ".git", "config"), "utf8"), "preserve");
    assert.equal(await readFile(resolve(destination, "revenge", "index.ts"), "utf8"), "preserve");
    assert.equal(await readFile(resolve(destination, "vencord", "index.tsx"), "utf8"), "export default {};");
    assert.equal(await exists(resolve(destination, "index.ts")), false);
    assert.equal(await exists(resolve(destination, "common", "obsolete.ts")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("programmatically uninstalls selected Vencord plugin source", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vencord-uninstall-"));
  const selected = resolve(root, "src", "userplugins", "selected");
  const unrelated = resolve(root, "src", "userplugins", "unrelated");
  await Promise.all([
    mkdir(selected, { recursive: true }),
    mkdir(unrelated, { recursive: true })
  ]);
  await Promise.all([
    writeFile(resolve(selected, "index.ts"), "remove"),
    writeFile(resolve(unrelated, "index.ts"), "preserve")
  ]);
  const commands = [];

  try {
    assert.equal(
      await buildVencordPlugins(
        root,
        "uninstall",
        [{ name: "Selected", directory: "selected" }],
        new Map(),
        {
          run: async (command, args, options) => commands.push({ command, args, cwd: options.cwd })
        }
      ),
      resolve(root, "dist")
    );
    assert.equal(await exists(selected), false);
    assert.equal(await exists(unrelated), true);
    assert.deepEqual(commands, [{
      command: "corepack",
      args: ["pnpm", "run", "build", "--standalone"],
      cwd: root
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configures Vencord plugins without discarding existing settings", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vencord-settings-"));
  const file = resolve(root, "settings", "settings.json");
  await mkdir(resolve(root, "settings"), { recursive: true });
  await writeFile(file, JSON.stringify({
    plugins: {
      ConversationExporter: {
        enabled: false,
        format: "pretty"
      },
      Unrelated: {
        enabled: true
      }
    },
    notifications: {
      timeout: 5000
    }
  }));

  try {
    assert.deepEqual(
      await configureVencordPlugins(
        ["local"],
        [{ name: "ConversationExporter" }, { name: "PresenceWatcher" }],
        "enable",
        { file }
      ),
      [file]
    );
    let settings = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(settings.plugins.ConversationExporter, {
      enabled: true,
      format: "pretty"
    });
    assert.deepEqual(settings.plugins.PresenceWatcher, { enabled: true });
    assert.deepEqual(settings.plugins.Unrelated, { enabled: true });
    assert.deepEqual(settings.notifications, { timeout: 5000 });

    await configureVencordPlugins(
      ["local"],
      [{ name: "ConversationExporter" }],
      "disable",
      { file }
    );
    settings = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(settings.plugins.ConversationExporter, {
      enabled: false,
      format: "pretty"
    });

    await configureVencordPlugins(
      ["local"],
      [{ name: "ConversationExporter" }],
      "uninstall",
      { file }
    );
    settings = JSON.parse(await readFile(file, "utf8"));
    assert.equal(settings.plugins.ConversationExporter, undefined);
    assert.deepEqual(settings.plugins.Unrelated, { enabled: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
