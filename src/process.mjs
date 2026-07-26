import { spawn } from "node:child_process";

export function run(command, args, options = {}) {
  const { capture = false, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) return resolve(stdout);
      const detail = capture && stderr.trim() ? `: ${stderr.trim()}` : "";
      reject(new Error(`${command} exited with code ${code}${detail}`));
    });
  });
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function remoteCommand(command, args = []) {
  return [command, ...args].map(shellQuote).join(" ");
}

export function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
