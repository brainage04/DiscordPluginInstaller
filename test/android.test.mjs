import assert from "node:assert/strict";
import test from "node:test";

import { AndroidController } from "../src/android.mjs";

test("opens manager URLs only while Revenge is already foregrounded", async () => {
  const controller = new AndroidController("phone");
  const commands = [];
  controller.shell = async command => {
    commands.push(command);
    return "topResumedActivity=ActivityRecord{abc u0 app.revenge/com.discord.main.MainDefault t42}";
  };

  assert.equal(await controller.isReady(), true);
  await controller.openUrl("discord-plugin-installer://manage");
  assert.match(commands.at(-1), /^am start .*--activity-no-animation/);
});

test("refuses to cover another app while the device is unlocked", async () => {
  const controller = new AndroidController("phone");
  const commands = [];
  controller.shell = async command => {
    commands.push(command);
    return "mResumedActivity: ActivityRecord{abc u0 com.example.reader/.Main t42}";
  };

  await assert.rejects(
    controller.openUrl("discord-plugin-installer://manage"),
    /Refusing to open Revenge over the current activity/
  );
  assert.equal(commands.some(command => command.startsWith("am start ")), false);
});
