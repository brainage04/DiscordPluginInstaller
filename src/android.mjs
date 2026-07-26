import { delay, run, shellQuote } from "./process.mjs";

const REVENGE_PACKAGE = "app.revenge";

export class AndroidController {
  constructor(target) {
    this.target = target;
  }

  async shell(command) {
    if (this.target.startsWith("adb:")) {
      const serial = this.target.slice(4);
      return await run("adb", ["-s", serial, "shell", command], { capture: true });
    }
    return await run("ssh", [this.target, `rish -c ${shellQuote(command)}`], { capture: true });
  }

  async isReady() {
    const foregroundTask = await this.foregroundTask();
    return foregroundTask?.packageName === REVENGE_PACKAGE;
  }

  async waitUntilReady(options = {}) {
    let announcedWait = false;
    while (!await this.isReady()) {
      if (!options.wait) {
        throw new Error(
          "Refusing to open Revenge over the current activity; unlock the device "
          + "and bring Revenge to the foreground before retrying"
        );
      }
      if (!announcedWait) {
        console.log(`Waiting for Revenge to be unlocked and foregrounded on ${this.target}`);
        announcedWait = true;
      }
      await delay(3000);
    }
  }

  async foregroundTask() {
    const activities = await this.shell("dumpsys activity activities");
    const resumed = activities.match(
      /(?:mResumedActivity: |topResumedActivity=)ActivityRecord\{[^\n]*?\s([a-zA-Z0-9._]+)\/\S+\s+t(\d+)\}/
    );
    if (resumed) return { id: Number(resumed[2]), packageName: resumed[1] };

    const visibleTasks = [...activities.matchAll(
      /^\s+\* Task\{[^\n]*#(\d+)[^\n]*\bI=([a-zA-Z0-9._]+)\/\S+[^\n]*\bvisible=true\b/gm
    )];
    const visibleTask = visibleTasks.at(-1);
    if (!visibleTask) return;
    return { id: Number(visibleTask[1]), packageName: visibleTask[2] };
  }

  async openUrl(url) {
    await this.waitUntilReady();
    await this.shell(
      `am start -W --activity-no-animation --activity-no-user-action `
      + `-n ${REVENGE_PACKAGE}/com.discord.main.MainDefault `
      + `-a android.intent.action.VIEW -d ${shellQuote(url)} >/dev/null`
    );
  }

  async restartApp() {
    await this.waitUntilReady();
    await this.shell(`am force-stop ${REVENGE_PACKAGE}; monkey -p ${REVENGE_PACKAGE} 1 >/dev/null`);
  }


}
