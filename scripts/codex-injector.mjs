#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolvePort } from "../server/app.mjs";
import {
  findResidentInjectorPids,
  handleHostBindingPayload,
  pruneStaleHostConnections,
  reconcileInjectionRuntime,
  restartResidentInjector,
} from "./codex-injector-runtime.mjs";

const injectorPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(injectorPath), "..");
const defaultCodexDebuggingPort = 9229;
const injectionPath = path.join(projectRoot, "inject", "codex-taskboard.user.js");
const taskboardOrigin = `http://127.0.0.1:${resolvePort()}`;
const taskboardHealthUrl = `${taskboardOrigin}/health`;
const configuredTaskboardUiOrigin = process.env.CODEX_TASKBOARD_UI_URL?.trim() || taskboardOrigin;
const taskboardUiUrl = new URL(configuredTaskboardUiOrigin);
if (taskboardUiUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(taskboardUiUrl.hostname)) {
  throw new Error("CODEX_TASKBOARD_UI_URL must be a loopback HTTP URL");
}
taskboardUiUrl.searchParams.set("host", "codex");
const taskboardPageUrl = taskboardUiUrl.href;
const defaultLifeHelperOrigin = taskboardUiUrl.port === "5173"
  ? "http://127.0.0.1:5174/"
  : "http://127.0.0.1:47824/";
const configuredLifeHelperOrigin = process.env.CODEX_LIFE_HELPER_URL?.trim() || defaultLifeHelperOrigin;
const lifeHelperUrl = new URL(configuredLifeHelperOrigin);
if (lifeHelperUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(lifeHelperUrl.hostname)) {
  throw new Error("CODEX_LIFE_HELPER_URL must be a loopback HTTP URL");
}
lifeHelperUrl.searchParams.set("host", "codex");
const hostBindingName = "__codexTaskboardHostV1";
const hostHeartbeatName = "__codexTaskboardHostHeartbeatV1";
const hostStartupTokenName = "__codexTaskboardHostStartupTokenV1";
const injectionSourceHashName = "__CODEX_TASKBOARD_SOURCE_HASH__";
const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__";
const hostHeartbeatTimeoutMs = 1_500;
const hostHeartbeatIntervalMs = 5_000;
function parseArgs(argv) {
  const options = {
    port: defaultCodexDebuggingPort,
    portExplicit: false,
    launch: false,
    watch: false,
    open: false,
    refresh: false,
    refreshIfRunning: false,
    attachExisting: false,
    startupToken: null,
    daemon: false,
    screenshot: null,
    appPath: "/Applications/ChatGPT.app",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--launch") options.launch = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--refresh-if-running") options.refreshIfRunning = true;
    else if (arg === "--attach-existing") options.attachExisting = true;
    else if (arg === "--startup-token") {
      options.startupToken = argv[++index];
      if (!/^[a-z0-9-]{1,100}$/i.test(options.startupToken || "")) {
        throw new Error("--startup-token must be an identifier");
      }
    }
    else if (arg === "--daemon") options.daemon = true;
    else if (arg === "--port") {
      options.port = Number(argv[++index]);
      options.portExplicit = true;
    }
    else if (arg === "--screenshot") options.screenshot = path.resolve(argv[++index]);
    else if (arg === "--app-path") options.appPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntilReachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForCodexRenderer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await codexTargets(port);
      if (targets.length > 0) return targets;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for the Codex renderer on 127.0.0.1:${port}`);
}

function startTaskboard({ detached }) {
  return spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    detached,
    stdio: detached ? "ignore" : "inherit",
  });
}

function createTaskboardSupervisor({ detached }) {
  let child = null;
  let ensureInFlight = null;
  let retryAfter = 0;
  let stopping = false;

  async function ensure({ force = false } = {}) {
    if (await isReachable(taskboardHealthUrl)) {
      return { status: "ok", restarted: false };
    }
    if (ensureInFlight) return ensureInFlight;
    if (!force && Date.now() < retryAfter) {
      throw new Error("Taskboard restart is waiting before its next attempt");
    }

    ensureInFlight = (async () => {
      if (child?.exitCode === null && !child.killed) {
        try {
          await waitUntilReachable(taskboardHealthUrl, 3_000);
          return { status: "ok", restarted: false };
        } catch (_) {}
      }

      const started = startTaskboard({ detached });
      child = started;
      if (detached) started.unref();
      started.once("error", (error) => {
        if (!stopping) console.error(`Taskboard process error: ${error.message}`);
      });
      started.once("exit", (code, signal) => {
        if (child === started) child = null;
        if (!stopping && !detached && code !== 0) {
          console.error(`Taskboard exited (${signal || code}); it will be restarted automatically.`);
        }
      });

      try {
        await waitUntilReachable(taskboardHealthUrl, 10_000);
        retryAfter = 0;
        return { status: "ok", restarted: true };
      } catch (error) {
        retryAfter = Date.now() + 2_000;
        throw error;
      }
    })();

    try {
      return await ensureInFlight;
    } finally {
      ensureInFlight = null;
    }
  }

  function stop() {
    stopping = true;
    if (child?.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  return { ensure, stop };
}

function codexIsRunning() {
  return spawnSync("/usr/bin/pgrep", ["-x", "ChatGPT"], { stdio: "ignore" }).status === 0;
}

function launchCodex(appPath, port) {
  const applicationName = path.basename(appPath, path.extname(appPath));
  return spawn(
    "/usr/bin/open",
    [
      "-n",
      "-W",
      "-a",
      applicationName,
      "--args",
      `--remote-debugging-port=${port}`,
      `--remote-allow-origins=http://127.0.0.1:${port}`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

async function restoreNormalCodex(appPath, codexProcess) {
  if (codexProcess?.exitCode === null && !codexProcess.killed) {
    codexProcess.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while (codexProcess.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const restored = spawn("/usr/bin/open", [appPath], {
    detached: true,
    stdio: "ignore",
  });
  restored.unref();
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.eventHandlers = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), {
        once: true,
      });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        const waiters = this.eventWaiters.get(message.method) || [];
        this.eventWaiters.delete(message.method);
        waiters.forEach((waiter) => waiter.resolve(message.params));
        const handlers = this.eventHandlers.get(message.method) || [];
        handlers.forEach((handler) => {
          try {
            Promise.resolve(handler(message.params)).catch((error) => {
              console.error(`CDP ${message.method} handler failed: ${error.message}`);
            });
          } catch (error) {
            console.error(`CDP ${message.method} handler failed: ${error.message}`);
          }
        });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("CDP WebSocket closed");
      this.pending.forEach((pending) => pending.reject(error));
      this.pending.clear();
      this.eventWaiters.forEach((waiters) => waiters.forEach((waiter) => waiter.reject(error)));
      this.eventWaiters.clear();
      this.eventHandlers.clear();
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) || [];
      const timeout = setTimeout(() => {
        this.eventWaiters.set(
          method,
          (this.eventWaiters.get(method) || []).filter((waiter) => waiter.resolve !== wrappedResolve),
        );
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const wrappedResolve = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      waiters.push({ resolve: wrappedResolve, reject });
      this.eventWaiters.set(method, waiters);
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      this.eventHandlers.set(
        method,
        (this.eventHandlers.get(method) || []).filter((candidate) => candidate !== handler),
      );
    };
  }

  close() {
    this.socket.close();
  }
}

async function codexTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  return targets.filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      target.url === "app://-/index.html",
  );
}

function codexDebuggingPorts(preferredPort) {
  const ports = new Set([preferredPort]);
  const processes = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) return [...ports];

  for (const command of processes.stdout.split("\n")) {
    if (!command.includes("/ChatGPT.app/") && !command.includes("/Codex.app/")) continue;
    const match = command.match(/--remote-debugging-port=(\d+)/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

function processCwd(pid) {
  const result = spawnSync("/usr/sbin/lsof", [
    "-a",
    "-p",
    String(pid),
    "-d",
    "cwd",
    "-Fn",
  ], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) return null;
  const cwd = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
  return cwd ? path.resolve(cwd) : null;
}

function residentInjectorPids(port) {
  const processes = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) return [];
  return findResidentInjectorPids({
    processList: processes.stdout,
    currentPid: process.pid,
    injectorPath,
    projectRoot,
    port,
    defaultPort: defaultCodexDebuggingPort,
    cwdForPid: processCwd,
  });
}

function startResidentInjector(
  port,
  shouldOpen,
  attachExisting = false,
  startupToken = null,
) {
  const [existingPid] = residentInjectorPids(port);
  if (existingPid) return { pid: existingPid, started: false };
  const args = [injectorPath, "--watch", "--port", String(port)];
  if (shouldOpen) args.push("--open");
  if (attachExisting) args.push("--attach-existing");
  if (startupToken) args.push("--startup-token", startupToken);
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid, started: true };
}

async function stopResidentInjector(pid) {
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  throw new Error(`Timed out stopping resident Taskboard injector ${pid}`);
}

async function waitForResidentInjectorReady(port, pid, startupToken, expectedSourceHash) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      const targets = await codexTargets(port);
      for (const target of targets) {
        const cdp = new CdpConnection(target.webSocketDebuggerUrl);
        await cdp.open();
        try {
          const readiness = await cdp.send("Runtime.evaluate", {
            expression: `({
              token: window[${JSON.stringify(hostStartupTokenName)}],
              taskboardEntryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
              sourceHash: window.__codexTaskboardInjection__?.sourceHash || null
            })`,
            returnByValue: true,
          });
          if (
            readiness.result.value?.token === startupToken
            && readiness.result.value.taskboardEntryMounted
            && readiness.result.value.sourceHash === expectedSourceHash
          ) return;
        } finally {
          cdp.close();
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for resident Taskboard injector ${pid}`);
}

async function restartResidentInjectorForRefresh(port) {
  const { sourceHash } = await currentInjectionSource();
  return restartResidentInjector(port, {
    findResidents: residentInjectorPids,
    stopResident: stopResidentInjector,
    createStartupToken: randomUUID,
    startResident: (targetPort, startupToken) => (
      startResidentInjector(targetPort, false, true, startupToken)
    ),
    waitUntilReady: (targetPort, pid, startupToken) => (
      waitForResidentInjectorReady(targetPort, pid, startupToken, sourceHash)
    ),
  });
}

async function refreshTaskboardFrames(port) {
  const targets = await codexTargets(port);
  const results = [];

  for (const target of targets) {
    const cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.open();
    try {
      await cdp.send("Runtime.enable");
      const evaluation = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          if (typeof taskboard?.reloadFrame === "function") {
            return { refreshed: taskboard.reloadFrame(), via: "injection" };
          }
          const frame = document.getElementById("codex-taskboard-frame");
          if (!frame) return { refreshed: false, via: "not-mounted" };
          const url = new URL(frame.getAttribute("src") || frame.src);
          url.searchParams.set("__codex_taskboard_refresh", Date.now().toString(36));
          frame.setAttribute("src", url.href);
          return { refreshed: true, via: "fallback", frameUrl: url.href };
        })()`,
        returnByValue: true,
      });
      if (evaluation.exceptionDetails) {
        throw new Error(
          evaluation.exceptionDetails.exception?.description || "Taskboard frame refresh failed",
        );
      }
      results.push({
        targetId: target.id,
        title: target.title,
        url: target.url,
        ...evaluation.result.value,
      });
    } finally {
      cdp.close();
    }
  }

  return results;
}

function frameTreeContains(frameTree, expectedUrl) {
  if (frameTree.frame?.url === expectedUrl) return true;
  return frameTree.childFrames?.some((child) => frameTreeContains(child, expectedUrl)) || false;
}

async function waitForFrame(cdp, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ targetInfos }, { frameTree }] = await Promise.all([
      cdp.send("Target.getTargets"),
      cdp.send("Page.getFrameTree"),
    ]);
    if (
      targetInfos.some((target) => target.type === "iframe" && target.url === expectedUrl) ||
      frameTreeContains(frameTree, expectedUrl)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function prefillTaskComposerViaCdp(cdp, executionContextId, request) {
  const {
    instruction,
    skillDisplayName,
    skillName,
    skillPath,
  } = request;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const prepared = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const instruction = ${JSON.stringify(instruction)};
        const skillName = ${JSON.stringify(skillName)};
        const skillPath = ${JSON.stringify(skillPath)};
        const editor = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        if (!editor) return { ready: false };
        const mention = Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((candidate) => (
            candidate.getAttribute("skill-mention-name") === skillName
            && candidate.getAttribute("skill-mention-path") === skillPath
          ));
        if (mention && (editor.textContent || "").includes(instruction)) {
          return { ready: true, matches: true };
        }
        editor.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return { ready: true, matches: false };
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (!prepared.result.value?.ready) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      continue;
    }
    if (prepared.result.value.matches) return { prefilled: true };

    await cdp.send("Input.insertText", { text: "$" });
    break;
  }

  let selectedSkill = false;
  while (Date.now() < deadline) {
    const selection = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const displayName = ${JSON.stringify(skillDisplayName)};
        const overlay = Array.from(document.querySelectorAll(
          '[data-composer-overlay-floating-ui="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        if (!overlay) return { ready: false };
        const button = Array.from(overlay.querySelectorAll(
          'button[data-list-navigation-item="true"]'
        )).find((candidate) => Array.from(candidate.querySelectorAll("span"))
          .some((label) => (label.textContent || "").trim() === displayName));
        if (!button) return { ready: true, found: false };
        button.click();
        return { ready: true, found: true };
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (selection.result.value?.found) {
      selectedSkill = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!selectedSkill) {
    throw new Error(`Timed out while selecting the ${skillDisplayName} Skill`);
  }

  let mentionReady = false;
  while (Date.now() < deadline) {
    const mention = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const skillName = ${JSON.stringify(skillName)};
        const skillPath = ${JSON.stringify(skillPath)};
        const editor = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        if (!editor) return { ready: false };
        const selected = Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((candidate) => candidate.getAttribute("skill-mention-name") === skillName);
        return {
          ready: Boolean(selected),
          pathMatches: selected?.getAttribute("skill-mention-path") === skillPath,
        };
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (mention.result.value?.ready) {
      if (!mention.result.value.pathMatches) {
        throw new Error(`Codex selected a different ${skillDisplayName} Skill`);
      }
      mentionReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!mentionReady) {
    throw new Error(`Timed out while creating the ${skillDisplayName} Skill mention`);
  }

  await cdp.send("Input.insertText", { text: instruction });
  while (Date.now() < deadline) {
    const verified = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const instruction = ${JSON.stringify(instruction)};
        const skillName = ${JSON.stringify(skillName)};
        const skillPath = ${JSON.stringify(skillPath)};
        const editor = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        const mention = editor && Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((candidate) => (
            candidate.getAttribute("skill-mention-name") === skillName
            && candidate.getAttribute("skill-mention-path") === skillPath
          ));
        return Boolean(mention && (editor.textContent || "").includes(instruction));
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (verified.result.value === true) return { prefilled: true };
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Timed out while writing the issue instruction into the Codex composer");
}

async function sendHostResponse(cdp, executionContextId, response) {
  await cdp.send("Runtime.evaluate", {
    expression: `window.__codexTaskboardInjection__?.hostResponse(${JSON.stringify(response)})`,
    contextId: executionContextId,
    returnByValue: true,
  });
}

async function installTaskboardHostBinding(cdp, supervisor) {
  cdp.on("Runtime.bindingCalled", async (params) => {
    if (params.name !== hostBindingName) return;
    await handleHostBindingPayload(params, {
      ensure: () => supervisor.ensure({ force: true }),
      prefill: (request, executionContextId) => (
        prefillTaskComposerViaCdp(cdp, executionContextId, request)
      ),
      sendResponse: (executionContextId, response) => (
        sendHostResponse(cdp, executionContextId, response)
      ),
    });
  });
  await cdp.send("Runtime.addBinding", { name: hostBindingName });
}

async function publishHostHeartbeat(cdp, startupToken) {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      window[${JSON.stringify(hostHeartbeatName)}] = Date.now();
      window[${JSON.stringify(hostStartupTokenName)}] = ${JSON.stringify(startupToken)};
    })()`,
    returnByValue: true,
  });
}

async function readInjectionStatus(cdp) {
  const status = await cdp.send("Runtime.evaluate", {
    expression: `({
      version: window.__codexTaskboardInjection__?.version || null,
      sourceHash: window.__codexTaskboardInjection__?.sourceHash || null,
      scriptIdentifier: window[${JSON.stringify(injectionScriptIdentifierName)}] || null,
      entryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
      pageMounted: Boolean(document.getElementById("codex-taskboard-page")),
      pageVisible: document.getElementById("codex-taskboard-page")?.hidden === false,
      frameUrl: document.getElementById("codex-taskboard-frame")?.src || null
    })`,
    returnByValue: true,
  });
  return status.result.value;
}

async function waitForCodexBootstrap(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readiness = await cdp.send("Runtime.evaluate", {
      expression: `({
        complete: document.readyState === "complete",
        shellMounted: Boolean(document.querySelector(
          "[data-app-shell-main-content-layout], [data-app-action-sidebar-scroll]"
        ))
      })`,
      returnByValue: true,
    });
    if (readiness.result.value?.complete && readiness.result.value?.shellMounted) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the native Codex shell to finish bootstrapping");
}

async function waitForInjectionStatus(cdp, shouldOpen, expectedSourceHash, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = await readInjectionStatus(cdp);
  while (
    Date.now() < deadline
    && (
      status.sourceHash !== expectedSourceHash
      || !status.entryMounted
      || (shouldOpen && (!status.pageVisible || !status.frameUrl))
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await readInjectionStatus(cdp);
  }
  return status;
}

async function evaluateInjectionSource(cdp, source) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description || "Taskboard injection failed",
    );
  }
}

async function publishInjectionScriptIdentifier(cdp, scriptIdentifier) {
  await cdp.send("Runtime.evaluate", {
    expression: `window[${JSON.stringify(injectionScriptIdentifierName)}] = ${JSON.stringify(scriptIdentifier)}`,
    returnByValue: true,
  });
}

async function registerInjectionSource(cdp, source) {
  const registration = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${source}\n//# sourceURL=codex-taskboard.user.js`,
  });
  return registration.identifier;
}

async function injectTarget(
  target,
  source,
  sourceHash,
  shouldOpen,
  screenshotPath,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
) {
  const cdp = new CdpConnection(target.webSocketDebuggerUrl);
  let retained = false;
  await cdp.open();
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.setBypassCSP", { enabled: true });
    await cdp.send("Runtime.enable");
    if (keepAlive) await installTaskboardHostBinding(cdp, supervisor);
    if (keepAlive && attachExisting) {
      const currentStatus = await readInjectionStatus(cdp);
      const requiresCspReload = !currentStatus.sourceHash;
      const reconciled = await reconcileInjectionRuntime({
        currentStatus,
        source,
        sourceHash,
        removeRegisteredSource: (identifier) => cdp.send(
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier },
        ),
        registerCurrentSource: (currentSource) => registerInjectionSource(cdp, currentSource),
        evaluateCurrentSource: (currentSource) => evaluateInjectionSource(cdp, currentSource),
        publishRegistration: (identifier) => publishInjectionScriptIdentifier(cdp, identifier),
        reopen: () => cdp.send("Runtime.evaluate", {
          expression: "window.__codexTaskboardInjection__?.open()",
          returnByValue: true,
        }),
      });
      cdp.on("Page.loadEventFired", () => (
        publishInjectionScriptIdentifier(cdp, reconciled.scriptIdentifier)
      ));
      if (requiresCspReload) {
        await waitForCodexBootstrap(cdp, 30_000);
        const reloaded = cdp.waitFor("Page.loadEventFired", 15_000);
        await cdp.send("Page.reload");
        await reloaded;
        await publishInjectionScriptIdentifier(cdp, reconciled.scriptIdentifier);
        if (reconciled.shouldRemainOpen) {
          await cdp.send("Runtime.evaluate", {
            expression: "window.__codexTaskboardInjection__?.open()",
            returnByValue: true,
          });
        }
      }
      await publishHostHeartbeat(cdp, startupToken);
      const status = await waitForInjectionStatus(
        cdp,
        reconciled.shouldRemainOpen,
        sourceHash,
        15_000,
      );
      const frameLoaded = status.frameUrl
        ? await waitForFrame(cdp, status.frameUrl, 15_000)
        : false;
      retained = true;
      return {
        result: { ...status, cspBypassed: true, frameLoaded },
        connection: cdp,
      };
    }
    const scriptIdentifier = await registerInjectionSource(cdp, source);
    cdp.on("Page.loadEventFired", () => (
      publishInjectionScriptIdentifier(cdp, scriptIdentifier)
    ));
    await waitForCodexBootstrap(cdp, 30_000);
    const reloaded = cdp.waitFor("Page.loadEventFired", 15_000);
    await cdp.send("Page.reload");
    await reloaded;
    await evaluateInjectionSource(cdp, source);
    await publishInjectionScriptIdentifier(cdp, scriptIdentifier);
    if (keepAlive) await publishHostHeartbeat(cdp, startupToken);
    if (shouldOpen) {
      await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          taskboard?.close();
          taskboard?.open();
        })()`,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const status = await waitForInjectionStatus(cdp, shouldOpen, sourceHash, 15_000);
    const frameLoaded = status.frameUrl
      ? await waitForFrame(cdp, status.frameUrl, 15_000)
      : false;
    const result = {
      ...status,
      cspBypassed: true,
      frameLoaded,
    };
    if (screenshotPath) {
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
      result.screenshot = screenshotPath;
    }
    retained = keepAlive;
    return { result, connection: retained ? cdp : null };
  } finally {
    if (!retained) cdp.close();
  }
}

async function injectAll(
  port,
  source,
  sourceHash,
  shouldOpen,
  screenshotPath,
  injectedTargets,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
) {
  const targets = await codexTargets(port);
  if (targets.length === 0) throw new Error("No Codex renderer target found");

  const activeIds = new Set(targets.map((target) => target.id));
  for (const [id, connection] of injectedTargets) {
    if (!activeIds.has(id) || connection.closed) {
      connection.close();
      injectedTargets.delete(id);
    }
  }

  const results = [];
  for (const target of targets) {
    if (injectedTargets.has(target.id)) continue;
    const firstTarget = injectedTargets.size === 0 && results.length === 0;
    const { result, connection } = await injectTarget(
      target,
      source,
      sourceHash,
      shouldOpen && firstTarget,
      firstTarget ? screenshotPath : null,
      keepAlive,
      supervisor,
      attachExisting,
      startupToken,
    );
    if (connection) injectedTargets.set(target.id, connection);
    results.push({ targetId: target.id, title: target.title, url: target.url, ...result });
  }
  return results;
}

async function currentInjectionSource() {
  const userScript = await readFile(injectionPath, "utf8");
  const runtimeSource = `window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ = ${JSON.stringify(taskboardOrigin)};
if (typeof window.__CODEX_TASKBOARD_URL__ !== "string" || !window.__CODEX_TASKBOARD_URL__.trim()) {
  window.__CODEX_TASKBOARD_URL__ = ${JSON.stringify(taskboardPageUrl)};
}
window.__CODEX_LIFE_HELPER_URL__ = ${JSON.stringify(lifeHelperUrl.href)};
${userScript}`;
  const sourceHash = createHash("sha256").update(runtimeSource).digest("hex");
  return {
    sourceHash,
    source: `window[${JSON.stringify(injectionSourceHashName)}] = ${JSON.stringify(sourceHash)};
${runtimeSource}`,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cdpVersionUrl = `http://127.0.0.1:${options.port}/json/version`;

  if (options.daemon) {
    let port = options.port;
    if (!options.portExplicit) {
      const candidates = codexDebuggingPorts(options.port);
      const activePort = await Promise.any(candidates.map(async (candidate) => {
        if (!(await isReachable(`http://127.0.0.1:${candidate}/json/version`))) {
          throw new Error("unreachable");
        }
        if ((await codexTargets(candidate)).length === 0) throw new Error("not Codex");
        return candidate;
      })).catch(() => null);
      if (!activePort) throw new Error("No debuggable Codex window found");
      port = activePort;
    }
    console.log(JSON.stringify({ launcher: startResidentInjector(port, options.open), port }, null, 2));
    return;
  }

  if (options.refresh || options.refreshIfRunning) {
    const ports = options.portExplicit
      ? [options.port]
      : codexDebuggingPorts(options.port);
    const refreshed = [];
    for (const port of ports) {
      if (!(await isReachable(`http://127.0.0.1:${port}/json/version`))) continue;
      if (options.refreshIfRunning) await restartResidentInjectorForRefresh(port);
      const results = await refreshTaskboardFrames(port);
      refreshed.push(...results.map((result) => ({ port, ...result })));
    }
    if (refreshed.length === 0) {
      if (options.refreshIfRunning) {
        console.log(JSON.stringify({ refreshed: [], skipped: "No debuggable Codex window is running" }));
        return;
      }
      throw new Error(`No debuggable Codex window found on ports: ${ports.join(", ")}`);
    }
    console.log(JSON.stringify({ refreshed }, null, 2));
    return;
  }

  let codexProcess = null;
  const supervisor = createTaskboardSupervisor({ detached: !options.watch });

  try {
    let cdpReachable = await isReachable(cdpVersionUrl);
    if (!cdpReachable && options.launch && codexIsRunning()) {
      console.error("Waiting for the normally launched Codex process to exit before relaunching with 工作台 support.");
      while (!cdpReachable && codexIsRunning()) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        cdpReachable = await isReachable(cdpVersionUrl);
      }
    }
    if (!cdpReachable) {
      if (!options.launch) {
        throw new Error(`Codex CDP is not listening on 127.0.0.1:${options.port}`);
      }
    }

    await supervisor.ensure({ force: true });

    if (!cdpReachable) {
      codexProcess = launchCodex(options.appPath, options.port);
      try {
        await waitUntilReachable(cdpVersionUrl, 30_000);
      } catch (error) {
        console.error("工作台 launch failed; restoring a normal Codex window.");
        await restoreNormalCodex(options.appPath, codexProcess);
        throw error;
      }
    }
    await waitForCodexRenderer(options.port, 30_000);

    const { source, sourceHash } = await currentInjectionSource();
    const injectedTargets = new Map();
    const firstResults = await injectAll(
      options.port,
      source,
      sourceHash,
      options.open,
      options.screenshot,
      injectedTargets,
      options.watch,
      supervisor,
      options.attachExisting,
      options.startupToken,
    );
    console.log(JSON.stringify({ injected: firstResults }, null, 2));

    if (!options.watch) {
      codexProcess?.unref();
      return;
    }

    const stop = () => {
      injectedTargets.forEach((connection) => connection.close());
      supervisor.stop();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, hostHeartbeatIntervalMs));
      try {
        await supervisor.ensure();
      } catch (error) {
        console.error(`Waiting for 工作台 service: ${error.message}`);
      }
      await pruneStaleHostConnections(
        injectedTargets,
        (connection) => publishHostHeartbeat(connection, options.startupToken),
        hostHeartbeatTimeoutMs,
      );
      try {
        const results = await injectAll(
          options.port,
          source,
          sourceHash,
          false,
          null,
          injectedTargets,
          true,
          supervisor,
          options.attachExisting,
          options.startupToken,
        );
        if (results.length > 0) console.log(JSON.stringify({ injected: results }, null, 2));
      } catch (error) {
        if (codexProcess && codexProcess.exitCode !== null) break;
        if (options.launch && !(await isReachable(cdpVersionUrl))) break;
        console.error(`Waiting for Codex renderer: ${error.message}`);
      }
    }
    supervisor.stop();
  } catch (error) {
    supervisor.stop();
    throw error;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
