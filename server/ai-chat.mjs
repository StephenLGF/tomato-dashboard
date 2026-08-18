import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ApiError, tomatoItemKey } from "./database.mjs";
import {
  discoverAiCatalog,
  readCodexThreadMessages,
  readCodexThreadModel,
  resolveAiWorkspace,
  setCodexThreadName,
} from "./ai-chat-catalog.mjs";
import {
  buildCodexArgs,
  buildCodexPrompt,
  normalizeCodexEvent,
  spawnCodexAppServerTurn,
  spawnCodexTurn,
} from "./ai-chat-process.mjs";

const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const DEFAULT_AI_MODEL = "gpt-5.6-luna";
const ERROR_CONTENT_LIMIT = 65_536;
const CODEX_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const execFileAsync = promisify(execFile);

async function readGitBranch(workspacePath) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspacePath, "branch", "--show-current"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function cappedError(value) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return message.slice(0, ERROR_CONTENT_LIMIT);
}

function conversationTitle(issue, issueIdentifier) {
  if (issue?.projectId !== "tomato" || !issueIdentifier) {
    return issueIdentifier ?? "New conversation";
  }
  const title = issue.title.replace(/^\[[^\]]+\]\s*/u, "").trim();
  return `${issueIdentifier} ${title}`.trim();
}

function signalProcessGroup(child, signal) {
  if (Number.isInteger(child?.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child?.kill(signal);
  } catch {}
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export class AiChatService {
  constructor(options) {
    this.database = options.database;
    this.codexExecutable = options.codexExecutable;
    this.codexStatePath = options.codexStatePath;
    this.fallbackWorkspacePath = options.fallbackWorkspacePath ?? null;
    this.tomatoWorkboardSkillPath = options.tomatoWorkboardSkillPath;
    this.processEnv = options.processEnv ?? process.env;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.readGitBranch = options.readGitBranch ?? readGitBranch;
    this.readCodexThreadModel = options.readCodexThreadModel ?? readCodexThreadModel;
    this.readCodexThreadMessages = options.readCodexThreadMessages ?? readCodexThreadMessages;
    this.setCodexThreadName = options.setCodexThreadName ?? setCodexThreadName;
    this.active = new Map();
    this.listeners = new Map();
    this.completions = new Map();
  }

  listThreads(filter) {
    return this.database.listAiChatThreads(filter);
  }

  getThread(threadId) {
    const thread = this.database.getAiChatThread(threadId);
    if (!thread) {
      throw new ApiError(
        404,
        "AI_CHAT_THREAD_NOT_FOUND",
        `AI chat thread '${threadId}' does not exist`,
      );
    }
    return thread;
  }

  async syncNativeThreadName(codexThreadId) {
    let thread = this.database.listAiChatThreads()
      .find((candidate) => candidate.codexThreadId === codexThreadId);
    if (!thread) return null;
    thread = await this.#syncTomatoThreadName(thread);
    if (thread) await this.#setNativeThreadName(thread);
    return thread.title;
  }

  async repairTomatoThreadNames() {
    const tasks = this.database.listTasks({ projectId: "tomato" });
    const tasksByKey = new Map(
      tasks.flatMap((task) => {
        const key = tomatoItemKey(task.description);
        return key ? [[key, task]] : [];
      }),
    );
    const threads = this.database.listAiChatThreads({ projectId: "tomato" });
    let updated = 0;
    let nativeUpdated = 0;
    for (const thread of threads) {
      const task = thread.origin.issueId
        ? this.database.getTask(thread.origin.issueId)
        : tasksByKey.get(thread.origin.issueIdentifier);
      const repaired = await this.#syncTomatoThreadName(thread, task);
      if (!repaired) continue;
      if (repaired.title !== thread.title || repaired.origin.issueIdentifier !== thread.origin.issueIdentifier) {
        updated += 1;
      }
      if (repaired.codexThreadId) {
        try {
          await this.#setNativeThreadName(repaired);
          nativeUpdated += 1;
        } catch {
          // A stale or unavailable native thread should not block other repairs.
        }
      }
    }
    return { total: threads.length, updated, nativeUpdated };
  }

  async #syncTomatoThreadName(thread, task = null) {
    const issue = task ?? (
      thread.origin.issueId ? this.database.getTask(thread.origin.issueId) : null
    );
    if (issue?.projectId !== "tomato" && thread.origin.projectId !== "tomato") return thread;
    const itemKey = tomatoItemKey(issue?.description) || thread.origin.issueIdentifier;
    if (!itemKey) return thread;
    const title = issue ? conversationTitle(issue, itemKey) : thread.title;
    const changes = {};
    if (title !== thread.title) changes.title = title;
    if (thread.origin.issueIdentifier !== itemKey) changes.originIssueIdentifier = itemKey;
    return Object.keys(changes).length > 0
      ? this.database.updateAiChatThread(thread.id, changes)
      : thread;
  }

  async #setNativeThreadName(thread) {
    await this.setCodexThreadName({
      codexExecutable: this.codexExecutable,
      workspacePath: thread.origin.workspacePath,
      processEnv: this.processEnv,
      threadId: thread.codexThreadId,
      name: thread.title,
    });
  }

  getThreadSnapshot(threadId) {
    const thread = this.getThread(threadId);
    return {
      thread,
      events: this.database.listAiChatEvents(threadId),
      runs: this.database.listAiChatRuns(threadId),
    };
  }

  async syncNativeThread(threadId) {
    const thread = this.getThread(threadId);
    if (!thread.codexThreadId) return 0;
    const [nativeMessages, existingEvents] = await Promise.all([
      this.readCodexThreadMessages(this.codexStatePath, thread.codexThreadId),
      Promise.resolve(this.database.listAiChatEvents(threadId)),
    ]);
    const existing = new Map();
    for (const event of existingEvents) {
      const key = `${event.role}\0${event.content}`;
      existing.set(key, (existing.get(key) ?? 0) + 1);
    }
    let inserted = 0;
    for (const message of nativeMessages) {
      const key = `${message.role}\0${message.content}`;
      const remainingMatches = existing.get(key) ?? 0;
      if (remainingMatches > 0) {
        existing.set(key, remainingMatches - 1);
        continue;
      }
      const event = this.database.insertAiChatEvent({
        id: message.id ? `native:${message.id}` : undefined,
        threadId,
        type: message.role === "user" ? "user_message" : "agent_message",
        role: message.role,
        content: message.content,
        data: { source: "codex-native" },
        createdAt: message.createdAt ?? undefined,
      });
      inserted += 1;
      this.#emit(threadId, { type: "ai.event", event });
    }
    return inserted;
  }

  getRun(runId) {
    const run = this.database.getAiChatRun(runId);
    if (!run) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${runId}' does not exist`);
    }
    return run;
  }

  subscribe(threadId, listener) {
    let listeners = this.listeners.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(threadId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }

  async getCatalog(projectId) {
    return discoverAiCatalog({
      codexExecutable: this.codexExecutable,
      codexStatePath: this.codexStatePath,
      database: this.database,
      projectId,
      processEnv: this.processEnv,
      fallbackWorkspacePath: this.fallbackWorkspacePath,
    });
  }

  async createThread(input) {
    const [catalog, resolved] = await Promise.all([
      this.getCatalog(input.projectId),
      resolveAiWorkspace(
        input.projectId,
        this.codexStatePath,
        this.database,
        this.fallbackWorkspacePath,
      ),
    ]);
    const model = this.#resolveModel(catalog);
    const reasoningEffort = input.reasoningEffort ?? model.defaultReasoningEffort;
    this.#validateReasoningEffort(model, reasoningEffort);
    const sandbox = input.sandbox ?? "danger-full-access";
    this.#validateSandbox(sandbox);

    let issue;
    const issueProjectId = input.issueProjectId ?? input.projectId;
    if (input.issueId !== undefined) {
      issue = this.database.getTask(input.issueId);
      if (!issue || issue.projectId !== issueProjectId || issue.archivedAt != null) {
        throw new ApiError(
          404,
          "AI_CHAT_ISSUE_NOT_FOUND",
          `Task '${input.issueId}' is not an active task in project '${issueProjectId}'`,
        );
      }
    }

    const issueIdentifier = issue?.projectId === "tomato"
      ? tomatoItemKey(issue.description) || issue.identifier
      : issue?.identifier;

    if (issueIdentifier) {
      const existing = this.database.listAiChatThreads({ issueIdentifier })
        .find((thread) => thread.origin.projectId === resolved.project.id);
      if (existing) return existing;
    }

    const gitBranch = await this.readGitBranch(resolved.workspacePath);
    const threadId = issue?.projectId === "tomato"
      && resolved.project.id === "tomato"
      && issueIdentifier
      ? `tomato:${issueIdentifier}`
      : undefined;
    const defaultTitle = conversationTitle(issue, issueIdentifier);
    try {
      return this.database.createAiChatThread({
        ...(threadId ? { id: threadId } : {}),
        title: input.title ?? defaultTitle,
        origin: {
          projectId: resolved.project.id,
          projectName: resolved.project.name,
          workspacePath: resolved.workspacePath,
          ...(issue ? { issueId: issue.id, issueIdentifier } : {}),
        },
        gitBranch,
        reasoningEffort,
        sandbox,
      });
    } catch (error) {
      const concurrentlyCreated = threadId ? this.database.getAiChatThread(threadId) : null;
      if (concurrentlyCreated) return concurrentlyCreated;
      throw error;
    }
  }

  async updateThread(threadId, changes) {
    let thread = this.getThread(threadId);
    const changesSettings = ["reasoningEffort", "sandbox"].some(
      (key) => Object.hasOwn(changes, key),
    );
    const wasActive = changesSettings && this.#threadIsActive(thread);

    if (Object.hasOwn(changes, "sandbox")) this.#validateSandbox(changes.sandbox);
    if (Object.hasOwn(changes, "reasoningEffort")) {
      const catalog = await this.getCatalog(thread.origin.projectId);
      thread = this.getThread(threadId);
      const model = this.#resolveModel(catalog);
      const reasoningEffort = changes.reasoningEffort ?? thread.reasoningEffort;
      this.#validateReasoningEffort(model, reasoningEffort);
    }
    if (wasActive || (changesSettings && this.#threadIsActive(thread))) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }

    return this.database.updateAiChatThread(threadId, changes);
  }

  deleteThread(threadId) {
    const thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    return this.database.deleteAiChatThread(threadId);
  }

  async startTurn(threadId, input) {
    let thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    this.#validateTurnInput(input);
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }

    const [catalog, resolved] = await Promise.all([
      this.getCatalog(thread.origin.projectId),
      resolveAiWorkspace(
        thread.origin.projectId,
        this.codexStatePath,
        this.database,
        this.fallbackWorkspacePath,
      ),
    ]);

    thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }
    const recordedModelSlug = thread.codexThreadId
      ? await this.readCodexThreadModel(this.codexStatePath, thread.codexThreadId)
      : null;
    const recordedModel = recordedModelSlug
      ? catalog.models.find((candidate) => candidate.slug === recordedModelSlug)
      : null;
    const model = recordedModel ?? this.#resolveModel(catalog);
    const reasoningEffort = model.supportedReasoningEfforts.includes(thread.reasoningEffort)
      ? thread.reasoningEffort
      : model.defaultReasoningEffort;
    this.#validateReasoningEffort(model, reasoningEffort);
    const migrationChanges = {};
    if (thread.reasoningEffort !== reasoningEffort) {
      migrationChanges.reasoningEffort = reasoningEffort;
    }
    if (Object.keys(migrationChanges).length > 0) {
      thread = this.database.updateAiChatThread(threadId, migrationChanges);
    }
    if (resolved.workspacePath !== thread.origin.workspacePath) {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_CHANGED",
        "The project's device workspace no longer matches this conversation",
      );
    }
    const startingBranch = await this.readGitBranch(thread.origin.workspacePath);

    const skillIds = input.skillIds ?? [];
    const availableSkills = new Map(
      catalog.skills
        .filter((skill) => skill.id !== "tomato-workboard")
        .map((skill) => [skill.id, skill]),
    );
    for (const skillId of skillIds) {
      if (!availableSkills.has(skillId)) {
        throw new ApiError(400, "INVALID_SKILL", `Unknown or unavailable skill '${skillId}'`);
      }
    }
    const selectedSkills = skillIds.map((skillId) => availableSkills.get(skillId));

    const attachments = input.attachments ?? [];
    const {
      temporaryDirectory,
      attachmentPaths,
      imagePaths,
    } = await this.#writeTurnAttachments(attachments);
    try {
      const args = thread.codexThreadId
        ? buildCodexArgs(
          thread,
          resolved.addDirectories,
          imagePaths,
          model.slug,
        )
        : null;
      const prompt = buildCodexPrompt(
        thread,
        {
          message: input.message,
          skills: selectedSkills,
          attachmentPaths,
        },
      );
      const run = this.database.createAiChatRun({ threadId });
      this.#emit(threadId, { type: "ai.run", run });
      const userEventData = {};
      if (skillIds.length > 0) userEventData.skillIds = skillIds;
      if (attachments.length > 0) {
        userEventData.attachments = attachments.map(({ filename, contentType, size }) => ({
          filename,
          contentType,
          size,
        }));
      }
      const userEvent = this.database.insertAiChatEvent({
        threadId,
        runId: run.id,
        type: "user_message",
        role: "user",
        content: input.message,
        data: Object.keys(userEventData).length > 0 ? userEventData : undefined,
      });
      this.#emit(threadId, { type: "ai.event", event: userEvent });

      const resumingThreadId = thread.codexThreadId;
      let startedThreadId = null;
      let terminalOutcome = null;
      let terminalError = "";
      const { child, completion } = thread.codexThreadId
        ? spawnCodexTurn({
          executable: this.codexExecutable,
          args,
          prompt,
          env: this.processEnv,
          onRawEvent: (raw) => {
          const normalized = normalizeCodexEvent(raw);
          if (!normalized) return;
          if (normalized.kind === "thread.started") {
            if (
              (resumingThreadId && normalized.threadId !== resumingThreadId)
              || (startedThreadId && normalized.threadId !== startedThreadId)
            ) {
              throw new Error("Codex returned an unexpected thread id");
            }
            startedThreadId = normalized.threadId;
            this.database.updateAiChatThread(threadId, { codexThreadId: normalized.threadId });
            return;
          }
          const event = this.database.insertAiChatEvent({
            threadId,
            runId: run.id,
            type: normalized.type,
            role: normalized.role,
            content: normalized.content,
            data: normalized.data,
          });
          if (raw.type === "turn.completed" && terminalOutcome === null) {
            terminalOutcome = "completed";
          } else if (raw.type === "turn.failed" || raw.type === "error") {
            terminalOutcome = "failed";
            terminalError ||= normalized.content;
          }
          this.#emit(threadId, { type: "ai.event", event });
          },
        })
        : spawnCodexAppServerTurn({
          executable: this.codexExecutable,
          thread,
          addDirectories: resolved.addDirectories,
          imagePaths,
          prompt,
          model: model.slug,
          env: this.processEnv,
          onRawEvent: (raw) => {
            const normalized = normalizeCodexEvent(raw);
            if (!normalized) return;
            if (normalized.kind === "thread.started") {
              if (startedThreadId && normalized.threadId !== startedThreadId) {
                throw new Error("Codex returned an unexpected thread id");
              }
              startedThreadId = normalized.threadId;
              this.database.updateAiChatThread(threadId, { codexThreadId: normalized.threadId });
              return;
            }
            const event = this.database.insertAiChatEvent({
              threadId,
              runId: run.id,
              type: normalized.type,
              role: normalized.role,
              content: normalized.content,
              data: normalized.data,
            });
            if (raw.type === "turn.completed" && terminalOutcome === null) {
              terminalOutcome = "completed";
            } else if (raw.type === "turn.failed" || raw.type === "error") {
              terminalOutcome = "failed";
              terminalError ||= normalized.content;
            }
            this.#emit(threadId, { type: "ai.event", event });
          },
        });

      const active = { child, threadId, interrupted: false, temporaryDirectory, startingBranch };
      this.active.set(run.id, active);
      const finalization = completion.then(
        (result) => this.#finishRun({
          run,
          active,
          result,
          resumingThreadId,
          startedThreadId: () => startedThreadId,
          terminalOutcome: () => terminalOutcome,
          terminalError: () => terminalError,
        }),
        (error) => this.#finishRun({
          run,
          active,
          error,
          resumingThreadId,
          startedThreadId: () => startedThreadId,
          terminalOutcome: () => terminalOutcome,
          terminalError: () => terminalError,
        }),
      );
      this.completions.set(run.id, finalization);
      void finalization.finally(() => this.completions.delete(run.id)).catch(() => {});
      return run;
    } catch (error) {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async interrupt(runId) {
    let run = this.getRun(runId);
    if (run.status !== "running") return run;

    const active = this.active.get(runId);
    if (!active) {
      run = this.database.updateAiChatRun(runId, {
        status: "interrupted",
        error: "Interrupted",
        finishedAt: new Date().toISOString(),
      });
      this.#emit(run.threadId, { type: "ai.run", run });
      return run;
    }

    active.interrupted = true;
    signalProcessGroup(active.child, "SIGTERM");
    const timer = setTimeout(() => {
      if (this.active.has(runId)) signalProcessGroup(active.child, "SIGKILL");
    }, this.killGraceMs);
    timer.unref();

    const completion = this.completions.get(runId);
    if (completion) {
      await Promise.race([completion.catch(() => {}), wait(this.killGraceMs + 25)]);
    }
    return this.getRun(runId);
  }

  async close() {
    const entries = [...this.active.entries()];
    for (const [, active] of entries) {
      active.interrupted = true;
      signalProcessGroup(active.child, "SIGTERM");
    }

    const completions = entries
      .map(([runId]) => this.completions.get(runId))
      .filter(Boolean);
    if (completions.length > 0) {
      const settled = Promise.allSettled(completions);
      await Promise.race([settled, wait(this.killGraceMs)]);
      for (const [runId, active] of entries) {
        if (this.active.has(runId)) signalProcessGroup(active.child, "SIGKILL");
      }
      await settled;
    }
    this.listeners.clear();
  }

  #resolveModel(catalog) {
    const model = catalog.models.find((candidate) => candidate.slug === DEFAULT_AI_MODEL)
      ?? catalog.models[0];
    if (!model) {
      throw new ApiError(
        400,
        "INVALID_MODEL",
        "Codex did not provide an available model",
      );
    }
    return model;
  }

  #validateReasoningEffort(model, reasoningEffort) {
    if (!model.supportedReasoningEfforts.includes(reasoningEffort)) {
      throw new ApiError(
        400,
        "INVALID_REASONING_EFFORT",
        `Reasoning effort '${reasoningEffort}' is not supported by model '${model.slug}'`,
      );
    }
  }

  #validateSandbox(sandbox) {
    if (!SANDBOXES.has(sandbox)) {
      throw new ApiError(
        400,
        "INVALID_SANDBOX",
        "'sandbox' must be read-only, workspace-write, or danger-full-access",
      );
    }
  }

  #validateTurnInput(input) {
    if (
      !input
      || typeof input.message !== "string"
      || input.message.length > 100_000
      || (
        input.message.trim() === ""
        && (!Array.isArray(input.attachments) || input.attachments.length === 0)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_MESSAGE",
        "A message or at least one attachment is required",
      );
    }
    if (
      input.skillIds !== undefined
      && (
        !Array.isArray(input.skillIds)
        || input.skillIds.length > 20
        || input.skillIds.some((skillId) => typeof skillId !== "string" || !skillId)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_SKILL",
        "'skillIds' must contain at most 20 skill ids",
      );
    }
  }

  async #writeTurnAttachments(attachments) {
    if (attachments.length === 0) {
      return { temporaryDirectory: null, attachmentPaths: [], imagePaths: [] };
    }
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "codex-taskboard-ai-turn-"),
    );
    try {
      const attachmentPaths = [];
      const imagePaths = [];
      for (const [index, attachment] of attachments.entries()) {
        const attachmentPath = path.join(
          temporaryDirectory,
          `attachment-${index + 1}-${attachment.filename}`,
        );
        await writeFile(attachmentPath, attachment.data, { flag: "wx", mode: 0o600 });
        attachmentPaths.push(attachmentPath);
        if (CODEX_IMAGE_TYPES.has(attachment.contentType)) imagePaths.push(attachmentPath);
      }
      return { temporaryDirectory, attachmentPaths, imagePaths };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  #threadIsActive(thread) {
    return Boolean(thread.currentRun)
      || [...this.active.values()].some((active) => active.threadId === thread.id);
  }

  async #finishRun({
    run,
    active,
    result,
    error,
    resumingThreadId,
    startedThreadId,
    terminalOutcome,
    terminalError,
  }) {
    let status;
    let publicError = null;
    if (active.interrupted) {
      status = "interrupted";
      publicError = "Interrupted";
    } else if (error) {
      status = "failed";
      publicError = cappedError(error) || "Codex turn failed";
    } else if (terminalOutcome() === "failed") {
      status = "failed";
      publicError = terminalError() || "Codex reported a failed turn";
    } else if (result.exitCode !== 0) {
      status = "failed";
      publicError = result.exitCode === null
        ? `Codex exited due to signal ${result.signal ?? "unknown"}`
        : `Codex exited with code ${result.exitCode}`;
    } else if (terminalOutcome() !== "completed") {
      status = "failed";
      publicError = "Codex exited without reporting turn completion";
    } else if (!resumingThreadId && !startedThreadId()) {
      status = "failed";
      publicError = "Codex did not provide a thread id";
    } else {
      status = "completed";
    }

    try {
      if (status === "failed" && terminalOutcome() !== "failed") {
        const errorEvent = this.database.insertAiChatEvent({
          threadId: run.threadId,
          runId: run.id,
          type: "error",
          role: "error",
          content: cappedError(publicError),
          data: { status: "failed" },
        });
        this.#emit(run.threadId, { type: "ai.event", event: errorEvent });
      }
      const updated = this.database.updateAiChatRun(run.id, {
        status,
        exitCode: result?.exitCode ?? null,
        error: publicError === null ? null : cappedError(publicError),
        finishedAt: new Date().toISOString(),
      });
      const thread = this.database.getAiChatThread(run.threadId);
      const finalBranch = await this.readGitBranch(thread.origin.workspacePath);
      if (finalBranch && (!thread.gitBranch || finalBranch !== active.startingBranch)) {
        this.database.updateAiChatThread(run.threadId, { gitBranch: finalBranch });
      }
      if (thread.codexThreadId) {
        await this.syncNativeThreadName(thread.codexThreadId).catch(() => {});
      }
      this.#emit(run.threadId, { type: "ai.run", run: updated });
      return updated;
    } finally {
      this.active.delete(run.id);
      if (active.temporaryDirectory) {
        await rm(active.temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  #emit(threadId, event) {
    for (const listener of this.listeners.get(threadId) ?? []) {
      try {
        listener(event);
      } catch {}
    }
  }
}
