import assert from "node:assert/strict";
import test from "node:test";

import { selectPlugins } from "../src/catalog.mjs";

const catalog = [
  { name: "One", platforms: ["vencord", "revenge"], default: true },
  { name: "Two", platforms: ["vencord"], default: false },
  { name: "Three", platforms: ["revenge"], default: true }
];

test("selects platform defaults without leaking other platforms", () => {
  assert.deepEqual(selectPlugins(catalog, "vencord").map(plugin => plugin.name), ["One"]);
  assert.deepEqual(selectPlugins(catalog, "revenge").map(plugin => plugin.name), ["One", "Three"]);
});

test("supports all and explicit case-insensitive selections", () => {
  assert.deepEqual(selectPlugins(catalog, "vencord", ["all"]).map(plugin => plugin.name), ["One", "Two"]);
  assert.deepEqual(selectPlugins(catalog, "vencord", ["two", "ONE"]).map(plugin => plugin.name), ["Two", "One"]);
});

test("rejects unknown or platform-incompatible selections", () => {
  assert.throws(() => selectPlugins(catalog, "revenge", ["Two"]), /Unknown revenge plugin: Two/);
});
