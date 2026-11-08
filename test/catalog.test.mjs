import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { loadCatalog, partitionRevengeSources, selectPlugins } from "../src/catalog.mjs";

const catalog = [
  { name: "One", platforms: ["vencord", "revenge"], default: true },
  { name: "Two", platforms: ["vencord"], default: false },
  { name: "Three", platforms: ["revenge"], default: true },
  {
    name: "Renamed",
    platforms: ["revenge"],
    default: false,
    renamedFrom: [{ name: "Original", directory: "original.vesktop" }]
  }
];

async function withCatalog(plugins, callback) {
  const root = await mkdtemp(resolve(tmpdir(), "plugin-catalog-"));
  const file = resolve(root, "catalog.json");
  await writeFile(file, JSON.stringify({ version: 1, plugins }));
  try {
    return await callback(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const entry = (name, extra = {}) => ({
  name,
  repository: `https://example.com/${name}.git`,
  directory: `${name}.vesktop`,
  platforms: ["vencord"],
  ...extra
});

test("selects platform defaults without leaking other platforms", () => {
  assert.deepEqual(selectPlugins(catalog, "vencord").map(plugin => plugin.name), ["One"]);
  assert.deepEqual(selectPlugins(catalog, "revenge").map(plugin => plugin.name), ["One", "Three"]);
});

test("supports all and explicit case-insensitive selections", () => {
  assert.deepEqual(selectPlugins(catalog, "vencord", ["all"]).map(plugin => plugin.name), ["One", "Two"]);
  assert.deepEqual(selectPlugins(catalog, "vencord", ["two", "ONE"]).map(plugin => plugin.name), ["Two", "One"]);
});

test("selects a renamed plugin by its earlier name", () => {
  assert.deepEqual(
    selectPlugins(catalog, "revenge", ["original", "Renamed"]).map(plugin => plugin.name),
    ["Renamed"]
  );
});

test("rejects unknown or platform-incompatible selections", () => {
  assert.throws(() => selectPlugins(catalog, "revenge", ["Two"]), /Unknown revenge plugin: Two/);
});

test("rejects an earlier name that collides with another plugin", async () => {
  await withCatalog(
    [entry("Current"), entry("Other", { renamedFrom: [{ name: "current", directory: "x.vesktop" }] })],
    async file => await assert.rejects(loadCatalog(file), /Duplicate plugin name: current/)
  );
});

test("rejects a renamedFrom entry without a directory", async () => {
  await withCatalog(
    [entry("Current", { renamedFrom: [{ name: "Old" }] })],
    async file => await assert.rejects(loadCatalog(file), /Invalid renamedFrom in catalog entry: Current/)
  );
});

test("rejects a revengeSource that is not an https directory URL", async () => {
  for (const revengeSource of ["http://example.com/p/", "https://example.com/p", "not a url"]) {
    await withCatalog(
      [entry("Current", { revengeSource })],
      async file => await assert.rejects(loadCatalog(file), /Invalid revengeSource in catalog entry: Current/)
    );
  }
});

test("installs from the published source unless a local repository overrides it", () => {
  const plugins = [
    { name: "Published", revengeSource: "https://example.com/Published/" },
    { name: "Overridden", revengeSource: "https://example.com/Overridden/" },
    { name: "Unpublished" }
  ];
  const { published, local } = partitionRevengeSources(plugins, new Map([["Overridden", "/src/overridden"]]));
  assert.deepEqual([...published], [["Published", "https://example.com/Published/"]]);
  assert.deepEqual(local.map(plugin => plugin.name), ["Overridden", "Unpublished"]);
});
