import type {
  ActorIdentity,
  AiChatCatalog,
  AiChatAttachmentInput,
  AiChatRun,
  AiChatProvider,
  AiChatSandbox,
  AiChatThread,
  AiChatThreadSnapshot,
  AgentRuntimeConfig,
  Attachment,
  Comment,
  CodexRepository,
  DevelopmentScan,
  IssueRelationType,
  Project,
  Task,
  TaskboardMetadata,
  TaskDraft,
  TaskStatus,
  WorkflowCapabilities,
  WorkflowWorkspaceRecord,
} from "./types";

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

let currentUserActor = DEFAULT_USER_ACTOR;

export function setCurrentUserActor(actor?: ActorIdentity) {
  currentUserActor = actor?.type === "user" ? actor : DEFAULT_USER_ACTOR;
}

export async function listAgentRuntimes(signal?: AbortSignal): Promise<AgentRuntimeConfig[]> {
  const data = await request<{ runtimes: AgentRuntimeConfig[] }>("/api/agent-runtimes", { signal });
  return data.runtimes;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code ?? "REQUEST_FAILED";
    this.details = body.error?.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Taskboard-User-Id", currentUserActor.id);
    headers.set("X-Taskboard-User-Name", encodeURIComponent(currentUserActor.name));
    if (currentUserActor.avatarUrl) {
      headers.set("X-Taskboard-User-Avatar", currentUserActor.avatarUrl);
    }
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(0, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "无法连接本地工作台服务，请确认工作台已启动后重试。",
      },
    });
  }
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;

  if (!response.ok) {
    const error = new ApiError(response.status, body);
    if (isTomatoAuthError(error) && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("tomato-auth-required"));
    }
    throw error;
  }
  return body;
}

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/projects", { signal });
  return data.projects;
}

export async function getTaskboardMetadata(signal?: AbortSignal): Promise<TaskboardMetadata> {
  return request<TaskboardMetadata>("/api/meta", { signal });
}

export async function getTaskboardRevision(
  since: number,
  signal?: AbortSignal,
): Promise<{ changed: boolean; revision: number }> {
  const query = new URLSearchParams({ since: String(since) });
  return request<{ changed: boolean; revision: number }>(`/api/revisions?${query}`, { signal });
}

export async function getAiChatCatalog(
  projectId: string,
  providerId: AiChatProvider = "codex",
  signal?: AbortSignal,
): Promise<AiChatCatalog> {
  const query = providerId === "codex"
    ? `projectId=${encodeURIComponent(projectId)}`
    : new URLSearchParams({ projectId, providerId }).toString();
  return request<AiChatCatalog>(
    `/api/local/ai/catalog?${query}`,
    { signal },
  );
}

export async function listAiChatThreads(signal?: AbortSignal): Promise<AiChatThread[]> {
  const data = await request<{ threads: AiChatThread[] }>("/api/local/ai/threads", { signal });
  return data.threads;
}

export async function listAiChatThreadsForIssueIdentifier(
  issueIdentifier: string,
  signal?: AbortSignal,
): Promise<AiChatThread[]> {
  const query = new URLSearchParams({ issueIdentifier });
  const data = await request<{ threads: AiChatThread[] }>(
    `/api/local/ai/threads?${query}`,
    { signal },
  );
  return data.threads;
}

export async function listAiChatThreadsForProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<AiChatThread[]> {
  const query = new URLSearchParams({ projectId });
  const data = await request<{ threads: AiChatThread[] }>(
    `/api/local/ai/threads?${query}`,
    { signal },
  );
  return data.threads;
}

export async function createAiChatThread(input: {
  projectId: string;
  issueId?: string;
  issueProjectId?: string;
  title?: string;
  reasoningEffort?: string;
  sandbox?: AiChatSandbox;
  providerId?: AiChatProvider;
}): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>("/api/local/ai/threads", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.thread;
}

export async function getAiChatThread(
  threadId: string,
  signal?: AbortSignal,
): Promise<AiChatThreadSnapshot> {
  return request<AiChatThreadSnapshot>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { signal },
  );
}

export async function updateAiChatThread(
  threadId: string,
  input: {
    title?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  },
): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return data.thread;
}

export async function deleteAiChatThread(threadId: string): Promise<void> {
  await request<void>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { method: "DELETE" },
  );
}

export async function startAiChatTurn(
  threadId: string,
  input: {
    message: string;
    skillIds?: string[];
    attachments?: AiChatAttachmentInput[];
    dangerFullAccessConfirmed?: boolean;
  },
): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.run;
}

export async function interruptAiChatRun(runId: string): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/runs/${encodeURIComponent(runId)}/interrupt`,
    { method: "POST" },
  );
  return data.run;
}

export function subscribeAiChatThread(
  threadId: string,
  onHint: (type: "ai.event" | "ai.run") => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/local/ai/threads/${encodeURIComponent(threadId)}/events`);
  source.addEventListener("ai.event", () => onHint("ai.event"));
  source.addEventListener("ai.run", () => onHint("ai.run"));
  if (onError) source.addEventListener("error", onError);
  return () => source.close();
}

export async function listCodexRepositories(signal?: AbortSignal): Promise<CodexRepository[]> {
  const data = await request<{ repositories: CodexRepository[] }>("/api/codex-repositories", { signal });
  return data.repositories;
}

export async function listAgentRepositories(signal?: AbortSignal): Promise<CodexRepository[]> {
  const data = await request<{ repositories: CodexRepository[] }>("/api/repositories", { signal });
  return data.repositories;
}

export async function listDeviceWorkspaces(signal?: AbortSignal): Promise<Record<string, string>> {
  try {
    const data = await request<{ workspaces: Record<string, string> }>("/api/device-workspaces", { signal });
    return data.workspaces;
  } catch (error) {
    if (error instanceof ApiError && error.code === "LOCAL_COMPANION_REQUIRED") return {};
    throw error;
  }
}

export async function listWorkflowCapabilities(
  workspacePath?: string,
  signal?: AbortSignal,
): Promise<WorkflowCapabilities> {
  const query = new URLSearchParams();
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<WorkflowCapabilities>(`/api/workflow-capabilities${suffix}`, { signal });
}

export async function getWorkflowWorkspace<T>(
  projectId: string,
  signal?: AbortSignal,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    { signal },
  );
  return data.workflow;
}

export async function saveWorkflowWorkspace<T>(
  projectId: string,
  workspace: T,
  version: number,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    {
      method: "PUT",
      body: JSON.stringify({ version, workspace }),
    },
  );
  return data.workflow;
}

export async function createProject(input: {
  id: string;
  name: string;
  workspacePath: string | null;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function listDevelopmentContexts(
  projectId: string,
  codexProjectId?: string,
  codexThreadId?: string,
  signal?: AbortSignal,
  workspacePath?: string,
): Promise<DevelopmentScan> {
  const query = new URLSearchParams();
  if (codexProjectId) query.set("codexProjectId", codexProjectId);
  if (codexThreadId) query.set("codexThreadId", codexThreadId);
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<DevelopmentScan>(
    `/api/projects/${encodeURIComponent(projectId)}/development-contexts${suffix}`,
    { signal },
  );
}

export async function listTasks(projectId: string, signal?: AbortSignal): Promise<Task[]> {
  const params = new URLSearchParams({ projectId, archived: "false" });
  const data = await request<{ tasks: Task[] }>(`/api/tasks?${params}`, { signal });
  return data.tasks;
}

export interface TomatoContext {
  id: string;
  name: string;
  description?: string | null;
}

export interface TomatoSession {
  authenticated: boolean;
  profile: string;
  host: string;
  contexts: TomatoContext[];
  context: TomatoContext | null;
  user: unknown;
}

export function isTomatoAuthError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.code === "TOMATO_AUTH_REQUIRED" || error.status === 401);
}

export interface TomatoSyncResult {
  total: number;
  created: number;
  updated: number;
  archived: number;
  sourceCount: number;
  fetchedCount: number;
  excludedCount: number;
  nextPageIndex: number;
  truncated: boolean;
}

export async function getTomatoSession(signal?: AbortSignal): Promise<TomatoSession> {
  return request<TomatoSession>("/api/local/tomato/session", { signal });
}

export async function loginTomato(token: string): Promise<TomatoSession> {
  return request<TomatoSession>("/api/local/tomato/login", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function switchTomatoContext(contextId: string): Promise<TomatoSession> {
  return request<TomatoSession>("/api/local/tomato/context", {
    method: "POST",
    body: JSON.stringify({ contextId }),
  });
}

export async function syncTomatoItems(): Promise<TomatoSyncResult> {
  return request<TomatoSyncResult>("/api/local/tomato/sync", { method: "POST" });
}

export async function setTomatoAnalysisDisabled(itemKey: string, disabled: boolean): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/local/tomato/items/${encodeURIComponent(itemKey)}/analysis-toggle`,
    { method: "POST", body: JSON.stringify({ disabled }) },
  );
  return data.task;
}

export interface TomatoAnalysisProgress {
  running: boolean;
  itemKey: string | null;
  threadId: string | null;
  cancelRequested: boolean;
  messages: Array<{ content: string; at: number }>;
  updatedAt: number | null;
}

export async function getTomatoAnalysisProgress(signal?: AbortSignal): Promise<TomatoAnalysisProgress> {
  return request<TomatoAnalysisProgress>("/api/local/tomato/analysis-progress", { signal });
}

export async function setTomatoAnalysisProgress(running: boolean, itemKey: string | null, threadId?: string | null, message?: string, cancelRequested?: boolean): Promise<TomatoAnalysisProgress> {
  return request<TomatoAnalysisProgress>("/api/local/tomato/analysis-progress", {
    method: "POST",
    body: JSON.stringify({ running, itemKey, ...(threadId === undefined ? {} : { threadId }), ...(message ? { message } : {}), ...(cancelRequested === undefined ? {} : { cancelRequested }) }),
  });
}

export async function openCodexThread(threadId: string): Promise<void> {
  await request<{ threadId: string }>(
    `/api/local/codex/threads/${encodeURIComponent(threadId)}/open`,
    { method: "POST" },
  );
}

export async function openNativeAiThread(threadId: string): Promise<void> {
  await request<{ threadId: string; providerId: AiChatProvider }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/open-native`,
    { method: "POST" },
  );
}

export interface TomatoTransition {
  transition: string;
  targetStatus: string;
  disabled: boolean;
  disabledReason?: string;
  missingRequiredFields: Array<{ fieldKey?: string; fieldName: string; message?: string }>;
  requirementsKnown: boolean;
  requiresAgentPreflight?: boolean;
}

export interface TomatoTransitionResult {
  itemKey: string;
  previousStatus: string;
  currentStatus: string;
  targetStatus: string;
  transition: string | null;
  alreadyInTarget: boolean;
  noFixReason?: string;
}

export async function listTomatoTransitions(
  itemKey: string,
  signal?: AbortSignal,
): Promise<TomatoTransition[]> {
  const data = await request<{ itemKey: string; transitions: TomatoTransition[] }>(
    `/api/local/tomato/items/${encodeURIComponent(itemKey)}/transitions`,
    { signal },
  );
  return data.transitions;
}

export async function transitionTomatoItem(
  itemKey: string,
  targetStatus: string,
  options: { noFixReason?: string } = {},
): Promise<TomatoTransitionResult> {
  return request<TomatoTransitionResult>(
    `/api/local/tomato/items/${encodeURIComponent(itemKey)}/transition`,
    {
      method: "POST",
      body: JSON.stringify({ targetStatus, ...options }),
    },
  );
}

export async function createTask(projectId: string, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ projectId, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function updateTask(task: Task, draft: Partial<TaskDraft>, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ version: task.version, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function moveTask(
  task: Task,
  status: TaskStatus,
  sortOrder: number,
  threadId?: string,
): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/move`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, status, sortOrder, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function archiveTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function restoreTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function addTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function removeTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function listComments(taskId: string, signal?: AbortSignal): Promise<Comment[]> {
  const data = await request<{ comments: Comment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    { signal },
  );
  return data.comments;
}

export async function createComment(taskId: string, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function updateComment(comment: Comment, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/comments/${encodeURIComponent(comment.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version: comment.version, body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function deleteComment(comment: Comment, threadId?: string): Promise<void> {
  await request(`/api/comments/${encodeURIComponent(comment.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ version: comment.version, ...(threadId ? { threadId } : {}) }),
  });
}

export async function listAttachments(taskId: string, signal?: AbortSignal): Promise<Attachment[]> {
  const data = await request<{ attachments: Attachment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    { signal },
  );
  return data.attachments;
}

export async function uploadAttachment(taskId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function uploadCommentAttachment(commentId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/comments/${encodeURIComponent(commentId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function deleteAttachment(attachment: Attachment): Promise<void> {
  await request(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
    method: "DELETE",
  });
}

export function attachmentContentUrl(attachment: Attachment): string {
  return `/api/attachments/${encodeURIComponent(attachment.id)}/content`;
}
