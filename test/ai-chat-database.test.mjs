import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-database-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  return {
    database,
    directory,
    filename,
    async close() {
      this.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("AI chat persistence stores threads, runs, and visible events without hidden prompt fields", async () => {
  const fixture = await createFixture();
  try {
    const thread = fixture.database.createAiChatThread({
      id: "thread-1",
      title: "New conversation",
      status: "idle",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
        issueId: "task-1",
        issueIdentifier: "LOCAL-1",
      },
      codexThreadId: null,
      gitBranch: "feat/card-branch",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    assert.equal(thread.origin.issueIdentifier, "LOCAL-1");
    assert.equal(thread.gitBranch, "feat/card-branch");
    assert.equal(thread.currentRun, null);

    const run = fixture.database.createAiChatRun({
      id: "run-1",
      threadId: thread.id,
      status: "running",
    });
    fixture.database.insertAiChatEvent({
      id: "event-1",
      threadId: thread.id,
      runId: run.id,
      type: "agent_message",
      role: "assistant",
      content: "Visible answer",
      data: { status: "completed" },
    });
    fixture.database.updateAiChatThread(thread.id, {
      status: "running",
      codexThreadId: "codex-thread-1",
      gitBranch: "feat/card-branch-v2",
    });

    assert.equal(fixture.database.getAiChatThread(thread.id).currentRun.id, run.id);
    assert.equal(fixture.database.listAiChatThreads()[0].codexThreadId, "codex-thread-1");
    assert.equal(fixture.database.listAiChatThreads()[0].gitBranch, "feat/card-branch-v2");
    assert.deepEqual(fixture.database.listAiChatEvents(thread.id).map((event) => event.content), [
      "Visible answer",
    ]);
    assert.equal(fixture.database.listAiChatRuns(thread.id)[0].status, "running");

    for (const table of ["ai_chat_threads", "ai_chat_runs", "ai_chat_events"]) {
      const columns = fixture.database.database.prepare(`PRAGMA table_info(${table})`).all();
      assert.equal(
        columns.some((column) => /prompt|raw/i.test(column.name)),
        false,
        `${table} must not persist hidden prompts or raw Codex JSONL`,
      );
      if (table === "ai_chat_threads") {
        assert.equal(columns.some((column) => column.name === "model"), false);
      }
    }
  } finally {
    await fixture.close();
  }
});

test("opening the database interrupts abandoned runs and preserves resumable Codex thread ids", async () => {
  const fixture = await createFixture();
  fixture.database.createAiChatThread({
    id: "thread-1",
    title: "New conversation",
    status: "running",
    origin: {
      projectId: "local",
      projectName: "Local",
      workspacePath: "/tmp/project",
    },
    codexThreadId: "codex-thread-1",
    reasoningEffort: "medium",
    sandbox: "read-only",
  });
  fixture.database.createAiChatRun({
    id: "run-1",
    threadId: "thread-1",
    status: "running",
  });
  fixture.database.close();

  const reopened = new TaskboardDatabase(fixture.filename);
  fixture.database = reopened;
  try {
    assert.equal(reopened.getAiChatRun("run-1").status, "interrupted");
    assert.equal(reopened.getAiChatRun("run-1").finishedAt === null, false);
    assert.equal(reopened.getAiChatThread("thread-1").codexThreadId, "codex-thread-1");
    assert.equal(reopened.getAiChatThread("thread-1").status, "idle");
    assert.equal(reopened.getAiChatThread("thread-1").currentRun, null);
  } finally {
    await fixture.close();
  }
});

test("deleting an AI chat thread removes its runs and visible events", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createAiChatThread({
      id: "thread-1",
      title: "New conversation",
      status: "idle",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
      },
      codexThreadId: null,
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    fixture.database.createAiChatRun({
      id: "run-1",
      threadId: "thread-1",
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    fixture.database.insertAiChatEvent({
      id: "event-1",
      threadId: "thread-1",
      runId: "run-1",
      type: "agent_message",
      role: "assistant",
      content: "Visible answer",
    });

    fixture.database.deleteAiChatThread("thread-1");

    assert.equal(fixture.database.getAiChatThread("thread-1"), null);
    assert.equal(fixture.database.getAiChatRun("run-1"), null);
    assert.equal(
      fixture.database.database.prepare("SELECT COUNT(*) AS count FROM ai_chat_events").get().count,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("AI chat events with the same timestamp retain SQLite insertion order", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createAiChatThread({
      id: "thread-1",
      title: "New conversation",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
      },
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    const createdAt = "2026-07-27T12:00:00.000Z";
    fixture.database.insertAiChatEvent({
      id: "z-first",
      threadId: "thread-1",
      type: "agent_message",
      role: "assistant",
      content: "first",
      createdAt,
    });
    fixture.database.insertAiChatEvent({
      id: "a-second",
      threadId: "thread-1",
      type: "agent_message",
      role: "assistant",
      content: "second",
      createdAt,
    });

    assert.deepEqual(
      fixture.database.listAiChatEvents("thread-1").map((event) => event.id),
      ["z-first", "a-second"],
    );
  } finally {
    await fixture.close();
  }
});

test("Tomato chat migration replaces local identifiers and issue filtering stays scoped", async () => {
  const fixture = await createFixture();
  fixture.database.createProject({ id: "tomato", name: "番茄工作台", workspacePath: "/tmp/project" });
  fixture.database.syncTomatoItems([{
    itemKey: "proxima-55150",
    title: "真实番茄卡片",
    status: "修复中",
    itemType: "测试缺陷",
    workspace: "Gitee-Team",
    priority: "P1",
  }]);
  const task = fixture.database.listTasks("tomato")[0];
  fixture.database.createAiChatThread({
    id: "tomato-thread",
    title: task.identifier,
    origin: {
      projectId: "tomato",
      projectName: "番茄工作台",
      workspacePath: "/tmp/project",
      issueId: task.id,
      issueIdentifier: task.identifier,
    },
    reasoningEffort: "medium",
    sandbox: "workspace-write",
  });
  fixture.database.createAiChatThread({
    id: "other-thread",
    title: "Other",
    origin: {
      projectId: "local",
      projectName: "Local",
      workspacePath: "/tmp/project",
    },
    reasoningEffort: "medium",
    sandbox: "workspace-write",
  });
  fixture.database.close();
  fixture.database = new TaskboardDatabase(fixture.filename);
  try {
    const migrated = fixture.database.getAiChatThread("tomato-thread");
    assert.equal(migrated.title, "proxima-55150");
    assert.equal(migrated.origin.issueIdentifier, "proxima-55150");
    assert.deepEqual(
      fixture.database.listAiChatThreads({ issueIdentifier: "proxima-55150" }).map((thread) => thread.id),
      ["tomato-thread"],
    );
    assert.deepEqual(
      fixture.database.listAiChatThreads({ projectId: "tomato" }).map((thread) => thread.id),
      ["tomato-thread"],
    );
  } finally {
    await fixture.close();
  }
});

test("opening a legacy database removes the locally persisted conversation model", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-model-migration-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE ai_chat_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      origin_project_id TEXT NOT NULL,
      origin_project_name TEXT NOT NULL,
      origin_workspace_path TEXT NOT NULL,
      origin_issue_id TEXT,
      origin_issue_identifier TEXT,
      codex_thread_id TEXT,
      model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL,
      sandbox TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO ai_chat_threads (
      id, title, status,
      origin_project_id, origin_project_name, origin_workspace_path,
      codex_thread_id, model, reasoning_effort, sandbox,
      created_at, updated_at
    ) VALUES (
      'legacy-thread', 'Legacy', 'idle',
      'project', 'Project', '/tmp/project',
      'native-thread', 'gpt-5.6-sol', 'low', 'workspace-write',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const database = new TaskboardDatabase(filename);
  try {
    const columns = database.database.prepare("PRAGMA table_info(ai_chat_threads)").all();
    assert.equal(columns.some((column) => column.name === "model"), false);
    assert.deepEqual(database.getAiChatThread("legacy-thread"), {
      id: "legacy-thread",
      title: "Legacy",
      status: "idle",
      origin: {
        projectId: "project",
        projectName: "Project",
        workspacePath: "/tmp/project",
      },
      codexThreadId: "native-thread",
      gitBranch: null,
      reasoningEffort: "low",
      sandbox: "workspace-write",
      currentRun: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
