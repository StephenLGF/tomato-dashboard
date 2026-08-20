import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
// @ts-expect-error Shared URL construction is verified by focused node tests.
import { tomatoItemUrl } from "../../../shared/tomato-url.mjs";
import {
  listAttachments,
  listComments,
  listTomatoTransitions,
  transitionTomatoItem,
  type TomatoTransition,
} from "../api";
import type { Task, TaskPriority, TomatoRepositoryConfig } from "../types";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";

interface TomatoTaskDetailProps {
  task: Task;
  onBack: () => void;
  tomatoConfig?: { origin: string; tenant: string };
  conversation: ReactNode;
  onAgentTransition: (itemKey: string, targetStatus: string) => Promise<boolean>;
  onTransitionComplete: () => Promise<void>;
  onError: (message: string | null) => void;
  onAnnounce: (message: string) => void;
  repositoryOptions: Array<{
    id: string;
    name: string;
    workspacePath: string;
    currentBranch: string | null;
    branches: string[];
  }>;
  repositoryConfigs: TomatoRepositoryConfig[];
  onRepositoryConfigsChange: (configs: TomatoRepositoryConfig[]) => void;
  onToggleAnalysis: () => void;
  onOneClickFix: () => void;
  onSubmitFix: () => void;
}

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "未设置优先级",
  urgent: "紧急",
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级",
};

function tomatoMetadata(description: string): Record<string, string> {
  return Object.fromEntries(description.split("\n").flatMap((line) => {
    const separator = line.indexOf("：");
    if (separator <= 0) return [];
    return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]];
  }));
}

const BUG_TYPES = new Set(["Bug", "缺陷", "测试缺陷"]);
const STORY_TYPES = new Set(["Story", "EnablerStory"]);

interface TomatoQuickAction {
  targetStatus: string;
  label: string;
  noFixReason?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "番茄事项流转失败";
}

function exactTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function TomatoTaskDetail({
  task,
  onBack,
  tomatoConfig,
  conversation,
  onAgentTransition,
  onTransitionComplete,
  onError,
  onAnnounce,
  repositoryOptions,
  repositoryConfigs,
  onRepositoryConfigsChange,
  onToggleAnalysis,
  onOneClickFix,
  onSubmitFix,
}: TomatoTaskDetailProps) {
  const metadata = tomatoMetadata(task.description);
  const itemKey = metadata["番茄事项"] || task.title.match(/^\[([^\]]+)\]/)?.[1] || task.identifier;
  const itemType = metadata["类型"] || "";
  const currentStatus = metadata["当前状态"] || "未设置";
  const externalUrl = tomatoItemUrl(itemKey, tomatoConfig);
  const quickActions: TomatoQuickAction[] = BUG_TYPES.has(itemType)
    ? [
        { targetStatus: "修复中", label: "流转到修复中" },
        { targetStatus: "待测试", label: "流转到待测试" },
        { targetStatus: "不修复", label: "无法复现", noFixReason: "无法复现" },
      ]
    : STORY_TYPES.has(itemType)
      ? [
          { targetStatus: "开发中", label: "流转到开发中" },
          { targetStatus: "待测试", label: "流转到待测试" },
        ]
      : [];
  const [transitions, setTransitions] = useState<TomatoTransition[]>([]);
  const [transitionsLoading, setTransitionsLoading] = useState(true);
  const [transitioningTo, setTransitioningTo] = useState<string | null>(null);
  const [commentCount, setCommentCount] = useState(0);
  const [attachmentCount, setAttachmentCount] = useState(0);
  const transitionsByTarget = useMemo(
    () => new Map(transitions.map((transition) => [transition.targetStatus, transition])),
    [transitions],
  );

  useEffect(() => {
    const controller = new AbortController();
    setTransitionsLoading(true);
    void listTomatoTransitions(itemKey, controller.signal)
      .then((nextTransitions) => {
        setTransitions(nextTransitions);
        onError(null);
      })
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") return;
        onError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setTransitionsLoading(false);
      });
    return () => controller.abort();
  }, [currentStatus, itemKey, onError]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      listComments(task.id, controller.signal),
      listAttachments(task.id, controller.signal),
    ]).then(([comments, attachments]) => {
      setCommentCount(comments.length);
      setAttachmentCount(attachments.length);
    }).catch((error) => {
      if (error instanceof Error && error.name === "AbortError") return;
      onError(errorMessage(error));
    });
    return () => controller.abort();
  }, [onError, task.id]);

  function updateRepository(index: number, changes: Partial<TomatoRepositoryConfig>) {
    onRepositoryConfigsChange(repositoryConfigs.map((config, currentIndex) => (
      currentIndex === index ? { ...config, ...changes } : config
    )));
  }

  function addRepository() {
    const selected = new Set(repositoryConfigs.map((config) => config.projectId));
    const next = repositoryOptions.find((option) => !selected.has(option.id));
    if (!next) return;
    onRepositoryConfigsChange([
      ...repositoryConfigs,
      { projectId: next.id, developmentBranch: next.currentBranch ?? "", rebaseBranch: next.currentBranch ?? "" },
    ]);
  }

  function openExternal(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (!externalUrl) return;
    window.location.assign(externalUrl);
  }

  async function transitionTo(action: TomatoQuickAction, requiresAgentPreflight: boolean) {
    if (transitioningTo) return;
    const { targetStatus, noFixReason } = action;
    setTransitioningTo(targetStatus);
    onError(null);
    try {
      if (requiresAgentPreflight) {
        const started = await onAgentTransition(itemKey, targetStatus);
        if (!started) {
          onError("未能启动 Codex 流转，请在对话区重试");
          return;
        }
        onAnnounce(`${itemKey} 已交给 Codex 按番茄流转规则处理`);
        return;
      }
      const result = await transitionTomatoItem(itemKey, targetStatus, { noFixReason });
      await onTransitionComplete();
      onAnnounce(
        result.alreadyInTarget
          ? `${itemKey} 已处于「${targetStatus}」`
          : `${itemKey} 已从「${result.previousStatus}」流转到「${result.currentStatus}」`,
      );
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setTransitioningTo(null);
    }
  }

  const repositoryConfigured = repositoryConfigs.length > 0
    && repositoryConfigs.every((config) => Boolean(config.projectId && config.rebaseBranch));

  function renderRepositorySettings() {
    return (
      <>
        {repositoryConfigs.length === 0 ? (
          <div className="tomato-repository-empty">
            <p>这张卡片还没有配置修复仓库与基线分支。</p>
            <button
              className="button primary tomato-repository-start"
              type="button"
              onClick={addRepository}
              disabled={repositoryOptions.length === 0}
            >
              {repositoryOptions.length === 0 ? "暂无可用仓库" : "开始配置"}
            </button>
          </div>
        ) : (
          <>
            {repositoryConfigs.map((config, index) => {
              const repository = repositoryOptions.find((option) => option.id === config.projectId);
              const branches = repository?.branches ?? [];
              return (
                <div className="tomato-repository-config" key={config.projectId}>
                  <label>
                    <span>仓库</span>
                    <select
                      value={config.projectId}
                      onChange={(event) => {
                        const nextRepository = repositoryOptions.find((option) => option.id === event.target.value);
                        updateRepository(index, {
                          projectId: event.target.value,
                          developmentBranch: nextRepository?.currentBranch ?? "",
                          rebaseBranch: nextRepository?.currentBranch ?? "",
                        });
                      }}
                    >
                      {repositoryOptions.map((option) => (
                        <option
                          value={option.id}
                          key={option.id}
                          disabled={repositoryConfigs.some((item, itemIndex) => (
                            itemIndex !== index && item.projectId === option.id
                          ))}
                        >
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>修复基线分支（Rebase）</span>
                    <select
                      value={config.rebaseBranch}
                      disabled={branches.length === 0}
                      onChange={(event) => updateRepository(index, { rebaseBranch: event.target.value })}
                    >
                      <option value="">选择 rebase 分支</option>
                      {branches.map((branch) => (
                        <option value={branch} key={branch}>
                          {branch}{branch === repository?.currentBranch ? "（当前）" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="tomato-repository-remove"
                    type="button"
                    onClick={() => onRepositoryConfigsChange(repositoryConfigs.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    移除
                  </button>
                </div>
              );
            })}
            <button className="tomato-repository-add" type="button" onClick={addRepository} disabled={repositoryOptions.length <= repositoryConfigs.length}>
              添加仓库
            </button>
          </>
        )}
      </>
    );
  }

  function renderQuickActions() {
    return quickActions.map((action) => {
      const { targetStatus, noFixReason } = action;
      const transition = transitionsByTarget.get(targetStatus);
      const requiresAgentPreflight = transition?.requiresAgentPreflight === true;
      const unavailable = !transition || (transition.disabled && !requiresAgentPreflight && !noFixReason);
      const busy = transitioningTo === targetStatus;
      const disabled = transitionsLoading || Boolean(transitioningTo)
        || currentStatus === targetStatus || unavailable;
      const buttonTitle = currentStatus === targetStatus
        ? `当前已经是「${targetStatus}」`
        : requiresAgentPreflight
          ? `${transition?.disabledReason}；点击后由 Codex 按 skill 补齐并流转`
          : transition?.disabledReason
          || (transitionsLoading ? "正在读取可用流转" : `当前状态无法直接流转到「${targetStatus}」`);
      return (
        <button
          key={targetStatus}
          className="tomato-transition-button"
          type="button"
          disabled={disabled}
          title={buttonTitle}
          onClick={() => void transitionTo(action, requiresAgentPreflight)}
        >
          {busy ? (requiresAgentPreflight ? "正在交给 Codex…" : "流转中…") : action.label}
        </button>
      );
    });
  }

  return (
    <section className="tomato-detail" aria-label={`${itemKey} 番茄事项详情`}>
      <div className="tomato-detail-content">
        <main className="tomato-detail-main">
          <div className="tomato-detail-heading-row">
            <div className="tomato-detail-heading-identity">
              <button className="tomato-detail-back" type="button" onClick={onBack} aria-label="返回工作台" title="返回工作台">
                <LinearIcon name="chevronLeft" />
              </button>
              <span className="tomato-detail-key">{itemKey}</span>
            </div>
            <div className="tomato-detail-heading-actions">
              {renderQuickActions()}
              {externalUrl && (
                <a
                  className="tomato-detail-external-link"
                  href={externalUrl}
                  title="在浏览器中打开番茄事项"
                  aria-label={`在浏览器中打开 ${itemKey}`}
                  onClick={openExternal}
                >
                  <LinearIcon name="openExternal" />
                  <span>打开番茄</span>
                </a>
              )}
            </div>
          </div>

          {task.tomatoAnalysis && (
            <details className={`tomato-detail-analysis tomato-analysis-${task.tomatoAnalysis.status}`}>
              <summary className="tomato-detail-analysis-heading">
                <div>
                  <span>AI 分析结果</span>
                  <h2 id="tomato-analysis-heading">{task.tomatoAnalysis.status === "fixable" ? "方案明确" : task.tomatoAnalysis.status === "needs_human" ? "需人工介入" : "信息不足"}</h2>
                </div>
                <div className="tomato-detail-analysis-heading-meta">
                  {task.tomatoAnalysis.status === "fixable" && (
                    <>
                      <button
                        className="tomato-detail-submit-fix"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onSubmitFix();
                        }}
                      >
                        提交
                      </button>
                      <button
                        className="tomato-detail-one-click-fix"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onOneClickFix();
                        }}
                      >
                        一键修复
                      </button>
                    </>
                  )}
                  <time>{new Date(task.tomatoAnalysis.analyzedAt).toLocaleString("zh-CN")}</time>
                  <LinearIcon name="chevronDown" />
                </div>
              </summary>
              <div className="tomato-detail-analysis-body">
                <section className="tomato-detail-analysis-summary">
                  <h3>分析摘要</h3>
                  <p>{task.tomatoAnalysis.summary}</p>
                </section>
                <section>
                  <h3>处理方案</h3>
                  <p>{task.tomatoAnalysis.repairPlan}</p>
                </section>
                {task.tomatoAnalysis.decision && <section><h3>人工决策</h3><p>{task.tomatoAnalysis.decision}</p></section>}
                {task.tomatoAnalysis.missingInformation && <section><h3>缺失信息</h3><p>{task.tomatoAnalysis.missingInformation}</p></section>}
              </div>
            </details>
          )}

          {!repositoryConfigured && (
            <section className="tomato-repository-setup" aria-labelledby="tomato-repository-setup-heading">
              <div className="tomato-repository-setup-heading">
                <span className="tomato-repository-setup-icon" aria-hidden="true"><LinearIcon name="branch" /></span>
                <div>
                  <span className="tomato-repository-setup-kicker">开始处理前需要一步配置</span>
                  <h2 id="tomato-repository-setup-heading">先配置修复仓库与分支</h2>
                  <p>配置后，新建 Agent 会话即可在对应仓库中工作。</p>
                </div>
              </div>
              <div className="tomato-repository-setup-fields">
                {renderRepositorySettings()}
              </div>
            </section>
          )}

          <section className="tomato-detail-conversations" aria-label="Agent 会话">
            {conversation}
          </section>
        </main>

        <aside className="tomato-detail-sidebar" aria-label="番茄事项属性">
          <h2>卡片信息</h2>
          {repositoryConfigured && (
            <section className="tomato-branch-settings" aria-label="修复基线分支设置">
              <div className="tomato-branch-settings-heading">
                <strong>修复仓库与分支</strong>
                <button type="button" onClick={addRepository} disabled={repositoryOptions.length <= repositoryConfigs.length}>添加仓库</button>
              </div>
              {renderRepositorySettings()}
            </section>
          )}
          <button
            className={`tomato-detail-analysis-toggle${task.tomatoAnalysisDisabled ? " is-paused" : ""}`}
            type="button"
            onClick={onToggleAnalysis}
          >
            {task.tomatoAnalysisDisabled ? "恢复自动分析" : "设为人工判断，不再自动分析"}
          </button>
          <dl className="tomato-detail-metadata">
            <div>
              <dt>状态</dt>
              <dd><span className="tomato-detail-status-dot" aria-hidden="true" />{currentStatus}</dd>
            </div>
            <div>
              <dt>优先级</dt>
              <dd><LinearPriorityIcon priority={task.priority} />{PRIORITY_LABELS[task.priority]}</dd>
            </div>
            <div>
              <dt>类型</dt>
              <dd>{itemType || "未设置"}</dd>
            </div>
            <div>
              <dt>工作区</dt>
              <dd>{metadata["工作区"] || "未设置"}</dd>
            </div>
          </dl>
          <details className="tomato-detail-more">
            <summary>详细信息</summary>
            <dl className="tomato-detail-metadata">
              <div><dt>任务编号</dt><dd>{task.identifier}</dd></div>
              <div><dt>创建者</dt><dd title={`@${task.creatorId}`}>{task.creatorName}</dd></div>
              <div><dt>项目 ID</dt><dd>{task.projectId}</dd></div>
              <div><dt>评论数量</dt><dd>{commentCount}</dd></div>
              <div><dt>附件数量</dt><dd>{attachmentCount}</dd></div>
              <div><dt>数据版本</dt><dd>{task.version}</dd></div>
              <div><dt>创建时间</dt><dd title={exactTime(task.createdAt)}>{exactTime(task.createdAt)}</dd></div>
              <div><dt>更新时间</dt><dd title={exactTime(task.updatedAt)}>{exactTime(task.updatedAt)}</dd></div>
            </dl>
          </details>
        </aside>
      </div>
    </section>
  );
}
