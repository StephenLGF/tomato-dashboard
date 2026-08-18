import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { AiChatService } from "../server/ai-chat.mjs";
import { readCodexThreadModel } from "../server/ai-chat-catalog.mjs";
import { normalizeCodexEvent } from "../server/ai-chat-process.mjs";

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

test("normalized item events retain a bounded public item id", () => {
  const itemId = "x".repeat(70_000);
  const normalized = normalizeCodexEvent({
    type: "item.updated",
    item: {
      id: itemId,
      type: "command_execution",
      command: "npm test",
      status: "in_progress",
    },
  });

  assert.equal(normalized.data.itemId, itemId.slice(0, 65_536));
});

test("resumed conversations use the model recorded by the native Codex session", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    fixture.database.updateAiChatThread(thread.id, {
      reasoningEffort: "ultra",
      codexThreadId: "legacy-codex-thread",
    });
    fixture.setCodexThreadModel("legacy-codex-thread", "gpt-real");

    const run = await fixture.service.startTurn(thread.id, {
      message: "migrate legacy model",
      dangerFullAccessConfirmed: true,
    });
    await waitFor(() => fixture.service.getRun(run.id)?.status !== "running");

    const capture = JSON.parse((await readFile(fixture.capturePath, "utf8")).trim());
    assert.equal(capture.args.includes("resume"), true);
    assert.deepEqual(capture.args.slice(capture.args.indexOf("-m"), capture.args.indexOf("-m") + 2), [
      "-m",
      "gpt-real",
    ]);
    assert.equal(fixture.service.getThread(thread.id).codexThreadId, "legacy-codex-thread");
  } finally {
    await fixture.close();
  }
});

test("native Codex session model is read from the latest recorded turn without local persistence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-codex-session-"));
  try {
    const sessionsPath = path.join(directory, "sessions", "2026", "08", "11");
    await mkdir(sessionsPath, { recursive: true });
    await writeFile(path.join(directory, "codex-state.json"), "{}");
    await writeFile(
      path.join(sessionsPath, "rollout-2026-08-11T00-00-00-native-thread.jsonl"),
      [
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna" } }),
        "{malformed",
        JSON.stringify({ type: "event_msg", payload: { thread_settings: { model: "gpt-5.6-sol" } } }),
      ].join("\n"),
    );
    assert.equal(
      await readCodexThreadModel(path.join(directory, "codex-state.json"), "native-thread"),
      "gpt-5.6-sol",
    );
    assert.equal(
      await readCodexThreadModel(path.join(directory, "codex-state.json"), "../unsafe"),
      null,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-runner-"));
  const workspacePath = path.join(directory, "workspace");
  const otherWorkspacePath = path.join(directory, "other-workspace");
  await Promise.all([mkdir(workspacePath), mkdir(otherWorkspacePath)]);
  const [workspace, otherWorkspace] = await Promise.all([
    realpath(workspacePath),
    realpath(otherWorkspacePath),
  ]);
  const capturePath = path.join(directory, "capture.jsonl");
  const descendantPath = path.join(directory, "descendant-alive");
  const executable = path.join(directory, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "debug" && args[1] === "models") {
  if (args.length !== 2) process.exit(2);
  process.stdout.write(JSON.stringify({models:[{
    slug:"gpt-real", display_name:"GPT Real", description:"Real fixture",
    default_reasoning_level:"medium",
    supported_reasoning_levels:[{effort:"low"},{effort:"medium"},{effort:"high"}],
    service_tiers:[{id:"priority",name:"Fast",description:"fixture"}]
  }]}));
  process.exit(0);
}
if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{"platformFamily":"unix"}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[{"name":"real-skill","enabled":true,"scope":"repo","interface":{"displayName":"Real Skill"}},{"name":"disabled","enabled":false,"scope":"user"}]}]}}\\n');
    }
  });
} else if (args[0] === "exec") {
  process.stdin.setEncoding("utf8");
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({args,prompt}) + "\\n");
    const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    if (!args.includes("resume")) emit({type:"thread.started",thread_id:"codex-thread-1"});
    emit({type:"turn.started"});
    if (prompt.includes("MALFORMED_STUBBORN") || prompt.includes("CALLBACK_FATAL_STUBBORN")) {
      spawn(process.execPath, [
        "-e",
        'process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(process.env.FAKE_DESCENDANT_PATH, "alive"), 300); setInterval(() => {}, 1000)',
      ], {env:process.env,stdio:"ignore"});
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      if (prompt.includes("CALLBACK_FATAL_STUBBORN")) {
        emit({type:"thread.started",thread_id:"unexpected-thread"});
      } else {
        process.stdout.write("{not-json}\\n");
      }
      return;
    }
    if (prompt.includes("MALFORMED")) {
      process.stdout.write("{not-json}\\n");
      return;
    }
    emit({type:"item.completed",item:{type:"reasoning",text:"SECRET REASONING"}});
    emit({type:"item.completed",item:{type:"agent_message",text:"Visible answer"}});
    emit({type:"item.completed",item:{type:"command_execution",command:"npm test",status:"completed",exit_code:0,aggregated_output:"ok"}});
    if (prompt.includes("TURN_FAILED_ZERO")) {
      emit({type:"turn.failed",error:{message:"Protocol turn failed"}});
      return;
    }
    if (prompt.includes("ROOT_ERROR_ZERO")) {
      emit({type:"error",message:"Protocol root error"});
      return;
    }
    if (prompt.includes("NO_TERMINAL")) return;
    if (prompt.includes("ITEM_ERROR")) {
      emit({type:"item.completed",item:{id:"item-error-1",type:"error",message:"Recoverable item error"}});
    }
    if (prompt.includes("WAIT")) {
      const timer = setTimeout(() => { emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}); }, 800);
      process.on("SIGTERM", () => { clearTimeout(timer); process.exit(143); });
      return;
    }
    if (prompt.includes("FAIL")) process.exit(7);
    emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}});
  });
}
`);
  await chmod(executable, 0o755);

  const codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": {
      project: { rootPaths: [workspace] },
      other: { rootPaths: [otherWorkspace] },
    },
  }));
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "project", name: "Project", workspacePath: null });
  database.createProject({ id: "other", name: "Other", workspacePath: null });
  let gitBranch = "main";
  const nativeThreadNames = [];
  const codexThreadModels = new Map();
  const service = new AiChatService({
    database,
    codexExecutable: executable,
    codexStatePath,
    tomatoWorkboardSkillPath: "/fixture/tomato-workboard/SKILL.md",
    processEnv: {
      ...process.env,
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_DESCENDANT_PATH: descendantPath,
    },
    killGraceMs: 50,
    readGitBranch: async () => gitBranch,
    readCodexThreadModel: async (_codexStatePath, threadId) => (
      codexThreadModels.get(threadId) ?? null
    ),
    setCodexThreadName: async (input) => {
      nativeThreadNames.push(input);
    },
  });
  return {
    capturePath,
    database,
    databasePath,
    descendantPath,
    directory,
    nativeThreadNames,
    otherWorkspace,
    service,
    setGitBranch(branch) {
      gitBranch = branch;
    },
    setCodexThreadModel(threadId, model) {
      codexThreadModels.set(threadId, model);
    },
    workspace,
    async close() {
      await this.service.close();
      this.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Codex turns use stdin, explicit resume ids, server-owned cwd and sanitized visible events", async () => {
  const fixture = await createFixture();
  try {
    const catalog = await fixture.service.getCatalog("project");
    assert.deepEqual(catalog.models, [{
      slug: "gpt-real",
      displayName: "GPT Real",
      description: "Real fixture",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"],
      serviceTiers: [{ id: "priority", name: "Fast" }],
    }]);
    assert.deepEqual(catalog.skills, [{ id: "real-skill", label: "Real Skill", scope: "repo" }]);

    const thread = await fixture.service.createThread({
      projectId: "project",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    assert.equal(thread.origin.workspacePath, fixture.workspace);

    const first = await fixture.service.startTurn(thread.id, {
      message: "HIDDEN_SENTINEL first",
      skillIds: ["real-skill"],
    });
    await waitFor(() => fixture.service.getRun(first.id)?.status !== "running");
    const second = await fixture.service.startTurn(thread.id, { message: "second" });
    await waitFor(() => fixture.service.getRun(second.id)?.status !== "running");

    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(captures[0].args, [
      "exec", "--json", "--color", "never",
      "-C", fixture.workspace,
      "-s", "workspace-write",
      "--add-dir", fixture.otherWorkspace,
      "-m", "gpt-real",
      "-c", 'model_reasoning_effort="high"',
      "-",
    ]);
    assert.equal(captures[0].args.join(" ").includes("HIDDEN_SENTINEL"), false);
    assert.equal(captures[1].args.includes("-m"), false);
    assert.equal(captures[0].prompt.includes("tomato-workboard"), false);
    assert.match(captures[0].prompt, /\$real-skill/);
    assert.match(captures[0].prompt, /HIDDEN_SENTINEL first/);
    assert.deepEqual(captures[1].args, [
      "exec", "--json", "--color", "never",
      "-C", fixture.workspace,
      "-s", "workspace-write",
      "--add-dir", fixture.otherWorkspace,
      "-m", "gpt-real",
      "-c", 'model_reasoning_effort="high"',
      "resume", "codex-thread-1", "-",
    ]);
    assert.equal(captures[1].args.includes("--last"), false);

    const snapshot = fixture.service.getThreadSnapshot(thread.id);
    assert.equal(snapshot.thread.codexThreadId, "codex-thread-1");
    assert.equal(snapshot.events.some((event) => event.content?.includes("SECRET REASONING")), false);
    assert.equal(snapshot.events.some((event) => event.content === "Visible answer"), true);
    assert.equal(snapshot.events.some((event) => event.type === "command_execution"), true);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("HIDDEN_SENTINEL"), true);
    assert.equal(serialized.includes("<taskboard_context>"), false);
    const persisted = JSON.stringify(
      fixture.database.database.prepare("SELECT * FROM ai_chat_events").all(),
    );
    assert.equal(persisted.includes("<taskboard_context>"), false);
    assert.equal(persisted.includes("SECRET REASONING"), false);
  } finally {
    await fixture.close();
  }
});

test("AI conversations persist the working branch and refresh it after a turn changes branches", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    assert.equal(thread.gitBranch, "main");

    const run = await fixture.service.startTurn(thread.id, { message: "WAIT switch branch" });
    fixture.setGitBranch("feat/proxima-55150");
    await waitFor(() => fixture.service.getRun(run.id)?.status !== "running");

    assert.equal(fixture.service.getThread(thread.id).gitBranch, "feat/proxima-55150");
  } finally {
    await fixture.close();
  }
});

test("Tomato conversations use the real item key instead of the local task identifier", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createProject({
      id: "tomato",
      name: "番茄工作台",
      workspacePath: fixture.workspace,
    });
    fixture.database.syncTomatoItems([{
      itemKey: "proxima-55150",
      title: "真实番茄卡片",
      status: "修复中",
      itemType: "测试缺陷",
      workspace: "Gitee-Team",
      priority: "P1",
    }]);
    const task = fixture.database.listTasks("tomato")[0];
    const thread = await fixture.service.createThread({
      projectId: "tomato",
      issueId: task.id,
    });
    assert.equal(task.identifier, "TOMATO-1");
    assert.equal(thread.id, "tomato:proxima-55150");
    assert.equal(thread.title, "proxima-55150 真实番茄卡片");
    assert.equal(thread.origin.issueIdentifier, "proxima-55150");
    assert.equal(thread.origin.issueId, task.id);
    const sameThread = await fixture.service.createThread({
      projectId: "tomato",
      issueId: task.id,
    });
    assert.equal(sameThread.id, thread.id);
    assert.equal(fixture.service.listThreads({ issueIdentifier: "proxima-55150" }).length, 1);
    fixture.database.updateAiChatThread(thread.id, {
      codexThreadId: "codex-thread-tomato",
      title: "proxima-55150",
    });
    assert.equal(
      await fixture.service.syncNativeThreadName("codex-thread-tomato"),
      "proxima-55150 真实番茄卡片",
    );
    assert.equal(fixture.service.getThread(thread.id).title, "proxima-55150 真实番茄卡片");
    assert.deepEqual(fixture.nativeThreadNames.at(-1), {
      codexExecutable: fixture.service.codexExecutable,
      workspacePath: fixture.workspace,
      processEnv: fixture.service.processEnv,
      threadId: "codex-thread-tomato",
      name: "proxima-55150 真实番茄卡片",
    });
  } finally {
    await fixture.close();
  }
});

test("same-thread turns are locked, different threads run concurrently, failures and interrupts settle", async () => {
  const fixture = await createFixture();
  try {
    const firstThread = await fixture.service.createThread({ projectId: "project" });
    const secondThread = await fixture.service.createThread({ projectId: "other" });
    const waiting = await fixture.service.startTurn(firstThread.id, { message: "WAIT" });
    await assert.rejects(
      fixture.service.startTurn(firstThread.id, { message: "must reject" }),
      (error) => error.code === "THREAD_BUSY",
    );
    const parallel = await fixture.service.startTurn(secondThread.id, { message: "normal" });
    await waitFor(() => fixture.service.getRun(parallel.id)?.status === "completed");
    const interrupted = await fixture.service.interrupt(waiting.id);
    assert.equal(interrupted.id, waiting.id);
    await waitFor(() => fixture.service.getRun(waiting.id)?.status === "interrupted");

    const failed = await fixture.service.startTurn(firstThread.id, { message: "FAIL" });
    await waitFor(() => fixture.service.getRun(failed.id)?.status === "failed");
    assert.equal(fixture.service.getRun(failed.id).exitCode, 7);
    assert.equal(
      fixture.service.getThreadSnapshot(firstThread.id).events.some(
        (event) => event.role === "error" && event.content.includes("code 7"),
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("malformed Codex JSONL fails the run", async () => {
  const fixture = await createFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "project" });
    const run = await fixture.service.startTurn(thread.id, { message: "MALFORMED" });
    await waitFor(() => fixture.service.getRun(run.id)?.status === "failed");

    const failed = fixture.service.getRun(run.id);
    assert.equal(failed.error, "Codex emitted malformed JSONL");
    assert.equal(
      fixture.service.getThreadSnapshot(thread.id).events.some(
        (event) => event.role === "error"
          && event.content === "Codex emitted malformed JSONL",
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("parser and event callback failures kill a SIGTERM-resistant process group", async () => {
  const fixture = await createFixture();
  try {
    for (const [message, expectedError] of [
      ["MALFORMED_STUBBORN", "Codex emitted malformed JSONL"],
      ["CALLBACK_FATAL_STUBBORN", "Codex returned an unexpected thread id"],
    ]) {
      await rm(fixture.descendantPath, { force: true });
      const thread = await fixture.service.createThread({ projectId: "project" });
      const run = await fixture.service.startTurn(thread.id, { message });
      await waitFor(() => fixture.service.getRun(run.id).status === "failed", 700);
      assert.equal(fixture.service.getRun(run.id).error, expectedError);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await assert.rejects(readFile(fixture.descendantPath), (error) => error.code === "ENOENT");
    }
  } finally {
    await fixture.close();
  }
});

test("protocol terminal events determine run success and item errors remain non-fatal", async () => {
  const fixture = await createFixture();
  try {
    for (const [message, expectedStatus] of [
      ["TURN_FAILED_ZERO", "failed"],
      ["ROOT_ERROR_ZERO", "failed"],
      ["NO_TERMINAL", "failed"],
      ["ITEM_ERROR", "completed"],
    ]) {
      const thread = await fixture.service.createThread({ projectId: "project" });
      const run = await fixture.service.startTurn(thread.id, { message });
      await waitFor(() => fixture.service.getRun(run.id).status !== "running");
      assert.equal(fixture.service.getRun(run.id).status, expectedStatus, message);
    }
  } finally {
    await fixture.close();
  }
});

test("startTurn revalidates the latest danger sandbox and reasoning settings", async () => {
  const fixture = await createFixture();
  try {
    for (const scenario of [
      {
        changes: { sandbox: "danger-full-access" },
        expectedCode: "DANGER_CONFIRMATION_REQUIRED",
      },
      {
        changes: { reasoningEffort: "ultra" },
        expectedCode: "INVALID_REASONING_EFFORT",
      },
    ]) {
      const thread = await fixture.service.createThread({ projectId: "project" });
      const originalGetCatalog = fixture.service.getCatalog.bind(fixture.service);
      let releaseCatalog;
      let catalogRequested = false;
      const catalogGate = new Promise((resolve) => {
        releaseCatalog = resolve;
      });
      fixture.service.getCatalog = async (...args) => {
        catalogRequested = true;
        await catalogGate;
        return originalGetCatalog(...args);
      };

      const pending = fixture.service.startTurn(thread.id, { message: "must not spawn" });
      await waitFor(() => catalogRequested);
      fixture.database.updateAiChatThread(thread.id, scenario.changes);
      releaseCatalog();
      await assert.rejects(pending, (error) => error.code === scenario.expectedCode);
      assert.equal(fixture.database.listAiChatRuns(thread.id).length, 0);
      fixture.service.getCatalog = originalGetCatalog;
    }
  } finally {
    await fixture.close();
  }
});

test("startup marks abandoned runs interrupted while preserving the Codex thread id", async () => {
  const fixture = await createFixture();
  const thread = await fixture.service.createThread({ projectId: "project" });
  fixture.database.database.prepare(
    "UPDATE ai_chat_threads SET codex_thread_id = ?, status = 'running' WHERE id = ?",
  ).run("preserved-session", thread.id);
  fixture.database.database.prepare(`
    INSERT INTO ai_chat_runs (
      id, thread_id, status, exit_code, error, started_at, finished_at
    ) VALUES ('abandoned', ?, 'running', NULL, NULL, ?, NULL)
  `).run(thread.id, new Date().toISOString());
  await fixture.service.close();
  fixture.database.close();
  fixture.database = new TaskboardDatabase(fixture.databasePath);
  const restarted = new AiChatService({
    database: fixture.database,
    codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
    codexStatePath: path.join(fixture.directory, "codex-state.json"),
    tomatoWorkboardSkillPath: "/fixture/tomato-workboard/SKILL.md",
  });
  fixture.service = restarted;
  try {
    assert.equal(restarted.getRun("abandoned").status, "interrupted");
    assert.equal(restarted.getThread(thread.id).codexThreadId, "preserved-session");
  } finally {
    await fixture.close();
  }
});
