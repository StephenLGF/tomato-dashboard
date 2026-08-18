#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolvePort } from "../server/app.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const taskboardUrl = `http://127.0.0.1:${resolvePort()}/?project=tomato`;
const healthUrl = `http://127.0.0.1:${resolvePort()}/health`;

async function isHealthy() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isHealthy()) return false;

  const child = spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isHealthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for 工作台服务 at ${healthUrl}`);
}

const started = await ensureServer();
const openProcess = spawn("/usr/bin/open", [taskboardUrl], { stdio: "ignore" });
openProcess.unref();

console.log(`${started ? "Started" : "Using"} 工作台服务。`);
console.log(`Opened ${taskboardUrl}`);
