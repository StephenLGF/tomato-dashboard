import { ArrowDownOutlined, ArrowUpOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Flex, Space, Table, Tag, Typography } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listAgentRepositories } from "../api";
import type { CodexRepository } from "../types";
import { TopLoadingBar } from "./TopLoadingBar";

const ORDER_KEY = "taskboard.analysisRepositoryOrder.v1";

function readOrder(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function RepositoryManagementPage() {
  const [repositories, setRepositories] = useState<CodexRepository[]>([]);
  const [order, setOrder] = useState(readOrder);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    return listAgentRepositories(signal).then((items) => {
      if (!signal?.aborted) setRepositories(items);
    }).catch((nextError) => {
      if (!signal?.aborted) setError(nextError instanceof Error ? nextError.message : "无法读取本地仓库");
    }).finally(() => {
      if (!signal?.aborted) setLoading(false);
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const ordered = useMemo(() => {
    const rank = new Map(order.map((workspacePath, index) => [workspacePath, index]));
    return [...repositories].sort((left, right) => (
      (rank.get(left.workspacePath) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.workspacePath) ?? Number.MAX_SAFE_INTEGER)
    ));
  }, [order, repositories]);

  function move(workspacePath: string, direction: -1 | 1) {
    const ids = ordered.map((repository) => repository.workspacePath);
    const index = ids.indexOf(workspacePath);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setOrder(ids);
    window.localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  }

  return (
    <div className="utility-page repository-page">
      {loading && <TopLoadingBar label="正在读取本地仓库" />}
      <Flex className="utility-page-heading" align="flex-start" justify="space-between" gap={24}>
        <div>
          <Typography.Title level={1}>仓库管理</Typography.Title>
          <Typography.Paragraph type="secondary">分析会按这里的顺序逐个仓库取证。</Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} disabled={loading} onClick={() => void refresh()}>
          {loading ? "刷新中…" : "刷新仓库"}
        </Button>
      </Flex>

      {error ? <Empty description={error} /> : (
        <Table<CodexRepository>
          rowKey="workspacePath"
          loading={false}
          pagination={false}
          dataSource={ordered}
          locale={{ emptyText: loading ? "正在读取仓库…" : "暂未发现本地仓库" }}
          columns={[
            {
              title: "来源",
              width: 180,
              render: (_, repository) => (
                <Space wrap>
                  {repository.sources?.includes("codex") && <Tag color="blue">Codex</Tag>}
                  {repository.sources?.includes("claude-code") && <Tag color="purple">Claude Code</Tag>}
                </Space>
              ),
            },
            {
              title: "顺序",
              width: 80,
              render: (_, repository, index) => <Tag>{index + 1}</Tag>,
            },
            {
              title: "仓库",
              render: (_, repository) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>{repository.name}</Typography.Text>
                  <Typography.Text type="secondary" copyable={{ text: repository.workspacePath }}>
                    {repository.workspacePath}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "当前分支",
              width: 220,
              render: (_, repository) => repository.currentBranch
                ? <Tag color="blue">{repository.currentBranch}</Tag>
                : <Typography.Text type="secondary">未检测到</Typography.Text>,
            },
            {
              title: "本地分支",
              width: 110,
              render: (_, repository) => `${repository.branches.length} 个`,
            },
            {
              title: "调整",
              width: 120,
              render: (_, repository, index) => (
                <Space>
                  <Button aria-label={`${repository.name} 上移`} icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => move(repository.workspacePath, -1)} />
                  <Button aria-label={`${repository.name} 下移`} icon={<ArrowDownOutlined />} disabled={index === ordered.length - 1} onClick={() => move(repository.workspacePath, 1)} />
                </Space>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
