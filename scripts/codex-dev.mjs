#!/usr/bin/env node

import { spawn } from "node:child_process";
import "../server/env.mjs";

const taskboardPort = process.env.CODEX_TASKBOARD_PORT || "47823";
const healthUrl = `http://127.0.0.1:${taskboardPort}/health`;
const taskboardDevUrl = process.env.CODEX_TASKBOARD_UI_URL || "http://127.0.0.1:5173/";
const children = [];
let shuttingDown = false;

function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0 && signal !== "SIGTERM") stop(code ?? 1);
  });
  return child;
}

function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDevelopmentServer(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for the development server at ${url}`);
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

try {
  if (await isReachable(healthUrl)) {
    console.log(`Reusing the running 工作台 API at ${healthUrl}`);
    start(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:web"]);
  } else {
    start(process.execPath, ["scripts/dev.mjs"]);
  }
  await Promise.all([
    waitForDevelopmentServer(healthUrl),
    waitForDevelopmentServer(taskboardDevUrl),
  ]);
  start(process.execPath, [
    "scripts/codex-injector.mjs",
    "--launch",
    "--watch",
    "--open",
  ], {
    env: {
      ...process.env,
      CODEX_TASKBOARD_UI_URL: taskboardDevUrl,
    },
  });
} catch (error) {
  console.error(error.message);
  stop(1);
}
