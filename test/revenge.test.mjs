import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createPluginServer } from "../src/revenge.mjs";

test("serves only a selected plugin's built manifest and bundle", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "discord-plugin-installer-"));
  const dist = resolve(root, "dist");
  await mkdir(dist);
  await writeFile(resolve(dist, "manifest.json"), JSON.stringify({ name: "Example" }));
  await writeFile(resolve(dist, "index.js"), "export default {};");

  const plugin = { name: "Example" };
  const { server, urls, callbackUrl, waitForBridgeResult } = await createPluginServer([plugin], new Map([[plugin.name, root]]), {
    bind: "127.0.0.1",
    port: 0
  });
  try {
    const base = urls.get(plugin.name);
    const manifest = await (await fetch(`${base}manifest.json`)).json();
    assert.equal(manifest.name, "Example");
    assert.equal(await (await fetch(`${base}index.js`)).text(), "export default {};");
    assert.equal((await fetch(`${base}missing.js`)).status, 404);
    const requestId = "123e4567-e89b-12d3-a456-426614174000";
    const resultPromise = waitForBridgeResult(requestId);
    const callbackResponse = await fetch(callbackUrl(requestId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, ok: true })
    });
    assert.equal(callbackResponse.status, 204);
    assert.deepEqual(await resultPromise, { requestId, ok: true });
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});
