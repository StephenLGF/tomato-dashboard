import type { MouseEvent } from "react";
import { TASK_STATUSES, type Task, type TaskPriority, type TaskStatus } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级",
};

interface TaskCardProps {
  task: Task;
  statusIndex: number;
  isDragging: boolean;
  dragShift: number;
  isMoving: boolean;
  isSettling: boolean;
  isContextMenuOpen: boolean;
  readOnly?: boolean;
  onEdit: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenThread: (threadId: string) => void;
  onToggleTomatoAnalysis?: (task: Task) => void;
  externalUrl?: string | null;
  displayIdentifier?: string;
  displayTitle?: string;
  hideAssignee?: boolean;
  compactProperties?: {
    itemType: string;
    creatorName: string;
    developmentBranches: Array<{ repository: string; branch: string }>;
    hasConversation: boolean;
    conversationActive: boolean;
    threadId: string | null;
    tomatoAnalysis?: Task["tomatoAnalysis"];
  };
}

export function TaskCard({
  task,
  statusIndex,
  isDragging,
  dragShift,
  isMoving,
  isSettling,
  isContextMenuOpen,
  readOnly = false,
  onEdit,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onOpenThread,
  onToggleTomatoAnalysis,
  externalUrl = null,
  displayIdentifier,
  displayTitle,
  hideAssignee = false,
  compactProperties,
}: TaskCardProps) {
  const cardIdentifier = displayIdentifier ?? task.identifier;
  const cardTitle = displayTitle ?? task.title;
  const dueDate = task.dueDate
    ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(`${task.dueDate}T12:00:00`))
    : null;
  const subIssueTotal = task.relations.subIssues.length;
  const completedSubIssues = task.relations.subIssues.filter((issue) => issue.status === "done").length;
  const activeBlockers = task.relations.blockedBy.filter((issue) => (
    issue.status !== "done" && issue.status !== "canceled"
  )).length;
  const relatedIssueCount = task.relations.related.length;

  function stopThen(callback: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      callback();
    };
  }

  function openExternal(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!externalUrl) return;
    window.location.assign(externalUrl);
  }

  return (
    <article
      className={`task-card priority-${task.priority}${task.tomatoAnalysisDisabled ? " tomato-analysis-paused" : compactProperties?.tomatoAnalysis ? ` tomato-analysis-${compactProperties.tomatoAnalysis.status}` : ""}${compactProperties?.conversationActive ? " is-conversation-active" : ""}${isDragging ? " is-dragging" : ""}${dragShift ? " is-drag-shifted" : ""}${isMoving ? " is-moving" : ""}${isSettling ? " is-settling" : ""}${isContextMenuOpen ? " is-context-open" : ""}`}
      style={dragShift ? { transform: `translate3d(0, ${dragShift}px, 0)` } : undefined}
      draggable={!isMoving && !readOnly}
      aria-labelledby={`task-${task.id}-title`}
      data-task-id={task.id}
      data-drag-shift={dragShift || undefined}
      onContextMenu={(event) => {
        if (readOnly) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(task, { x: event.clientX, y: event.clientY });
      }}
      onDragStart={(event) => {
        if (readOnly) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.setData("application/x-taskboard-task", task.id);
        onDragStart(task, event.currentTarget.offsetHeight);
      }}
      onDragEnd={onDragEnd}
    >
      <button
        className="task-card-open"
        type="button"
        aria-label={`打开 ${cardIdentifier}: ${cardTitle}`}
        onClick={() => onEdit(task)}
      />

      <div className="card-topline">
        <span className="card-reference">
          <span className="task-identifier">{cardIdentifier}</span>
          {task.relations.parent && (
            <>
              <LinearIcon name="chevronRight" />
              <span className="card-parent-title" title={task.relations.parent.title}>
                {task.relations.parent.title}
              </span>
            </>
          )}
        </span>
        {!hideAssignee && <ActorAvatar actor={task.assignee} className="card-assignee-avatar" />}
        {externalUrl && (
          <a
            className="card-external-link"
            href={externalUrl}
            aria-label={`在浏览器打开 ${task.title}`}
            title="在浏览器打开番茄卡片"
            onClick={openExternal}
          >
            <LinearIcon name="openExternal" />
          </a>
        )}
        {compactProperties && onToggleTomatoAnalysis && (
          <button
            className={`tomato-analysis-toggle${task.tomatoAnalysisDisabled ? " is-paused" : ""}`}
            type="button"
            aria-label={task.tomatoAnalysisDisabled ? "恢复自动分析" : "设为人工判断"}
            title={task.tomatoAnalysisDisabled ? "恢复自动分析" : "设为人工判断，不再自动分析"}
            onClick={stopThen(() => onToggleTomatoAnalysis(task))}
          >
            <LinearIcon name="hand" />
          </button>
        )}
        {!readOnly && <div className="card-actions" aria-label="移动议题">
          <button
            className="icon-button compact"
            type="button"
            disabled={statusIndex === 0 || isMoving}
            aria-label="移到上一状态"
            title="移到上一状态"
            onClick={stopThen(() => onMove(task, TASK_STATUSES[statusIndex - 1]))}
          >
            <LinearIcon name="chevronLeft" />
          </button>
          <button
            className="icon-button compact"
            type="button"
            disabled={statusIndex === TASK_STATUSES.length - 1 || isMoving}
            aria-label="移到下一状态"
            title="移到下一状态"
            onClick={stopThen(() => onMove(task, TASK_STATUSES[statusIndex + 1]))}
          >
            <LinearIcon name="chevronRight" />
          </button>
        </div>}
      </div>

      <h3 id={`task-${task.id}-title`}>{cardTitle}</h3>

      <div className="card-properties" aria-label="议题属性">
        {compactProperties ? (
          <>
            <span className="label-chip">{compactProperties.itemType}</span>
            <span className="label-chip creator-chip" title={`创建人：${compactProperties.creatorName}`}>
              创建人：{compactProperties.creatorName}
            </span>
            {compactProperties.conversationActive && (
              <span className="conversation-active-chip" role="status" title="Codex 正在处理这张卡片">
                <span className="conversation-active-dot" aria-hidden="true" />
                对话中
              </span>
            )}
            {compactProperties.developmentBranches.map(({ repository, branch }) => (
              <span
                className="label-chip branch-chip"
                key={`${repository}\0${branch}`}
                title={`开发仓库：${repository}\n开发分支：${branch}`}
              >
                {repository} · {branch}
              </span>
            ))}
            {compactProperties.hasConversation && (
              compactProperties.threadId ? (
                <button
                  className="thread-link"
                  type="button"
                  aria-label={`查看历史对话 ${compactProperties.threadId}`}
                  title="有历史对话"
                  onClick={stopThen(() => onOpenThread(compactProperties.threadId!))}
                >
                  <LinearIcon name="conversation" />
                </button>
              ) : (
                <span className="thread-link" aria-label="有历史对话" title="有历史对话">
                  <LinearIcon name="conversation" />
                </span>
              )
            )}
          </>
        ) : (<>
          <span className={`priority-icon priority-icon-${task.priority}`} title={PRIORITY_LABELS[task.priority]}>
          <LinearPriorityIcon priority={task.priority} />
          </span>
          {activeBlockers > 0 && (
          <span className="blocked-by-count" title={`被 ${activeBlockers} 个未完成议题阻塞`}>
            <LinearIcon name="alert" />
            {activeBlockers}
          </span>
        )}
        {subIssueTotal > 0 && (
          <span className="sub-issue-progress-chip" title={`${completedSubIssues}/${subIssueTotal} 个子议题已完成`}>
            <span className="sub-issue-progress" aria-hidden="true" />
            {completedSubIssues}/{subIssueTotal}
          </span>
        )}
        {relatedIssueCount > 0 && (
          <span className="sub-issue-progress-chip" title={`关联 ${relatedIssueCount} 个事项`}>
            <LinearIcon name="link" /> {relatedIssueCount}
          </span>
        )}
        {task.labels.slice(0, 2).map((label) => (
          <span className="label-chip" key={label}>{label}</span>
        ))}
        {task.labels.length > 2 && (
          <span className="label-more" title={task.labels.slice(2).join(", ")}>+{task.labels.length - 2}</span>
        )}
        {dueDate && (
          <span className="due-date-chip" title={`截止日期 ${task.dueDate}`}>
            <LinearIcon name="calendar" /> {dueDate}
          </span>
        )}
          {task.threadId && (
          <button
            className="thread-link"
            type="button"
            aria-label={`查看对话 ${task.threadId}`}
            title={`查看对话 ${task.threadId}`}
            onClick={stopThen(() => onOpenThread(task.threadId!))}
          >
            <LinearIcon name="conversation" />
          </button>
          )}
        </>)}
      </div>
    </article>
  );
}
