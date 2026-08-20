import type { AiChatThread, Task } from "../types";
import { StatusIcon } from "./BoardColumn";
import { TaskCard } from "./TaskCard";
// @ts-expect-error Shared URL construction is verified by focused node tests.
import { tomatoItemKeyFromTask, tomatoItemUrl } from "../../../shared/tomato-url.mjs";

interface TomatoStatusColumnProps {
  status: string;
  tomatoConfig?: { origin: string; tenant: string };
  tasks: Task[];
  contextMenuTaskId: string | null;
  onEdit: (task: Task) => void;
  conversationByItemKey: ReadonlyMap<string, AiChatThread[]>;
  onToggleAnalysis: (task: Task) => void;
}

function repositoryName(thread: AiChatThread): string {
  const parts = thread.origin.workspacePath.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || thread.origin.projectName;
}

function developmentBranches(threads: AiChatThread[]) {
  const branches = new Map<string, { repository: string; branch: string }>();
  for (const thread of threads) {
    if (!thread.gitBranch) continue;
    const key = `${thread.origin.workspacePath}\0${thread.gitBranch}`;
    if (!branches.has(key)) {
      branches.set(key, {
        repository: repositoryName(thread),
        branch: thread.gitBranch,
      });
    }
  }
  return [...branches.values()];
}

/**
 * Tomato is the source of truth for these status lanes.  Unlike the generic
 * taskboard columns, this view intentionally does not permit local drag/move:
 * doing so would create a misleading local-only status transition.
 */
export function TomatoStatusColumn({
  status,
  tomatoConfig,
  tasks,
  contextMenuTaskId,
  onEdit,
  conversationByItemKey,
  onToggleAnalysis,
}: TomatoStatusColumnProps) {
  return (
    <section className="board-column tomato-status-column" aria-labelledby={`tomato-column-${status}`}>
      <header className="column-header">
        <div className="column-heading">
          <span className="status-icon status-icon-todo"><StatusIcon status="todo" /></span>
          <h2 id={`tomato-column-${status}`}>{status}</h2>
          <span className="task-count" aria-label={`${tasks.length} 个议题`}>{tasks.length}</span>
        </div>
      </header>
      <div className="column-list">
        {tasks.map((task) => {
          const itemKey = tomatoItemKeyFromTask(task) ?? "";
          const itemType = task.description.match(/(?:^|\n)类型：([^\n]+)/)?.[1]?.trim() || "事项";
          const conversations = conversationByItemKey.get(itemKey) ?? [];
          const threadId = conversations.find((thread) => thread.codexThreadId)?.codexThreadId ?? null;
          return <TaskCard
            key={task.id}
            task={task}
            statusIndex={0}
            isDragging={false}
            dragShift={0}
            isMoving={false}
            isSettling={false}
            isContextMenuOpen={contextMenuTaskId === task.id}
            readOnly
            onEdit={onEdit}
            onContextMenu={() => undefined}
            onMove={() => undefined}
            onDragStart={() => undefined}
            onDragEnd={() => undefined}
            onOpenThread={() => onEdit(task)}
            onToggleTomatoAnalysis={onToggleAnalysis}
            externalUrl={tomatoItemUrl(itemKey, tomatoConfig)}
            displayIdentifier={itemKey || task.identifier}
            displayTitle={task.title.replace(/^\[[^\]]+\]\s*/, "")}
            hideAssignee
            compactProperties={{
              itemType,
              creatorName: task.creatorName,
              developmentBranches: developmentBranches(conversations),
              hasConversation: conversations.length > 0,
              conversationActive: conversations.some((thread) => thread.status === "running"),
              threadId,
              tomatoAnalysis: task.tomatoAnalysis,
            }}
          />
        })}
      </div>
    </section>
  );
}
