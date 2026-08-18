import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
// @ts-expect-error Shared runtime constants are verified by focused node tests.
import { isVisibleTomatoStatus } from "../../shared/tomato-statuses.mjs";
// @ts-expect-error Shared Tomato identity parsing is verified by focused node tests.
import { tomatoItemKeyFromTask } from "../../shared/tomato-url.mjs";
import {
  ApiError,
  createAiChatThread,
  addTaskRelation,
  archiveTask as archiveTaskRequest,
  createProject as createProjectRequest,
  createTask as createTaskRequest,
  getTomatoAnalysisProgress,
  getTomatoSession,
  loginTomato,
  switchTomatoContext,
  getAiChatThread,
  getTaskboardRevision,
  getWorkflowWorkspace,
  getTaskboardMetadata,
  listCodexRepositories,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  listAiChatThreadsForProject,
  listProjects,
  listTasks,
  interruptAiChatRun,
  moveTask as moveTaskRequest,
  openCodexThread as openCodexThreadRequest,
  removeTaskRelation,
  restoreTask as restoreTaskRequest,
  setTomatoAnalysisProgress,
  setTomatoAnalysisDisabled,
  setCurrentUserActor,
  syncTomatoItems,
  type TomatoSession,
  startAiChatTurn,
  uploadAttachment,
  updateTask as updateTaskRequest,
} from "./api";
import {
  actorForAssigneeTarget,
  assigneeTargetForActor,
} from "./actors";
import { BoardColumn, STATUS_DETAILS } from "./components/BoardColumn";
import { TomatoStatusColumn } from "./components/TomatoStatusColumn";
import { AiChat, type AiChatHandle } from "./components/AiChat";
import { BoardSettingsMenu } from "./components/BoardSettingsMenu";
import { HiddenColumns } from "./components/HiddenColumns";
import {
  resolveInlineMediaMarkdown,
  type PendingInlineImage,
} from "./components/InlineMediaComposer";
import { LinearIcon } from "./components/LinearIcon";
import { TaskContextMenu } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import { TaskEditor } from "./components/TaskEditor";
import { TaskFilterMenu } from "./components/TaskFilterMenu";
import { buildIssueUrl, readIssueIdentifier } from "./issueRoute";
import { TomatoTaskDetail } from "./components/TomatoTaskDetail";
import { TomatoLoginPage } from "./components/TomatoLoginPage";
import { DEFAULT_LABELS } from "./labels";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  readTaskFilters,
  taskFilterCount,
  writeTaskFilters,
} from "./taskFilters";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type AiChatEvent,
  type AiChatThread,
  type CodexRepository,
  type DevelopmentScan,
  type HostContext,
  type IssueRelationType,
  type Project,
  type Task,
  type TaskboardMetadata,
  type TaskDraft,
  type TaskStatus,
  type WorkflowOption,
} from "./types";
import {
  DEFAULT_WORKFLOW_OPTIONS,
  readLegacyWorkflowWorkspace,
  workflowOptionsFromWorkspace,
} from "./workflowStore";

type ConnectionState = "connecting" | "live" | "reconnecting";
type Theme = "light" | "dark";
type BoardView = "issues" | "workflow";
const TOMATO_STATUS_ORDER = ["新建", "Bugfix", "修复中", "待测试", "测试中"];
const SHOW_WORKFLOW_BOARD_ENTRY = false;

function sameTomatoConversationSummary(
  current: ReadonlyMap<string, AiChatThread[]>,
  next: ReadonlyMap<string, AiChatThread[]>,
): boolean {
  if (current.size !== next.size) return false;
  for (const [itemKey, nextThreads] of next) {
    const currentThreads = current.get(itemKey);
    if (!currentThreads || currentThreads.length !== nextThreads.length) return false;
    for (let index = 0; index < nextThreads.length; index += 1) {
      const currentThread = currentThreads[index];
      const nextThread = nextThreads[index];
      if (
        currentThread.id !== nextThread.id
        || currentThread.status !== nextThread.status
        || currentThread.codexThreadId !== nextThread.codexThreadId
        || currentThread.gitBranch !== nextThread.gitBranch
        || currentThread.origin.workspacePath !== nextThread.origin.workspacePath
      ) return false;
    }
  }
  return true;
}

function groupTomatoConversations(threads: AiChatThread[]) {
  const conversations = new Map<string, AiChatThread[]>();
  for (const thread of threads) {
    const itemKey = thread.origin.issueIdentifier;
    if (!itemKey) continue;
    conversations.set(itemKey, [...(conversations.get(itemKey) ?? []), thread]);
  }
  return conversations;
}

const WorkflowBoard = lazy(() => import("./components/WorkflowBoard").then((module) => ({
  default: module.WorkflowBoard,
})));

interface EditorState {
  task: Task | null;
  status: TaskStatus;
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface ProjectChoice {
  id: string;
  name: string;
  issueCount: number;
  inCodex: boolean;
  persisted: boolean;
}

interface UndoOperation {
  id: number;
  message: string;
  undo: () => Promise<void>;
}

interface UndoNotice {
  id: number;
  message: string;
}

type ColumnVisibilityByProject = Record<string, Partial<Record<TaskStatus, boolean>>>;
const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const LAST_PROJECT_KEY = "taskboard.lastProjectId";
const TOMATO_REPOSITORY_PROJECT_KEY = "taskboard.tomatoRepositoryProjectId";
const FAVORITE_PROJECTS_KEY = "taskboard.favoriteProjectIds";
const DEVICE_WORKSPACE_PATHS_KEY = "taskboard.deviceWorkspacePaths.v1";
const ANALYSIS_REPOSITORY_ORDER_KEY = "taskboard.analysisRepositoryOrder.v1";
const SHOW_EMPTY_COLUMNS_KEY = "taskboard.showEmptyColumns.v1";
const COLUMN_VISIBILITY_KEY = "taskboard.columnVisibility.v1";

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.relation.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "project.created",
  "workflow.updated",
] as const;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getInitialTheme(): Theme {
  const fromQuery = new URLSearchParams(window.location.search).get("theme");
  if (isTheme(fromQuery)) return fromQuery;
  const stored = window.localStorage.getItem("taskboard.theme");
  if (isTheme(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readFavoriteProjectIds(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FAVORITE_PROJECTS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readAnalysisRepositoryOrder(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(ANALYSIS_REPOSITORY_ORDER_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function readDeviceWorkspacePaths(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(DEVICE_WORKSPACE_PATHS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readShowEmptyColumns(): boolean {
  return window.localStorage.getItem(SHOW_EMPTY_COLUMNS_KEY) === "true";
}

function readColumnVisibilityByProject(): ColumnVisibilityByProject {
  try {
    const value = JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ColumnVisibilityByProject = {};
    for (const [projectId, visibilityValue] of Object.entries(value)) {
      if (!visibilityValue || typeof visibilityValue !== "object" || Array.isArray(visibilityValue)) continue;
      const visibility: Partial<Record<TaskStatus, boolean>> = {};
      for (const status of TASK_STATUSES) {
        const visible = (visibilityValue as Record<string, unknown>)[status];
        if (typeof visible === "boolean") visibility[status] = visible;
      }
      result[projectId] = visibility;
    }
    return result;
  } catch {
    return {};
  }
}

function workspaceName(path?: string): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong while loading your issues.";
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
  );
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    workflowId: task.workflowId,
    developmentContext: task.developmentContext,
    dueDate: task.dueDate,
    recurrence: task.recurrence,
  };
}

interface LocalRealtimeSyncProps {
  selectedProjectId: string;
  detailTaskId: string | null;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshWorkflowOptions: (projectId: string, signal?: AbortSignal) => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
}

function LocalRealtimeSync({
  selectedProjectId,
  detailTaskId,
  refreshProjectList,
  refreshTasks,
  refreshWorkflowOptions,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
}: LocalRealtimeSyncProps) {
  useEffect(() => {
    const source = new EventSource("/api/events");
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    let refreshTasksPending = false;

    const scheduleRefresh = (options: { projects?: boolean; tasks?: boolean }) => {
      refreshProjectsPending ||= options.projects === true;
      refreshTasksPending ||= options.tasks === true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (refreshProjectsPending) void refreshProjectList();
        if (refreshTasksPending && selectedProjectId) {
          void refreshTasks(selectedProjectId, { quiet: true });
        }
        refreshProjectsPending = false;
        refreshTasksPending = false;
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: { projectId?: string; taskId?: string } = {};
      try {
        payload = JSON.parse(message.data) as { projectId?: string; taskId?: string };
      } catch {
        // A malformed event should not interrupt later updates.
      }
      const affectsSelectedProject = Boolean(selectedProjectId)
        && (!payload.projectId || payload.projectId === selectedProjectId);
      if (event.type === "project.created") {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type.startsWith("task.")) {
        scheduleRefresh({ projects: true, tasks: affectsSelectedProject });
        return;
      }
      if (!affectsSelectedProject) return;
      if (event.type === "workflow.updated") {
        if (selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
        return;
      }
      if (event.type.startsWith("comment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({ tasks: true });
        return;
      }
      if (event.type.startsWith("attachment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          setCommentsRevision((current) => current + 1);
        }
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      scheduleRefresh({ projects: true, tasks: Boolean(selectedProjectId) });
      if (selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
      if (detailTaskId) {
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      }
    };
    source.onerror = () => setConnection("reconnecting");

    return () => {
      window.clearTimeout(refreshTimer);
      EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [
    detailTaskId,
    refreshProjectList,
    refreshTasks,
    refreshWorkflowOptions,
    selectedProjectId,
    setAttachmentsRevision,
    setCommentsRevision,
    setConnection,
  ]);

  return null;
}

function TaskboardApp() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const embedded = query.get("host") === "codex";
  const undoShortcut = navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  const [developmentScan, setDevelopmentScan] = useState<DevelopmentScan>({ workspacePath: null, contexts: [] });
  const [developmentScanLoading, setDevelopmentScanLoading] = useState(false);
  const [tomatoWorkboardSkillPath, setTomatoWorkboardSkillPath] = useState("");
  const [taskboardMetadata, setTaskboardMetadata] = useState<TaskboardMetadata | null>(null);
  const [localAiChatAvailable, setLocalAiChatAvailable] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [codexRepositories, setCodexRepositories] = useState<CodexRepository[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("tomato");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tomatoRepositoryProjectId, setTomatoRepositoryProjectId] = useState(
    () => window.localStorage.getItem(TOMATO_REPOSITORY_PROJECT_KEY) ?? "",
  );
  const [tomatoRepositoryLoading, setTomatoRepositoryLoading] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [errorCopied, setErrorCopied] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [showEmptyColumns, setShowEmptyColumns] = useState(readShowEmptyColumns);
  const [columnVisibilityByProject, setColumnVisibilityByProject] = useState(readColumnVisibilityByProject);
  const [boardView, setBoardView] = useState<BoardView>("issues");
  const [tomatoSyncing, setTomatoSyncing] = useState(false);
  const [tomatoAnalysisStarting, setTomatoAnalysisStarting] = useState(false);
  const [tomatoAnalysisProgress, setTomatoAnalysisProgressState] = useState({
    running: false,
    itemKey: null as string | null,
    threadId: null as string | null,
    cancelRequested: false,
    messages: [] as Array<{ content: string; at: number }>,
    updatedAt: null as number | null,
  });
  const [tomatoAnalysisPanelOpen, setTomatoAnalysisPanelOpen] = useState(false);
  const [tomatoAnalysisEvents, setTomatoAnalysisEvents] = useState<AiChatEvent[]>([]);
  const [tomatoConversationByItemKey, setTomatoConversationByItemKey] = useState<Map<string, AiChatThread[]>>(
    () => new Map(),
  );
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(window.location.search),
  );
  const [commentsRevision, setCommentsRevision] = useState(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>(DEFAULT_WORKFLOW_OPTIONS);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [favoriteProjectIds, setFavoriteProjectIds] = useState(readFavoriteProjectIds);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [analysisRepositoryOrder, setAnalysisRepositoryOrder] = useState(readAnalysisRepositoryOrder);
  const [analysisRepositoryDialogOpen, setAnalysisRepositoryDialogOpen] = useState(false);
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const tasksRequestRef = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const tomatoAiChatRef = useRef<AiChatHandle>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;


  const setAnnouncement = useCallback((message: string) => {
    setUndoNotice(null);
    setAnnouncementValue(message);
  }, []);

  useEffect(() => {
    if (!actionError) return undefined;
    const timeout = window.setTimeout(() => setActionError(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [actionError]);

  useEffect(() => {
    setErrorCopied(false);
  }, [actionError, loadError]);

  useEffect(() => {
    if (!errorCopied) return undefined;
    const timeout = window.setTimeout(() => setErrorCopied(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [errorCopied]);

  const copyError = useCallback(async () => {
    const message = actionError ?? loadError;
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      setErrorCopied(true);
    } catch {
      setActionError("复制失败，请手动选择错误信息。");
    }
  }, [actionError, loadError]);

  const rememberDeviceWorkspacePath = useCallback((projectId: string, workspacePath: string) => {
    const normalizedPath = workspacePath.trim();
    setDeviceWorkspacePaths((current) => {
      if (current[projectId] === normalizedPath || (!normalizedPath && !(projectId in current))) {
        return current;
      }
      const next = { ...current };
      if (normalizedPath) next[projectId] = normalizedPath;
      else delete next[projectId];
      window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const currentUser = hostContext?.user ?? DEFAULT_USER_ACTOR;
  const selectedDeviceWorkspacePath = deviceWorkspacePaths[selectedProjectId];

  useEffect(() => {
    if (selectedProjectId !== "tomato") {
      setTomatoConversationByItemKey(new Map());
      return;
    }

    const controller = new AbortController();
    let requestInFlight = false;
    const refreshConversations = async () => {
      if (requestInFlight || controller.signal.aborted) return;
      requestInFlight = true;
      try {
        const threads = await listAiChatThreadsForProject("tomato", controller.signal);
        const conversations = new Map<string, AiChatThread[]>();
        for (const thread of threads) {
          const itemKey = thread.origin.issueIdentifier;
          if (!itemKey) continue;
          conversations.set(itemKey, [...(conversations.get(itemKey) ?? []), thread]);
        }
        setTomatoConversationByItemKey((current) => (
          sameTomatoConversationSummary(current, conversations) ? current : conversations
        ));
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          // Keep the last known local state through transient polling failures.
        }
      } finally {
        requestInFlight = false;
      }
    };
    void refreshConversations();
    const interval = window.setInterval(() => void refreshConversations(), 2_000);

    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [detailTaskIdentifier, selectedProjectId]);
  const detailTask = detailTaskIdentifier
    ? tasks.find((task) => task.identifier === detailTaskIdentifier) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
  const contextMenuTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;
  const availableLabels = useMemo(
    () => [...new Set([
      ...DEFAULT_LABELS.map((label) => label.name),
      ...tasks.flatMap((task) => task.labels),
    ])],
    [tasks],
  );
  const projectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const seen = new Set<string>();
    const choices: ProjectChoice[] = [];
    for (const project of hostContext?.projects ?? []) {
      if (!project.id || !project.name || seen.has(project.id)) continue;
      seen.add(project.id);
      choices.push({
        id: project.id,
        name: persistedById.get(project.id)?.name ?? project.name,
        issueCount: persistedById.get(project.id)?.issueCount ?? 0,
        inCodex: true,
        persisted: persistedById.has(project.id),
      });
    }
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      choices.push({
        id: project.id,
        name: project.name,
        issueCount: project.issueCount,
        inCodex: false,
        persisted: true,
      });
    }
    return choices.sort((left, right) => (
      Number(favoriteProjectIds.has(right.id)) - Number(favoriteProjectIds.has(left.id))
    ));
  }, [favoriteProjectIds, hostContext?.projects, projects]);
  const tomatoRepositoryOptions = useMemo(
    () => codexRepositories.map((repository) => {
      const hostProject = hostContext?.projects?.find((project) => project.id === repository.projectId);
      return {
        ...repository,
        id: repository.projectId,
        name: hostProject?.name ?? repository.name,
      };
    }),
    [codexRepositories, hostContext?.projects],
  );
  const orderedCodexRepositories = useMemo(() => {
    const rank = new Map(analysisRepositoryOrder.map((projectId, index) => [projectId, index]));
    return [...tomatoRepositoryOptions].sort((left, right) => (
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    ));
  }, [analysisRepositoryOrder, tomatoRepositoryOptions]);
  const orderedAnalysisRepositories = useMemo(() => {
    const rank = new Map(orderedCodexRepositories.map((repository, index) => [repository.workspacePath, index]));
    const configured = taskboardMetadata?.analysisRepositories ?? [];
    return [...configured].sort((left, right) => (
      (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER)
    ));
  }, [orderedCodexRepositories, taskboardMetadata?.analysisRepositories]);
  const projectsWithIssues = useMemo(
    () => projectChoices.filter((project) => project.issueCount > 0),
    [projectChoices],
  );
  const projectsWithoutIssues = useMemo(
    () => projectChoices.filter((project) => project.issueCount === 0),
    [projectChoices],
  );
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  function openTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(task.identifier);
    const currentIssue = readIssueIdentifier(window.location.search);
    const boardUrl = buildIssueUrl(window.location.href, null, null);
    if (!currentIssue) {
      window.history.replaceState(window.history.state, "", boardUrl);
    }
    const detailUrl = buildIssueUrl(
      currentIssue ? window.location.href : boardUrl.href,
      null,
      task.identifier,
    );
    window.history.pushState(window.history.state, "", detailUrl);
  }

  function closeTaskDetail() {
    setDetailTaskIdentifier(null);
    const url = buildIssueUrl(window.location.href, null, null);
    window.history.replaceState(window.history.state, "", url);
  }

  useEffect(() => {
    const initialUrl = buildIssueUrl(window.location.href, null, readIssueIdentifier(window.location.search));
    window.history.replaceState(window.history.state, "", initialUrl);

    function syncRouteFromLocation() {
      const url = new URL(window.location.href);
      setDetailTaskIdentifier(readIssueIdentifier(url.search));
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.embedded = String(embedded);
    document.documentElement.style.colorScheme = theme;
    if (!embedded) window.localStorage.setItem("taskboard.theme", theme);
  }, [embedded, theme]);

  useEffect(() => {
    writeTaskFilters(filters);
  }, [filters]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    function closeProjectMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-switcher]")) setProjectMenuOpen(false);
    }
    function closeProjectMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeProjectMenu);
    window.addEventListener("keydown", closeProjectMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectMenu);
      window.removeEventListener("keydown", closeProjectMenuWithEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!analysisRepositoryDialogOpen) return undefined;
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setAnalysisRepositoryDialogOpen(false);
    }
    window.addEventListener("keydown", closeFromEscape);
    return () => window.removeEventListener("keydown", closeFromEscape);
  }, [analysisRepositoryDialogOpen]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;

    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown; theme?: unknown };

      if (message.type === "taskboard:theme" && isTheme(message.theme)) {
        setTheme(message.theme);
        return;
      }

      if (message.type === "taskboard:thread-prepared") {
        setOpeningThreadTaskId(null);
        return;
      }

      if (message.type === "taskboard:thread-create-error" && message.payload) {
        const payload = message.payload as { taskId?: unknown; error?: unknown };
        setOpeningThreadTaskId(null);
        setActionError(typeof payload.error === "string" ? payload.error : "无法在 Codex 中创建对话。");
        return;
      }

      if (message.type !== "taskboard:host-context" || !message.payload) return;
      const payload = message.payload as HostContext;
      setHostContext(payload);
      setCurrentUserActor(payload.user);
      if (isTheme(payload.theme)) setTheme(payload.theme);
    }

    window.addEventListener("message", receiveHostMessage);
    window.parent.postMessage({ type: "taskboard:ready" }, "*");
    return () => {
      window.removeEventListener("message", receiveHostMessage);
    };
  }, [embedded]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      window.parent.postMessage({
        type: "taskboard:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }, "*");
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      window.parent.postMessage({ type: "taskboard:drag-region", payload: null }, "*");
    };
  }, [detailTaskId, embedded, selectedProjectId]);

  const loadProjectList = useCallback(async (signal?: AbortSignal) => {
    setProjectsLoading(true);
    setLoadError(null);
    try {
      const [nextProjects, metadata, workspaces, nextCodexRepositories] = await Promise.all([
        listProjects(signal),
        getTaskboardMetadata(signal),
        listDeviceWorkspaces(signal),
        listCodexRepositories(signal),
      ]);
      setTaskboardMetadata((current) => (
        current
        && current.mode === metadata.mode
        && current.realtime?.transport === metadata.realtime?.transport
        && current.realtime?.intervalMs === metadata.realtime?.intervalMs
        && current.tomatoWorkboardSkillPath === metadata.tomatoWorkboardSkillPath
        && JSON.stringify(current.analysisRepositories ?? []) === JSON.stringify(metadata.analysisRepositories ?? [])
          ? current
          : metadata
      ));
      setTomatoWorkboardSkillPath(metadata.tomatoWorkboardSkillPath ?? "");
      setLocalAiChatAvailable(metadata.capabilities?.localAiChat === true);
      setDeviceWorkspacePaths((current) => {
        const next = { ...current, ...workspaces };
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
        return next;
      });
      setProjects(nextProjects);
      setCodexRepositories(nextCodexRepositories);
      setSelectedProjectId((current) => {
        const fromQuery = new URLSearchParams(window.location.search).get("project");
        const remembered = window.localStorage.getItem(LAST_PROJECT_KEY);
        if (fromQuery && nextProjects.some((project) => project.id === fromQuery)) return fromQuery;
        if (current && nextProjects.some((project) => project.id === current)) return current;
        if (remembered && nextProjects.some((project) => project.id === remembered)) return remembered;
        return "";
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") setLoadError(errorMessage(error));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjectList(controller.signal);
    return () => controller.abort();
  }, [loadProjectList]);

  const refreshProjectList = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  const refreshTasks = useCallback(async (
    projectId: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++tasksRequestRef.current;
    if (!options.quiet) setTasksLoading(true);
    setLoadError(null);
    try {
      const nextTasks = await listTasks(projectId, options.signal);
      if (requestId !== tasksRequestRef.current) return;
      setTasks(sortTasks(nextTasks));
      setHasLoadedTasks(true);
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === tasksRequestRef.current) {
        setLoadError(errorMessage(error));
      }
    } finally {
      if (!options.quiet && requestId === tasksRequestRef.current) setTasksLoading(false);
    }
  }, []);

  const refreshTomato = useCallback(async () => {
    if (tomatoSyncing) return;
    setTomatoSyncing(true);
    setActionError(null);
    try {
      const result = await syncTomatoItems();
      await Promise.all([
        refreshTasks("tomato", { quiet: true }),
        refreshProjectList(),
      ]);
      setAnnouncement(`已从番茄刷新 ${result.total} 张卡片`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setTomatoSyncing(false);
    }
  }, [refreshProjectList, refreshTasks, setAnnouncement, tomatoSyncing]);

  const startTomatoAnalysis = useCallback(async () => {
    if (tomatoAnalysisStarting || tomatoSyncing) return;
    const analysisProject = projects.find((project) => project.id === "local")
      ?? projects.find((project) => project.id !== "tomato");
    if (!analysisProject) {
      setActionError("没有可用于启动分析的本地 Codex 项目。");
      return;
    }
    const configuredRepositories = orderedAnalysisRepositories;
    const repositoryInstruction = configuredRepositories.length > 0
      ? [
          "按下面的顺序排查已配置的代码仓库；只有前一个仓库证据不足时才检查下一个，禁止猜测或替换成本机其他绝对路径：",
          ...configuredRepositories.map((repository, index) => `${index + 1}. ${repository}`),
        ].join("\n")
      : "当前没有配置代码仓库候选列表；只使用事项绑定仓库或当前 Codex workspace，禁止猜测本机绝对路径。";
    setTomatoAnalysisStarting(true);
    setTomatoAnalysisEvents([]);
    setActionError(null);
    try {
      const startingProgress = await setTomatoAnalysisProgress(true, null, null);
      setTomatoAnalysisProgressState(startingProgress);
      const thread = await createAiChatThread({
        projectId: analysisProject.id,
        title: "番茄 Bug 手动分析",
        reasoningEffort: "high",
        sandbox: "danger-full-access",
      });
      const runningProgress = await setTomatoAnalysisProgress(
        true,
        null,
        thread.id,
        "正在读取本地候选列表（不刷新番茄）",
      );
      setTomatoAnalysisProgressState(runningProgress);
      setTomatoAnalysisPanelOpen(true);
      await startAiChatTurn(thread.id, {
        message: [
          "立即执行一次番茄 Bug 分析，不要读取自动化配置、项目 skill 或扫描工作台源码。",
          "第一步直接 GET http://127.0.0.1:47823/api/local/tomato/analysis-candidates；禁止调用同步接口或 tomato.searchItems，只处理该接口返回且 tomatoAnalysis 为空的候选。任何已有绿、橙、红分析结果的卡片都必须跳过。",
          `逐张处理：先上报 analysis-progress（running=true、当前 itemKey、精简 message），再使用当前会话已配置的番茄读取能力获取该事项详情和评论并计算证据指纹；核心同步已经通过本地番茄 CLI 完成。\n${repositoryInstruction}\n仍无依据不得判绿。`,
          "有明确根因和可执行方案为 fixable，否则按是否需要明确人工动作分别写 needs_human 或 insufficient。调用 /api/local/tomato/items/{itemKey}/analysis 保存结果。新判绿时通过 transitions 接口流转到修复中并回读确认。",
          "每个主要步骤及进入下一张前读取 analysis-progress；cancelRequested=true 时立即停止。单张失败记录后继续下一张。整轮结束 POST running=false、itemKey=null，并用 message 汇总数量。",
          "过程 message 只写当前卡片、取证仓库、定位结果、颜色结论，不输出命令、思考或原始日志。直接使用现有 127.0.0.1:47823 服务，禁止启动、停止或重启服务。",
        ].join("\n"),
        dangerFullAccessConfirmed: true,
      });
      setAnnouncement("已基于当前工作台卡片启动手动分析。");
    } catch (error) {
      void setTomatoAnalysisProgress(false, null).then(setTomatoAnalysisProgressState).catch(() => undefined);
      setActionError(errorMessage(error));
    } finally {
      setTomatoAnalysisStarting(false);
    }
  }, [orderedAnalysisRepositories, projects, setAnnouncement, tomatoAnalysisStarting, tomatoSyncing]);

  const stopTomatoAnalysis = useCallback(async () => {
    if (!tomatoAnalysisProgress.running) return;
    setActionError(null);
    try {
      if (tomatoAnalysisProgress.threadId) {
        const snapshot = await getAiChatThread(tomatoAnalysisProgress.threadId);
        if (snapshot.thread.currentRun?.id) await interruptAiChatRun(snapshot.thread.currentRun.id);
      }
      const stopped = await setTomatoAnalysisProgress(
        false,
        tomatoAnalysisProgress.itemKey,
        undefined,
        "用户已中断本轮分析",
        true,
      );
      setTomatoAnalysisProgressState(stopped);
      setAnnouncement("已中断番茄 Bug 分析，已完成的结果会保留。");
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [setAnnouncement, tomatoAnalysisProgress]);

  useEffect(() => {
    if (selectedProjectId !== "tomato") return undefined;
    const controller = new AbortController();
    const refreshProgress = () => void getTomatoAnalysisProgress(controller.signal)
      .then(setTomatoAnalysisProgressState)
      .catch((error) => {
        if ((error as Error).name !== "AbortError") console.warn("Unable to refresh Tomato analysis progress", error);
      });
    refreshProgress();
    const interval = window.setInterval(refreshProgress, 1_500);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [selectedProjectId]);

  useEffect(() => {
    if (!tomatoAnalysisProgress.threadId) return undefined;
    const controller = new AbortController();
    const refreshEvents = () => void getAiChatThread(tomatoAnalysisProgress.threadId!, controller.signal)
      .then((snapshot) => setTomatoAnalysisEvents(snapshot.events))
      .catch((error) => {
        if ((error as Error).name !== "AbortError") console.warn("Unable to refresh Tomato analysis conversation", error);
      });
    refreshEvents();
    const interval = window.setInterval(refreshEvents, 1_500);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [tomatoAnalysisProgress.threadId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    const controller = new AbortController();
    void refreshTasks(selectedProjectId, { signal: controller.signal });
    return () => controller.abort();
  }, [refreshTasks, selectedProjectId]);

  const refreshWorkflowOptions = useCallback(async (projectId: string, signal?: AbortSignal) => {
    const record = await getWorkflowWorkspace<unknown>(projectId, signal);
    if (!signal?.aborted) setWorkflowOptions(workflowOptionsFromWorkspace(record.workspace));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setWorkflowOptions(DEFAULT_WORKFLOW_OPTIONS);
      return;
    }
    setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
    const controller = new AbortController();
    void refreshWorkflowOptions(selectedProjectId, controller.signal).catch((error) => {
      if ((error as Error).name !== "AbortError") {
        setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
      }
    });
    return () => controller.abort();
  }, [refreshWorkflowOptions, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDevelopmentScan({ workspacePath: null, contexts: [] });
      return;
    }
    const controller = new AbortController();
    const codexProjectId = selectedProjectId === "local" ? hostContext?.projectId : selectedProjectId;
    const codexThreadId = hostContext?.threadId ?? detailTask?.threadId ?? undefined;
    setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      selectedProjectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      selectedDeviceWorkspacePath,
    )
      .then((scan) => {
        setDevelopmentScan(scan);
        if (scan.workspacePath) rememberDeviceWorkspacePath(selectedProjectId, scan.workspacePath);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevelopmentScanLoading(false);
      });
    return () => controller.abort();
  }, [
    detailTask?.threadId,
    hostContext?.projectId,
    hostContext?.threadId,
    rememberDeviceWorkspacePath,
    selectedProjectId,
    selectedDeviceWorkspacePath,
  ]);

  function pushUndo(message: string, undo: () => Promise<void>, showNotice = true) {
    const operation = { id: ++undoSequenceRef.current, message, undo };
    undoStackRef.current = [...undoStackRef.current.slice(-19), operation];
    setAnnouncementValue("");
    setUndoNotice(showNotice ? { id: operation.id, message } : null);
  }

  async function performUndo() {
    if (undoInFlightRef.current) return;
    const operation = undoStackRef.current.at(-1);
    if (!operation) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    undoInFlightRef.current = true;
    setUndoNotice(null);
    setProjectMenuOpen(false);
    closeContextMenu();
    setActionError(null);
    try {
      await operation.undo();
    } catch (error) {
      setActionError(`无法撤回这次操作：${errorMessage(error)}`);
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      undoInFlightRef.current = false;
    }
  }

  async function restoreTaskDetails(
    snapshot: Task,
    changed: Task,
    assigneeTarget = assigneeTargetForActor(snapshot.assignee, currentUser),
  ) {
    const candidate = tasksRef.current.find((task) => task.id === changed.id);
    const current = candidate && candidate.version >= changed.version ? candidate : changed;
    const restored = await updateTaskRequest(current, {
      ...taskToDraft(snapshot),
      ...(assigneeTarget ? { assigneeTarget } : {}),
    });
    setTasks((tasks) => sortTasks(tasks.map((task) => task.id === restored.id ? restored : task)));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (
        event.key.toLowerCase() === "z"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !isTyping
        && !editor
      ) {
        event.preventDefault();
        void performUndo();
        return;
      }
      if (isTyping || contextMenu || projectMenuOpen) return;
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && selectedProjectId
        && boardView === "issues"
      ) {
        event.preventDefault();
        setEditor({ task: null, status: "backlog" });
      }
      if (event.key === "/" && !detailTaskId && selectedProjectId && boardView === "issues") {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape" && detailTaskId) {
        closeTaskDetail();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [boardView, contextMenu, detailTaskId, editor, projectMenuOpen, selectedProjectId]);

  const isTomatoBoard = selectedProjectId === "tomato";
  const filteredTasks = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return tasks.filter((task) => {
      const matchesSearch = isTomatoBoard
        ? !normalizedSearch || [task.title, task.creatorName, ...task.labels]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearch)
        : matchesTaskSearch(task, search);
      return matchesSearch && matchesTaskFilters(task, filters);
    });
  }, [filters, isTomatoBoard, search, tasks]);

  const tomatoTasksByStatus = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const task of filteredTasks) {
      const status = task.description.match(/(?:^|\n)当前状态：([^\n]+)/)?.[1]?.trim() || "未设置状态";
      if (!isVisibleTomatoStatus(status)) continue;
      groups.set(status, [...(groups.get(status) ?? []), task]);
    }
    return groups;
  }, [filteredTasks]);

  const tomatoVisibleStatuses = useMemo(() => {
    const known = TOMATO_STATUS_ORDER.filter((status) => tomatoTasksByStatus.has(status));
    const extra = [...tomatoTasksByStatus.keys()].filter((status) => !TOMATO_STATUS_ORDER.includes(status));
    return [...known, ...extra];
  }, [tomatoTasksByStatus]);

  useEffect(() => {
    if (!detailTask || detailTask.projectId !== "tomato") return;
    const itemKey = tomatoItemKeyFromTask(detailTask);
    const conversationProjectId = itemKey
      ? tomatoConversationByItemKey.get(itemKey)?.[0]?.origin.projectId
      : null;
    const recoveredProjectId = detailTask.repositoryProjectId
      || conversationProjectId
      || tomatoRepositoryProjectId
      || "";
    setTomatoRepositoryProjectId(recoveredProjectId);
    if (!detailTask.repositoryProjectId && conversationProjectId) {
      void updateTaskRequest(detailTask, { repositoryProjectId: conversationProjectId })
        .then((saved) => {
          setTasks((current) => current.map((task) => task.id === saved.id ? saved : task));
        })
        .catch((error) => setActionError(errorMessage(error)));
    }
  }, [detailTask, tomatoConversationByItemKey, tomatoRepositoryProjectId]);

  const activeFilterCount = taskFilterCount(filters);

  const tasksByStatus = useMemo(() => {
    return Object.fromEntries(
      TASK_STATUSES.map((status) => [status, filteredTasks.filter((task) => task.status === status)]),
    ) as Record<TaskStatus, Task[]>;
  }, [filteredTasks]);

  const columnVisibility = columnVisibilityByProject[selectedProjectId];

  const visibleStatuses = useMemo(
    () => TASK_STATUSES.filter((status) => (
      tasksByStatus[status].length === 0
        ? showEmptyColumns
        : (columnVisibility?.[status] ?? true)
    )),
    [columnVisibility, showEmptyColumns, tasksByStatus],
  );

  const hiddenStatuses = useMemo(
    () => TASK_STATUSES.filter((status) => (
      tasksByStatus[status].length === 0
        ? !showEmptyColumns
        : !(columnVisibility?.[status] ?? true)
    )),
    [columnVisibility, showEmptyColumns, tasksByStatus],
  );

  function updateShowEmptyColumns(show: boolean) {
    window.localStorage.setItem(SHOW_EMPTY_COLUMNS_KEY, String(show));
    setShowEmptyColumns(show);
  }

  function updateColumnVisibility(status: TaskStatus, visible: boolean) {
    if (!selectedProjectId || tasksByStatus[status].length === 0) return;
    setColumnVisibilityByProject((current) => {
      const next = {
        ...current,
        [selectedProjectId]: {
          ...current[selectedProjectId],
          [status]: visible,
        },
      };
      window.localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(next));
      return next;
    });
  }

  function selectBoardView(view: BoardView) {
    closeContextMenu();
    setBoardView(view);
  }

  async function saveEditor(
    draft: TaskDraft,
    attachments: File[],
    inlineImages: PendingInlineImage[],
  ) {
    if (!selectedProjectId || !editor) return;
    setActionError(null);
    try {
      const creating = editor.task === null;
      let saved = editor.task
        ? await updateTaskRequest(editor.task, draft)
        : await createTaskRequest(selectedProjectId, draft);
      if (creating) {
        setProjects((current) => current.map((project) => (
          project.id === selectedProjectId
            ? { ...project, issueCount: project.issueCount + 1 }
            : project
        )));
      }
      let uploadedAttachments = 0;
      let failedAttachments = 0;
      if (creating && (attachments.length > 0 || inlineImages.length > 0)) {
        const [results, inlineAttachments] = await Promise.all([
          Promise.allSettled(
            attachments.map((file) => uploadAttachment(saved.id, file)),
          ),
          Promise.all(
            inlineImages.map((image) => uploadAttachment(saved.id, image.file)),
          ),
        ]);
        uploadedAttachments = results.filter((result) => result.status === "fulfilled").length;
        failedAttachments = results.length - uploadedAttachments;
        if (inlineImages.length > 0) {
          const description = resolveInlineMediaMarkdown(
            draft.description,
            inlineImages,
            inlineAttachments,
          );
          saved = await updateTaskRequest(saved, { ...draft, description });
        }
      }
      setTasks((current) => sortTasks([
        ...current.filter((task) => task.id !== saved.id),
        saved,
      ]));
      setEditor(null);
      if (failedAttachments > 0) {
        setActionError(`${saved.identifier} 已创建，但有 ${failedAttachments} 个附件上传失败，可在详情页重试。`);
      }
      if (creating) {
        const totalUploaded = uploadedAttachments + inlineImages.length;
        const message = `${saved.identifier} 已创建${totalUploaded > 0 ? `，已上传 ${totalUploaded} 个附件` : ""}。`;
        pushUndo(message, async () => {
          const candidate = tasksRef.current.find((task) => task.id === saved.id);
          const current = candidate && candidate.version >= saved.version ? candidate : saved;
          await archiveTaskRequest(current);
          setTasks((tasks) => tasks.filter((task) => task.id !== saved.id));
        });
      } else if (editor.task) {
        const previous = editor.task;
        const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
        if (!draft.assigneeTarget || previousAssigneeTarget) {
          pushUndo(
            `${saved.identifier} 已更新。`,
            () => restoreTaskDetails(previous, saved, previousAssigneeTarget),
          );
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        void refreshTasks(selectedProjectId, { quiet: true });
      }
      throw error;
    }
  }

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
    silent = false,
  ) {
    if (movingTaskId) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }

    const destination = tasks.filter((candidate) => candidate.status === status && candidate.id !== task.id);
    const insertionIndex = beforeTaskId
      ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
      : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = tasks.filter((candidate) => candidate.status === status);
    if (
      task.status === status
      && currentOrder.length === desiredOrder.length
      && currentOrder.every((candidate, index) => candidate.id === desiredOrder[index].id)
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }
    const previousTask = destination[targetIndex - 1] ?? null;
    const nextTask = destination[targetIndex] ?? null;
    const sortOrder = previousTask && nextTask
      ? (previousTask.sortOrder + nextTask.sortOrder) / 2
      : previousTask
        ? previousTask.sortOrder + 1024
        : nextTask
          ? nextTask.sortOrder - 1024
          : 1024;
    const previous = task;
    setActionError(null);
    setMovingTaskId(task.id);
    setTasks((current) => sortTasks(current.map((candidate) =>
      candidate.id === task.id ? { ...candidate, status, sortOrder } : candidate,
    )));

    try {
      const moved = await moveTaskRequest(task, status, sortOrder);
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === moved.id ? moved : candidate,
      )));
      const message = task.status === status
        ? `${task.identifier} 排序已调整。`
        : `${task.identifier} 已移至${STATUS_DETAILS[status].label}。`;
      pushUndo(message, async () => {
        const candidate = tasksRef.current.find((current) => current.id === moved.id);
        const current = candidate && candidate.version >= moved.version ? candidate : moved;
        const restored = await moveTaskRequest(current, previous.status, previous.sortOrder);
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === restored.id ? restored : item)));
      }, !silent);
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "That issue changed elsewhere. The board has been refreshed."
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
    }
  }

  function finishTaskDrop(destination: TaskStatus, taskId: string, beforeTaskId: string | null = null) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
    if (!task) return;
    setSettlingTaskId(task.id);
    window.setTimeout(() => {
      setSettlingTaskId((current) => current === task.id ? null : current);
    }, 220);
    void moveTask(task, destination, beforeTaskId, true);
  }

  async function updateTaskProperties(task: Task, changes: Partial<TaskDraft>, message?: string): Promise<Task> {
    const previous = task;
    const { assigneeTarget, ...taskChanges } = changes;
    const optimisticAssignee = assigneeTarget
      ? actorForAssigneeTarget(assigneeTarget, currentUser)
      : task.assignee;
    setActionError(null);
    setTasks((current) => current.map((candidate) =>
      candidate.id === task.id
        ? { ...candidate, ...taskChanges, assignee: optimisticAssignee }
        : candidate,
    ));

    try {
      const updated = await updateTaskRequest(task, { ...taskToDraft(task), ...changes });
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      )));
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          message ?? `${task.identifier} 已更新。`,
          () => restoreTaskDetails(previous, updated, previousAssigneeTarget),
        );
      }
      return updated;
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function mutateTaskRelation(
    action: "add" | "remove",
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) {
    setActionError(null);
    try {
      const result = action === "add"
        ? await addTaskRelation(task, type, relatedTaskId)
        : await removeTaskRelation(task, type, relatedTaskId);
      setTasks((current) => sortTasks(current.map((candidate) => {
        if (candidate.id === result.task.id) return result.task;
        if (candidate.id === result.relatedTask.id) return result.relatedTask;
        return candidate;
      })));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function duplicateTask(task: Task) {
    setActionError(null);
    try {
      const duplicated = await createTaskRequest(task.projectId, {
        ...taskToDraft(task),
        assigneeTarget: assigneeTargetForActor(task.assignee, currentUser),
        developmentContext: null,
      });
      setTasks((current) => sortTasks([...current, duplicated]));
      pushUndo(`${duplicated.identifier} 副本已创建。`, async () => {
        const candidate = tasksRef.current.find((current) => current.id === duplicated.id);
        const current = candidate && candidate.version >= duplicated.version ? candidate : duplicated;
        await archiveTaskRequest(current);
        setTasks((tasks) => tasks.filter((item) => item.id !== duplicated.id));
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function archiveTask(task: Task) {
    setActionError(null);
    try {
      const archived = await archiveTaskRequest(task);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      pushUndo(`${task.identifier} 已归档。`, async () => {
        const restored = await restoreTaskRequest(archived);
        setTasks((current) => sortTasks([
          ...current.filter((candidate) => candidate.id !== restored.id),
          restored,
        ]));
      });
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    }
  }

  async function copyText(text: string, message: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      setAnnouncement(message);
      return;
    } catch {}

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (copied) {
      setAnnouncement(message);
    } else {
      setActionError("无法写入剪贴板。");
    }
  }

  function openThread(threadId: string) {
    if (embedded && window.parent !== window) {
      window.parent.postMessage({
        type: "taskboard:open-thread",
        payload: { threadId },
      }, "*");
      return;
    }

    const normalizedThreadId = threadId.trim();
    void openCodexThreadRequest(normalizedThreadId)
      .then(() => setAnnouncement("已在 Codex 中打开对应对话。"))
      .catch((error) => {
        setActionError(error instanceof Error ? error.message : "无法打开 Codex 对话");
      });
  }

  async function oneClickFixTomatoTask(task: Task) {
    const itemKey = tomatoItemKeyFromTask(task);
    if (!itemKey || task.tomatoAnalysis?.status !== "fixable") return;
    const analysis = task.tomatoAnalysis;
    const storedRepositories = task.tomatoRepositories ?? [];
    const repositoryConfigs = storedRepositories.length > 0
      ? storedRepositories
      : task.repositoryProjectId
        ? [{ projectId: task.repositoryProjectId, developmentBranch: "", rebaseBranch: "" }]
        : [];
    if (repositoryConfigs.length === 0) {
      openTaskDetail(task);
      setAnnouncement("请先为这张绿色卡片添加修复仓库，再点击一键修复。");
      return;
    }
    if (repositoryConfigs.some((config) => !config.rebaseBranch)) {
      openTaskDetail(task);
      setAnnouncement("请为每个修复仓库选择 rebase 分支，再点击一键修复。");
      return;
    }
    setActionError(null);
    try {
      const repairThreads = await Promise.all(repositoryConfigs.map(async (config) => {
        const thread = await createAiChatThread({
          projectId: config.projectId,
          issueId: task.id,
          issueProjectId: "tomato",
          title: `${itemKey} 一键修复`,
          sandbox: "workspace-write",
        });
        const run = await startAiChatTurn(thread.id, {
          message: [
            `请修复番茄 Bug ${itemKey}。`,
            `已确认的问题：${analysis.summary}`,
            `修复方案：${analysis.repairPlan}`,
            analysis.decision ? `已确认决策：${analysis.decision}` : "",
            `修复基线分支（Rebase）：${config.rebaseBranch}`,
            `先读取番茄事项的最新详情并确认状态仍为新建或修复中；然后更新仓库引用，切换到 ${config.rebaseBranch} 并确保本地处于该分支的最新提交，直接在这个分支上完成最小修复，不要创建或切换到其他工作分支。不要修改番茄状态。完成后说明基线分支、更新结果、改动文件和验证结果。`,
          ].filter(Boolean).join("\n\n"),
        });
        return { ...thread, status: "running" as const, currentRun: run };
      }));
      tomatoAiChatRef.current?.showThread(repairThreads[0]);
      const threads = await listAiChatThreadsForProject("tomato");
      setTomatoConversationByItemKey(groupTomatoConversations(threads));
      setAnnouncement(`${itemKey} 已在 ${repositoryConfigs.length} 个仓库启动修复任务。`);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function submitTomatoFix(task: Task) {
    const itemKey = tomatoItemKeyFromTask(task);
    if (!itemKey || task.tomatoAnalysis?.status !== "fixable") return;
    const repositoryConfigs = (task.tomatoRepositories ?? []).length > 0
      ? task.tomatoRepositories ?? []
      : task.repositoryProjectId
        ? [{ projectId: task.repositoryProjectId, developmentBranch: "", rebaseBranch: "" }]
        : [];
    if (repositoryConfigs.length === 0) {
      openTaskDetail(task);
      setAnnouncement("请先为这张绿色卡片添加提交仓库，再点击提交。");
      return;
    }
    if (repositoryConfigs.some((config) => !config.rebaseBranch)) {
      openTaskDetail(task);
      setAnnouncement("请为每个提交仓库选择 rebase 分支，再点击提交。");
      return;
    }
    setActionError(null);
    try {
      const submitThreads = await Promise.all(repositoryConfigs.map(async (config) => {
        const thread = await createAiChatThread({
          projectId: config.projectId,
          issueId: task.id,
          issueProjectId: "tomato",
          title: `${itemKey} 提交修复`,
          sandbox: "danger-full-access",
        });
        const run = await startAiChatTurn(thread.id, {
          dangerFullAccessConfirmed: true,
          message: [
            `请提交并推送番茄 Bug ${itemKey} 的当前修复。`,
            `目标分支名：${itemKey}`,
            `基线分支：${config.rebaseBranch}`,
            `在当前仓库识别属于 ${itemKey} 的修复改动。更新远端引用，以 ${config.rebaseBranch} 的最新提交为基线创建分支 ${itemKey}。尽量不要切换当前工作区的分支，优先使用临时 git worktree，把本卡片的修复改动带入新分支；在新分支提交，commit message 包含 [${itemKey}]，然后 push -u origin ${itemKey}。完成后清理临时 worktree，但保留分支和提交。最后报告提交哈希、远端分支和推送结果。`,
          ].join("\n\n"),
        });
        return { ...thread, status: "running" as const, currentRun: run };
      }));
      tomatoAiChatRef.current?.showThread(submitThreads[0]);
      const threads = await listAiChatThreadsForProject("tomato");
      setTomatoConversationByItemKey(groupTomatoConversations(threads));
      setAnnouncement(`${itemKey} 已在 ${repositoryConfigs.length} 个仓库启动提交和推送。`);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    window.parent.postMessage({ type: "taskboard:expand-sidebar" }, "*");
  }

  function openTaskInThread(task: Task) {
    if (!tomatoWorkboardSkillPath) {
      setActionError("任务面板还没有读取到 tomato-workboard Skill 路径，请刷新后重试。");
      return;
    }
    const worktreePath = task.developmentContext?.type === "worktree"
      ? task.developmentContext.path
      : null;
    const workspacePath = worktreePath
      ?? selectedDeviceWorkspacePath
      ?? developmentScan.workspacePath
      ?? hostContext?.workspacePath;
    const instruction = `Work on the Tomato issue ${task.identifier}: ${task.title}`;
    const prompt = `[$tomato-workboard](${tomatoWorkboardSkillPath}) ${instruction}`;

    if (!embedded || window.parent === window) {
      const query = new URLSearchParams();
      if (workspacePath) query.set("path", workspacePath);
      query.set("prompt", prompt);
      window.location.assign(`codex://new?${query.toString().replace(/\+/g, "%20")}`);
      return;
    }
    if (openingThreadTaskId) return;
    const codexProject = hostContext?.projects?.find((project) => project.id === selectedProject?.id);
    setOpeningThreadTaskId(task.id);
    setActionError(null);
    window.parent.postMessage({
      type: "taskboard:create-thread",
      payload: {
        taskId: task.id,
        identifier: task.identifier,
        instruction,
        skillName: "tomato-workboard",
        skillDisplayName: "Tomato Workboard",
        skillPath: tomatoWorkboardSkillPath,
        codexProjectId: codexProject?.id ?? (selectedProject?.id === "local" ? hostContext?.projectId : selectedProject?.id),
        projectName: selectedProject?.name,
        workspacePath,
        workspaceLabel: worktreePath ? workspaceName(worktreePath) : undefined,
      },
    }, "*");
  }

  function changeProject(projectId: string) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setBoardView("issues");
    setSelectedProjectId(projectId);
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, projectId, null);
    window.history.replaceState(null, "", url);
  }

  function returnToProjectHome() {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setSelectedProjectId("");
    window.localStorage.removeItem(LAST_PROJECT_KEY);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, null, null);
    window.history.replaceState(null, "", url);
    void loadProjectList();
  }

  function toggleFavoriteProject() {
    if (!selectedProjectId) return;
    const shouldFavorite = !favoriteProjectIds.has(selectedProjectId);
    setFavoriteProjectIds((current) => {
      const next = new Set(current);
      if (shouldFavorite) next.add(selectedProjectId);
      else next.delete(selectedProjectId);
      window.localStorage.setItem(FAVORITE_PROJECTS_KEY, JSON.stringify([...next]));
      return next;
    });
    setAnnouncement(`${selectedProject?.name ?? "项目"}${shouldFavorite ? "已收藏。" : "已取消收藏。"}`);
  }

  function moveAnalysisRepository(projectId: string, direction: -1 | 1) {
    const current = orderedCodexRepositories.map((repository) => repository.projectId);
    const index = current.indexOf(projectId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return;
    [current[index], current[nextIndex]] = [current[nextIndex], current[index]];
    setAnalysisRepositoryOrder(current);
    window.localStorage.setItem(ANALYSIS_REPOSITORY_ORDER_KEY, JSON.stringify(current));
    setAnnouncement("已更新分析仓库顺序，下一轮分析会按新顺序逐个排查。");
  }

  async function selectProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) {
        try {
          project = await createProjectRequest({
            id: choice.id,
            name: choice.name,
            workspacePath: null,
          });
          setProjects((current) => [...current, project!]);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
          const nextProjects = await listProjects();
          setProjects(nextProjects);
          project = nextProjects.find((candidate) => candidate.id === choice.id) ?? null;
          if (!project) throw error;
        }
      }
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  async function selectTomatoRepository(projectId: string) {
    if (tomatoRepositoryLoading) return;
    const choice = tomatoRepositoryOptions.find((project) => project.id === projectId);
    if (!choice) return;
    setTomatoRepositoryLoading(true);
    setActionError(null);
    try {
      if (!projects.some((project) => project.id === choice.id)) {
        try {
          const project = await createProjectRequest({
            id: choice.id,
            name: choice.name,
            workspacePath: null,
          });
          setProjects((current) => current.some((item) => item.id === project.id)
            ? current
            : [...current, project]);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
          setProjects(await listProjects());
        }
      }
      setTomatoRepositoryProjectId(choice.id);
      window.localStorage.setItem(TOMATO_REPOSITORY_PROJECT_KEY, choice.id);
      if (detailTask?.projectId === "tomato") {
        const storedRepositories = detailTask.tomatoRepositories ?? [];
        const tomatoRepositories = storedRepositories.some((config) => config.projectId === choice.id)
          ? storedRepositories
          : [
              ...storedRepositories,
              { projectId: choice.id, developmentBranch: "", rebaseBranch: "" },
            ];
        const saved = await updateTaskRequest(detailTask, {
          repositoryProjectId: choice.id,
          tomatoRepositories,
        });
        setTasks((current) => current.map((task) => task.id === saved.id ? saved : task));
      }
      setAnnouncement(`番茄对话仓库已选择：${choice.name}`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setTomatoRepositoryLoading(false);
    }
  }

  async function updateTomatoRepositoryConfigs(configs: Task["tomatoRepositories"]) {
    if (!detailTask || detailTask.projectId !== "tomato") return;
    try {
      const saved = await updateTaskRequest(detailTask, {
        tomatoRepositories: configs,
        repositoryProjectId: configs[0]?.projectId ?? null,
      });
      setTasks((current) => current.map((task) => task.id === saved.id ? saved : task));
      const nextRepositoryProjectId = configs[0]?.projectId ?? "";
      setTomatoRepositoryProjectId(nextRepositoryProjectId);
      if (nextRepositoryProjectId) {
        window.localStorage.setItem(TOMATO_REPOSITORY_PROJECT_KEY, nextRepositoryProjectId);
      } else {
        window.localStorage.removeItem(TOMATO_REPOSITORY_PROJECT_KEY);
      }
      setAnnouncement("修复仓库与分支已保存");
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function toggleTomatoAnalysis(task: Task) {
    try {
      const itemKey = tomatoItemKeyFromTask(task);
      if (!itemKey) return;
      const saved = await setTomatoAnalysisDisabled(itemKey, !task.tomatoAnalysisDisabled);
      setTasks((current) => current.map((item) => item.id === saved.id ? saved : item));
      setAnnouncement(saved.tomatoAnalysisDisabled
        ? `${tomatoItemKeyFromTask(saved)} 已暂停自动分析`
        : `${tomatoItemKeyFromTask(saved)} 已恢复自动分析`);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }


  function renderAnalysisRepositoryList() {
    return (
      <ol className="analysis-repository-order-list">
        {orderedCodexRepositories.map((repository, index) => (
          <li key={repository.projectId} className="analysis-repository-order-item">
            <span className="analysis-repository-order-index">{index + 1}</span>
            <span className="analysis-repository-order-copy">
              <strong>{repository.name}</strong>
              <span title={repository.workspacePath}>{repository.workspacePath}</span>
              <small>{repository.currentBranch ? `当前分支：${repository.currentBranch}` : "未检测到当前分支"} · {repository.branches.length} 个本地分支</small>
            </span>
            <span className="analysis-repository-order-actions">
              <button
                type="button"
                aria-label={`将 ${repository.name} 上移`}
                disabled={index === 0}
                onClick={() => moveAnalysisRepository(repository.projectId, -1)}
              >
                上移
              </button>
              <button
                type="button"
                aria-label={`将 ${repository.name} 下移`}
                disabled={index === orderedCodexRepositories.length - 1}
                onClick={() => moveAnalysisRepository(repository.projectId, 1)}
              >
                下移
              </button>
            </span>
          </li>
        ))}
      </ol>
    );
  }

  const contextName = workspaceName(hostContext?.workspacePath);
  const headerProjectName = selectedProject?.name ?? "任务面板";
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <div className={`app-shell${embedded ? " embedded" : ""}${isTomatoBoard ? " tomato-board" : ""}`} style={appShellStyle}>
      {taskboardMetadata && (
        <LocalRealtimeSync
          selectedProjectId={selectedProjectId}
          detailTaskId={detailTaskId}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshWorkflowOptions={refreshWorkflowOptions}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
        />
      )}
      {!embedded && !isTomatoBoard && (
        <aside className="app-nav" aria-label="工作台导航">
          <div className="brand-row">
            <span className="brand-mark" aria-hidden="true"><LinearIcon name="project" /></span>
            <span>任务面板</span>
          </div>

          <nav className="primary-nav" aria-label="Views">
            <span className="nav-label">工作区</span>
            <button className="nav-item active" type="button" aria-current="page">
              <span className="nav-glyph" aria-hidden="true">
                <LinearIcon name="myIssues" />
              </span>
              议题
              <span className="nav-count">{tasks.length}</span>
            </button>
          </nav>

          <div className="project-nav">
            <span className="nav-label">项目</span>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`project-nav-item${selectedProjectId === project.id ? " active" : ""}`}
                onClick={() => changeProject(project.id)}
              >
                <span className="project-dot" aria-hidden="true" />
                <span>{project.name}</span>
              </button>
            ))}
          </div>

          <div className="nav-spacer" />
          <div className="nav-footer">
            <div className={`connection connection-${connection}`}>
              <span aria-hidden="true" />
              {connection === "live" ? "实时同步" : "正在重新连接…"}
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <span aria-hidden="true"><LinearIcon name={theme === "dark" ? "sun" : "moon"} /></span>
              {theme === "dark" ? "浅色模式" : "深色模式"}
            </button>
          </div>
        </aside>
      )}

      <main className="workspace">
        {selectedProjectId ? (
          <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
              {detailTask && (
                <button
                  className="detail-back-button"
                  type="button"
                  aria-label="返回议题看板"
                  title="返回议题看板 (Esc)"
                  onClick={closeTaskDetail}
                >
                  <LinearIcon name="chevronLeft" />
                </button>
              )}
              {embedded && hostContext?.sidebarCollapsed && (
                <button
                  className="detail-back-button codex-sidebar-expand-button"
                  type="button"
                  aria-label="展开 Codex 侧边栏"
                  title="展开侧边栏"
                  onClick={expandCodexSidebar}
                >
                  <LinearIcon name="codexSidebarExpand" />
                </button>
              )}
              {selectedProjectId && !isTomatoBoard && (
                <button
                  className="detail-back-button project-home-button"
                  type="button"
                  aria-label="返回项目首页"
                  title="返回项目首页"
                  onClick={returnToProjectHome}
                >
                  <LinearIcon name="home" />
                  <span>首页</span>
                </button>
              )}
              {selectedProjectId && !isTomatoBoard && <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>}
              {isTomatoBoard ? (
                <>
                  <span className="project-avatar" aria-hidden="true">番</span>
                  <span className="project-name">番茄工作台</span>
                </>
              ) : selectedProjectId ? (
                <div className="header-project-switcher" data-project-switcher>
                  <button
                    className="header-project-button"
                    type="button"
                    aria-label="切换项目"
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    onClick={() => setProjectMenuOpen((current) => !current)}
                  >
                    <span className="project-avatar" aria-hidden="true">
                      {headerProjectName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="project-name">{headerProjectName}</span>
                    <LinearIcon className="project-switcher-chevron" name="chevronDown" />
                  </button>
                  {projectMenuOpen && (
                    <div className="header-project-menu" role="menu" aria-label="项目">
                      <span>切换项目</span>
                      {projectChoices.map((project) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={project.id === selectedProjectId}
                          disabled={openingProjectId !== null}
                          key={project.id}
                          onClick={() => {
                            if (project.id === selectedProjectId) setProjectMenuOpen(false);
                            else void selectProject(project);
                          }}
                        >
                          <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
                          <span>{project.name}</span>
                          {favoriteProjectIds.has(project.id) && <span className="project-menu-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>}
                          {project.id === selectedProjectId && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <span className="project-avatar" aria-hidden="true">
                    {headerProjectName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="project-name">{headerProjectName}</span>
                </>
              )}
              {!selectedProjectId && (
                <>
                  <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>
                  <strong>项目</strong>
                </>
              )}
              {!detailTask && selectedProjectId && !isTomatoBoard && (
                <button
                  className={`favorite-button${favoriteProjectIds.has(selectedProjectId) ? " active" : ""}`}
                  type="button"
                  aria-label={favoriteProjectIds.has(selectedProjectId) ? "取消收藏项目" : "收藏项目"}
                  aria-pressed={favoriteProjectIds.has(selectedProjectId)}
                  title={favoriteProjectIds.has(selectedProjectId) ? "取消收藏" : "收藏项目"}
                  onClick={toggleFavoriteProject}
                >
                  <LinearIcon className="favorite-icon" name="favorite" />
                </button>
              )}
              {!detailTask && selectedProjectId && !isTomatoBoard && embedded && contextName && <span className="codex-context">{contextName}</span>}
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            <button
              className="icon-button page-reload-button"
              type="button"
              aria-label="重载页面"
              title="重载页面"
              onClick={() => window.location.reload()}
            >
              重载
            </button>
            {isTomatoBoard && !detailTask && (
              <button
                className="icon-button header-repository-button"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={analysisRepositoryDialogOpen}
                aria-label="仓库管理"
                title="管理番茄 Bug 分析仓库"
                onClick={() => setAnalysisRepositoryDialogOpen(true)}
              >
                仓库管理
              </button>
            )}
            {selectedProjectId && !isTomatoBoard && boardView === "issues" && (
              <button
                className="icon-button header-create-button"
                type="button"
                onClick={() => setEditor({ task: null, status: "backlog" })}
                aria-label="新建议题"
                title="新建议题 (C)"
              >
                <LinearIcon name="plus" />
              </button>
            )}
          </div>
          </header>
        ) : (
          <div ref={dragRegionRef} className="home-window-drag-region" aria-hidden="true" />
        )}

        {analysisRepositoryDialogOpen && isTomatoBoard && !detailTask && (
          <div
            className="analysis-repository-dialog-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setAnalysisRepositoryDialogOpen(false);
            }}
          >
            <section
              className="analysis-repository-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="analysis-repository-dialog-heading"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="analysis-repository-dialog-heading">
                <div>
                  <span>番茄 Bug 分析</span>
                  <h2 id="analysis-repository-dialog-heading">仓库管理</h2>
                  <p>按这里的顺序依次取证；前一个仓库证据不足时才会继续检查下一个。</p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭仓库管理"
                  title="关闭"
                  onClick={() => setAnalysisRepositoryDialogOpen(false)}
                >
                  <LinearIcon name="close" />
                </button>
              </header>
              {orderedCodexRepositories.length > 0
                ? renderAnalysisRepositoryList()
                : <p className="analysis-repository-dialog-empty">暂未发现 Codex 本地仓库。</p>}
            </section>
          </div>
        )}

        {selectedProjectId && !detailTask && <div className="board-toolbar">
          {!isTomatoBoard && <div className="view-tabs" aria-label="看板视图">
            <button
              className={`view-tab${boardView === "issues" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "issues"}
              onClick={() => selectBoardView("issues")}
            >
              议题看板
            </button>
            {SHOW_WORKFLOW_BOARD_ENTRY && (
              <button
                className={`view-tab${boardView === "workflow" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "workflow"}
                onClick={() => selectBoardView("workflow")}
              >
                节点模式
              </button>
            )}
          </div>}
          {boardView === "issues" && <div className="toolbar-tools">
            {isTomatoBoard && (
              <>
                <label className={`search-field tomato-search-field${search ? " has-value" : ""}`} title="搜索标题或 tag (/)" >
                  <LinearIcon className="search-icon" name="search" />
                  <span className="sr-only">搜索标题或 tag</span>
                  <input
                    id="task-search"
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索标题或 tag…"
                  />
                  {!search && <kbd>/</kbd>}
                </label>
                <button
                  className={`icon-button tomato-analysis-start-button${tomatoAnalysisProgress.running ? " is-running" : ""}`}
                  type="button"
                  disabled={tomatoSyncing || tomatoAnalysisStarting}
                  aria-label={tomatoAnalysisStarting ? "正在启动番茄 Bug 分析" : tomatoAnalysisProgress.running ? "查看番茄 Bug 分析过程" : "手动触发番茄 Bug 分析"}
                  aria-busy={tomatoAnalysisStarting}
                  title={tomatoAnalysisProgress.running ? "查看分析过程" : "立即分析番茄 Bug"}
                  onClick={() => tomatoAnalysisProgress.running
                    ? setTomatoAnalysisPanelOpen((open) => !open)
                    : void startTomatoAnalysis()}
                >
                  <LinearIcon name={tomatoAnalysisProgress.running ? "conversation" : "play"} />
                </button>
                <button
                  className="icon-button tomato-sync-button"
                  type="button"
                  disabled={tomatoSyncing}
                  aria-label={tomatoSyncing ? "正在刷新番茄卡片" : "刷新番茄卡片"}
                  aria-busy={tomatoSyncing}
                  title={tomatoSyncing ? "正在通过番茄 CLI 同步…" : "从番茄刷新"}
                  onClick={() => void refreshTomato()}
                >
                  <LinearIcon className={tomatoSyncing ? "tomato-sync-icon spinning" : "tomato-sync-icon"} name="sync" />
                </button>
              </>
            )}
            {!isTomatoBoard && (
              <>
                <label className={`search-field${search ? " has-value" : ""}`} title="搜索议题 (/)" >
                  <LinearIcon className="search-icon" name="search" />
                  <span className="sr-only">搜索议题</span>
                  <input
                    id="task-search"
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索议题…"
                  />
                  {!search && <kbd>/</kbd>}
                </label>
                <TaskFilterMenu
                  tasks={tasks}
                  search={search}
                  labels={availableLabels}
                  filters={filters}
                  onChange={setFilters}
                />
                <BoardSettingsMenu
                  showEmptyColumns={showEmptyColumns}
                  onShowEmptyColumnsChange={updateShowEmptyColumns}
                />
                {(search || activeFilterCount > 0) && (
                  <button
                    className="clear-filter"
                    type="button"
                    aria-label="清除筛选"
                    title="清除筛选"
                    onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); }}
                  >
                    <LinearIcon name="close" />
                  </button>
                )}
              </>
            )}
          </div>}
        </div>}

        {isTomatoBoard && tomatoAnalysisProgress.running && !detailTask && (
          <div className="tomato-analysis-progress" role="status" aria-live="polite">
          <div className="tomato-analysis-progress-copy">
              <span>AI 分析中</span>
              <strong>{tomatoAnalysisProgress.itemKey ?? "正在读取候选卡片"}</strong>
          </div>
          <button className="tomato-analysis-stop" type="button" onClick={() => void stopTomatoAnalysis()}>
            停止分析
          </button>
          <div className="tomato-analysis-progress-track" aria-hidden="true"><span /></div>
          </div>
        )}

        {isTomatoBoard && tomatoAnalysisPanelOpen && !detailTask && (
          <aside className="tomato-analysis-process" aria-label="Codex 分析过程">
            <header>
              <div><span>Codex 分析过程</span><strong>{tomatoAnalysisProgress.itemKey ?? "准备候选卡片"}</strong></div>
              <div className="tomato-analysis-process-actions">
                {tomatoAnalysisProgress.running && <button type="button" className="tomato-analysis-stop" onClick={() => void stopTomatoAnalysis()}>停止分析</button>}
                {!tomatoAnalysisProgress.running && <button type="button" className="tomato-analysis-restart" disabled={tomatoAnalysisStarting} onClick={() => void startTomatoAnalysis()}>重新分析</button>}
                <button type="button" className="icon-button" aria-label="关闭分析过程" onClick={() => setTomatoAnalysisPanelOpen(false)}><LinearIcon name="close" /></button>
              </div>
            </header>
            <div className="tomato-analysis-process-events">
              {tomatoAnalysisProgress.messages.length > 0
                ? tomatoAnalysisProgress.messages.map((message) => <article key={message.at} className="is-assistant"><span>关键进度</span><p>{message.content}</p></article>)
                : tomatoAnalysisEvents.filter((event) => event.role === "assistant" || event.role === "error").length === 0
                  ? <p>正在等待关键进度…</p>
                  : tomatoAnalysisEvents.filter((event) => event.role === "assistant" || event.role === "error").map((event) => (
                  <article key={event.id} className={`is-${event.role}`}>
                    <span>{event.role === "assistant" ? "Codex 结论" : "错误"}</span>
                    <p>{event.content}</p>
                  </article>
                ))}
            </div>
          </aside>
        )}

        {(loadError || actionError) && (
          <div className="error-banner" role="alert">
            <span className="error-mark" aria-hidden="true"><LinearIcon name="alert" /></span>
            <div><strong>工作台需要处理</strong><p>{actionError ?? loadError}</p></div>
            <div className="error-actions">
              <button type="button" onClick={() => void copyError()}>
                {errorCopied ? "已复制" : "复制"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setActionError(null);
                  if (!actionError) {
                    if (selectedProjectId) void refreshTasks(selectedProjectId);
                    else void loadProjectList();
                  }
                }}
              >
                {actionError ? "关闭" : "重试"}
              </button>
            </div>
          </div>
        )}

        {!selectedProjectId ? (
          <section className="project-home">
            <div className="project-home-heading">
              <span>任务面板</span>
              <h1>选择项目</h1>
              <p>从 Codex 项目开始，或继续使用之前保存的项目。</p>
            </div>
            {projectsLoading ? (
              <div className="project-grid project-grid-loading" aria-label="正在加载项目" aria-busy="true">
                <span /><span /><span />
              </div>
            ) : projectChoices.length > 0 ? (
              <div className="project-home-groups">
                {[
                  { id: "with-issues", title: "已有议题", projects: projectsWithIssues },
                  { id: "without-issues", title: "尚未添加议题", projects: projectsWithoutIssues },
                ].map((group) => (
                  <section className="project-home-group" key={group.id} aria-labelledby={`project-group-${group.id}`}>
                    <div className="project-group-heading">
                      <h2 id={`project-group-${group.id}`}>{group.title}</h2>
                      <span>{group.projects.length}</span>
                    </div>
                    {group.projects.length > 0 ? (
                      <div className="project-grid">
                        {group.projects.map((project) => (
                          <div className="project-card" key={project.id}>
                            <button
                              className="project-card-open"
                              type="button"
                              disabled={openingProjectId !== null}
                              onClick={() => void selectProject(project)}
                            >
                              <span className="project-card-avatar" aria-hidden="true">
                                {project.name.slice(0, 1).toUpperCase()}
                              </span>
                              <span className="project-card-copy">
                                <strong>{project.name}</strong>
                                <span>
                                  {project.inCodex ? "Codex 项目" : "已保存的项目"}
                                  {project.issueCount > 0 ? ` · ${project.issueCount} 个议题` : ""}
                                </span>
                              </span>
                              {favoriteProjectIds.has(project.id) && <span className="project-card-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>}
                              <span className="project-card-action" aria-hidden="true">
                                {openingProjectId === project.id ? "正在打开…" : <LinearIcon name="chevronRight" />}
                              </span>
                            </button>
                            <label className="project-card-directory">
                              <LinearIcon name="folder" />
                              <input
                                key={deviceWorkspacePaths[project.id] ?? ""}
                                type="text"
                                defaultValue={deviceWorkspacePaths[project.id] ?? ""}
                                placeholder="设置此设备的项目目录"
                                aria-label={`${project.name} 在此设备上的项目目录`}
                                onBlur={(event) => rememberDeviceWorkspacePath(project.id, event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") event.currentTarget.blur();
                                }}
                              />
                            </label>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="project-group-empty">暂无项目</p>
                    )}
                  </section>
                ))}
              </div>
            ) : (
              <div className="project-home-empty">
                <span className="empty-orbit" aria-hidden="true"><i /><i /></span>
                <h2>还没有项目</h2>
                <p>在 Codex 中创建项目后，再打开任务面板。</p>
              </div>
            )}
          </section>
        ) : detailTask && selectedProject && isTomatoBoard ? (
          <TomatoTaskDetail
            task={detailTask}
            tomatoConfig={taskboardMetadata?.tomato}
            onAgentTransition={async (itemKey, targetStatus) => (
              await tomatoAiChatRef.current?.startSkillAction({
                skillId: "tomato-bug-transition",
                message: `请使用 tomato-bug-transition skill，将番茄事项 ${itemKey} 流转到「${targetStatus}」。先读取事项详情和当前卡片的对话、评论及修复记录，按 skill 补齐必填字段；如果业务事实不足，先向我确认。完成流转后回读事项状态并验证。`,
              }) ?? false
            )}
            onTransitionComplete={async () => {
              await Promise.all([
                refreshTasks("tomato", { quiet: true }),
                refreshProjectList(),
              ]);
            }}
            onExternalLinkFallback={(url) => void copyText(url, "番茄链接已复制")}
            onCopyLink={(url) => void copyText(url, "番茄链接已复制")}
            onError={setActionError}
            onAnnounce={setAnnouncement}
            repositoryOptions={tomatoRepositoryOptions}
            repositoryConfigs={(detailTask.tomatoRepositories ?? []).length > 0
              ? detailTask.tomatoRepositories ?? []
              : detailTask.repositoryProjectId
                ? [{ projectId: detailTask.repositoryProjectId, developmentBranch: "", rebaseBranch: "" }]
                : []}
            onRepositoryConfigsChange={(configs) => void updateTomatoRepositoryConfigs(configs)}
            onToggleAnalysis={() => void toggleTomatoAnalysis(detailTask)}
            onOneClickFix={() => void oneClickFixTomatoTask(detailTask)}
            onSubmitFix={() => void submitTomatoFix(detailTask)}
            conversation={(
              <AiChat
                ref={tomatoAiChatRef}
                available={localAiChatAvailable}
                projectId={selectedProjectId || null}
                issueId={detailTaskId}
                issueIdentifier={tomatoItemKeyFromTask(detailTask)}
                repositoryProjectId={tomatoRepositoryProjectId || null}
                repositoryOptions={tomatoRepositoryOptions}
                repositoryLoading={tomatoRepositoryLoading}
                onRepositoryChange={(projectId) => void selectTomatoRepository(projectId)}
                hideRepositoryPicker
                inline
                onOpenThread={openThread}
              />
            )}
          />
        ) : detailTask && selectedProject ? (
          <TaskDetail
            key={detailTask.id}
            task={detailTask}
            tasks={tasks}
            currentUser={currentUser}
            availableLabels={availableLabels}
            workflows={workflowOptions}
            developmentScan={developmentScan}
            developmentScanLoading={developmentScanLoading}
            commentsRevision={commentsRevision}
            attachmentsRevision={attachmentsRevision}
            onUpdate={(current, changes) => updateTaskProperties(current, changes)}
            onOpenTask={openTaskDetail}
            onAddRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("add", current, type, relatedTaskId)
            )}
            onRemoveRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("remove", current, type, relatedTaskId)
            )}
            onOpenThread={openThread}
            onOpenInThread={openTaskInThread}
            openingThread={openingThreadTaskId === detailTask.id}
            onError={setActionError}
            onAnnounce={setAnnouncement}
          />
        ) : boardView === "workflow" ? (
          <Suspense fallback={<div className="workflow-board-loading">正在打开节点模式…</div>}>
            <WorkflowBoard
              key={selectedProject?.id ?? "local"}
              projectId={selectedProject?.id ?? "local"}
              projectName={selectedProject?.name ?? "当前项目"}
              workspacePath={
                selectedDeviceWorkspacePath
                ?? developmentScan.workspacePath
                ?? hostContext?.workspacePath
              }
              revision={workflowRevision}
              onWorkflowsChange={setWorkflowOptions}
            />
          </Suspense>
        ) : tasksLoading && !hasLoadedTasks ? (
          <div className="loading-board" aria-label="Loading issues" aria-busy="true">
            {TASK_STATUSES.map((status) => (
              <div className="loading-column" key={status}>
                <span /><div /><div />
              </div>
            ))}
          </div>
        ) : (
          <div className="board-scroll" aria-label="Issue board">
            <div className="board">
              {filteredTasks.length === 0 && tasks.length > 0 && !showEmptyColumns && (
                <section className="page-empty filter-empty board-filter-empty">
                  <span className="empty-search" aria-hidden="true"><LinearIcon name="search" /></span>
                  <h2>没有匹配的议题</h2>
                  <p>请更换搜索词，或移除一个筛选条件。</p>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); }}
                  >
                    清除筛选
                  </button>
                </section>
              )}
              {isTomatoBoard ? tomatoVisibleStatuses.map((status) => (
                <TomatoStatusColumn
                  key={status}
                  status={status}
                  tomatoConfig={taskboardMetadata?.tomato}
                  tasks={tomatoTasksByStatus.get(status) ?? []}
                  contextMenuTaskId={contextMenu?.taskId ?? null}
                  onEdit={openTaskDetail}
                  onCopyLink={(url) => void copyText(url, "番茄卡片链接已复制。")}
                  conversationByItemKey={tomatoConversationByItemKey}
                  onToggleAnalysis={(task) => void toggleTomatoAnalysis(task)}
                />
              )) : visibleStatuses.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  statusIndex={TASK_STATUSES.indexOf(status)}
                  tasks={tasksByStatus[status]}
                  isDropTarget={dropTarget === status}
                  draggedTaskId={draggedTaskId}
                  draggedTaskHeight={draggedTaskHeight}
                  movingTaskId={movingTaskId}
                  settlingTaskId={settlingTaskId}
                  contextMenuTaskId={contextMenu?.taskId ?? null}
                  onCreate={(initialStatus) => setEditor({ task: null, status: initialStatus })}
                  onEdit={openTaskDetail}
                  onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
                  onMove={(task, destination) => void moveTask(task, destination)}
                  onDragStart={(task, height) => {
                    setDraggedTaskId(task.id);
                    setDraggedTaskHeight(height);
                    setDropTarget(task.status);
                  }}
                  onDragEnd={() => {
                    setDraggedTaskId(null);
                    setDraggedTaskHeight(0);
                    setDropTarget(null);
                  }}
                  onDragEnter={setDropTarget}
                  onDrop={finishTaskDrop}
                  onOpenThread={openThread}
                  onHide={(hiddenStatus) => updateColumnVisibility(hiddenStatus, false)}
                />
              ))}
              {!isTomatoBoard && hiddenStatuses.length > 0 && (
                <HiddenColumns
                  statuses={hiddenStatuses}
                  counts={Object.fromEntries(
                    TASK_STATUSES.map((status) => [status, tasksByStatus[status].length]),
                  ) as Record<TaskStatus, number>}
                  dropTarget={dropTarget}
                  onDragTargetChange={setDropTarget}
                  onDrop={(destination, taskId) => finishTaskDrop(destination, taskId)}
                  onShow={(shownStatus) => updateColumnVisibility(shownStatus, true)}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {editor && (
        <TaskEditor
          key={editor.task?.id ?? `new-${editor.status}`}
          task={editor.task}
          initialStatus={editor.status}
          labels={availableLabels}
          workflows={workflowOptions}
          currentUser={currentUser}
          developmentScan={developmentScan}
          developmentScanLoading={developmentScanLoading}
          onCancel={() => setEditor(null)}
          onSave={saveEditor}
        />
      )}

      {contextMenu && contextMenuTask && (
        <TaskContextMenu
          task={contextMenuTask}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          labels={availableLabels}
          onClose={closeContextMenu}
          onEdit={openTaskDetail}
          onStatusChange={(task, status) => void moveTask(task, status)}
          onPriorityChange={(task, nextPriority) => void updateTaskProperties(
            task,
            { priority: nextPriority },
            `${task.identifier} 优先级已更新。`,
          ).catch(() => {})}
          onLabelsChange={(task, labels) => void updateTaskProperties(
            task,
            { labels },
            `${task.identifier} 标签已更新。`,
          ).catch(() => {})}
          onDuplicate={(task) => void duplicateTask(task)}
          onCopy={(text, message) => void copyText(text, message)}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
        />
      )}

      {!isTomatoBoard && (
        <AiChat
          available={localAiChatAvailable}
          projectId={selectedProjectId || null}
          issueId={detailTaskId}
          onOpenThread={openThread}
        />
      )}

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {undoNotice && (
        <div
          className="toast undo-toast"
          role="status"
          onAnimationEnd={() => setUndoNotice((current) => current?.id === undoNotice.id ? null : current)}
        >
          <span className="toast-check" aria-hidden="true"><LinearIcon name="check" /></span>
          <span className="undo-toast-message">{undoNotice.message}</span>
          <button type="button" onClick={() => void performUndo()}>
            撤回 <kbd>{undoShortcut}</kbd>
          </button>
        </div>
      )}
      {announcement && (
        <div className="toast" role="status" onAnimationEnd={() => setAnnouncementValue("")}>
          <span aria-hidden="true"><LinearIcon name="check" /></span>{announcement}
        </div>
      )}
      {draggedTaskId && <div className="drag-hint" aria-hidden="true">拖到目标位置后松开</div>}
    </div>
  );
}


export function App() {
  const [session, setSession] = useState<TomatoSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSession = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      setSession(await getTomatoSession(signal));
      setError(null);
    } catch (nextError) {
      if (!(nextError instanceof Error && nextError.name === "AbortError")) {
        setError(nextError instanceof Error ? nextError.message : "无法读取 Gitee 登录状态。");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshSession(controller.signal);
    const handleAuthRequired = () => {
      setSession(null);
      setError("Gitee 登录状态已失效，请重新登录。");
      setLoading(false);
    };
    window.addEventListener("tomato-auth-required", handleAuthRequired);
    return () => {
      controller.abort();
      window.removeEventListener("tomato-auth-required", handleAuthRequired);
    };
  }, [refreshSession]);

  const handleLogin = useCallback(async (token: string) => {
    setBusy(true);
    try {
      const nextSession = await loginTomato(token);
      setSession(nextSession);
      setError(null);
      return nextSession;
    } finally {
      setBusy(false);
    }
  }, []);

  const handleSwitchContext = useCallback(async (contextId: string) => {
    setBusy(true);
    try {
      const nextSession = await switchTomatoContext(contextId);
      setSession(nextSession);
      setError(null);
      return nextSession;
    } finally {
      setBusy(false);
    }
  }, []);

  if (loading) {
    return <main className="tomato-auth-shell"><div className="tomato-auth-loading">正在检查 Gitee CLI 登录状态…</div></main>;
  }
  if (session?.authenticated !== true || !session.context) {
    return (
      <TomatoLoginPage
        session={session}
        error={error}
        busy={busy}
        onLogin={handleLogin}
        onSwitchContext={handleSwitchContext}
      />
    );
  }
  return <TaskboardApp />;
}
