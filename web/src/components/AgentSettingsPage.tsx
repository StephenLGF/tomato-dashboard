import { ReloadOutlined } from "@ant-design/icons";
import { Button, Card, Empty, Flex, Result, Space, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { listAgentRuntimes } from "../api";
import type { AgentRuntimeConfig } from "../types";
import { TopLoadingBar } from "./TopLoadingBar";

const { Paragraph, Text, Title } = Typography;

export function AgentSettingsPage() {
  const [runtimes, setRuntimes] = useState<AgentRuntimeConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    return listAgentRuntimes(signal).then((items) => {
      if (!signal?.aborted) setRuntimes(items);
    }).catch((nextError) => {
      if (!signal?.aborted) setError(nextError instanceof Error ? nextError.message : "无法检查本地 Agent");
    }).finally(() => {
      if (!signal?.aborted) setLoading(false);
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return (
    <div className="utility-page agent-check-page">
      {loading && <TopLoadingBar label="正在检查本地 Agent" />}
      <Flex className="utility-page-heading" align="flex-start" justify="space-between" gap={24}>
        <div>
          <Title level={1}>Agent 检查</Title>
          <Paragraph type="secondary">检查当前机器是否可以直接使用 Codex 或 Claude Code。</Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} disabled={loading} onClick={() => void refresh()}>
          {loading ? "检查中…" : "重新检查"}
        </Button>
      </Flex>

      {error ? (
        <Result status="error" title="检查失败" subTitle={error} extra={<Button onClick={() => void refresh()}>重试</Button>} />
      ) : loading && runtimes.length === 0 ? (
        <div className="agent-check-loading"><Text type="secondary">正在读取本地 Agent 状态…</Text></div>
      ) : runtimes.length === 0 ? (
        <Empty description="没有检查结果" />
      ) : (
        <div className="agent-check-grid">
          {runtimes.map((runtime) => (
            <Card
              className="agent-check-card"
              key={runtime.providerId}
              title={runtime.name}
              extra={<Tag color={runtime.available ? "success" : "error"}>{runtime.available ? "可用" : "不可用"}</Tag>}
            >
              <Space direction="vertical" size={14} style={{ width: "100%" }}>
                <div>
                  <Text type="secondary">检查命令</Text>
                  <Paragraph code copyable={{ text: `${runtime.executable} --version` }}>
                    {runtime.executable} --version
                  </Paragraph>
                </div>
                <div>
                  <Text type="secondary">检查结果</Text>
                  <Paragraph className={runtime.available ? "agent-check-success" : "agent-check-error"}>
                    {runtime.available ? runtime.version || "命令可以执行" : runtime.error}
                  </Paragraph>
                </div>
              </Space>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
