# MCP 配置说明（可选）

本项目的番茄同步和状态流转使用本机 `gitee` CLI，不需要 Tomato MCP。MCP 只用于 Codex 的其他工作流，项目不会读取、保存或转发 MCP token。

## Tomato MCP（可选）

如果你希望在 Codex 中直接调用 Tomato MCP，请把服务配置到用户自己的 Codex 配置文件（通常是 `~/.codex/config.toml`）：

```toml
[mcp_servers.tomato]
url = "https://your-tomato-mcp.example/mcp"
http_headers = { Authorization = "Bearer REPLACE_WITH_TOMATO_TOKEN" }
```

真实 URL、请求头名称和认证方式以 MCP 服务提供方文档为准。这个配置不会被项目同步链路使用。

## Code MCP（可选）

Code MCP 不是本项目的固定依赖。只有需要代码搜索或代码操作的 Codex 工作流才需要配置：

```toml
[mcp_servers.code]
type = "http"
url = "https://your-code-mcp.example/mcp"

[mcp_servers.code.http_headers]
Private-Token = "REPLACE_WITH_CODE_TOKEN"
```

服务名、URL 和请求头仅作为配置形状示例，请按实际服务修改。

## 检查 Codex 配置

```bash
codex mcp list
```

不要把下面内容提交到项目：

- 真实 MCP token；
- 真实 MCP URL 中的账号信息；
- `~/.codex/config.toml`；
- 包含凭证的 `.env`。

## 番茄 CLI 登录

番茄同步所需的认证不在本文档配置，而是在本机 CLI 中完成：

```bash
gitee auth login \
  --host https://osc.gitee.work \
  --token '<你的 PAT>'
gitee context switch <your-context>
```

如果需要卡片外链，请在项目 `.env` 中设置 `TOMATO_TENANT=<your-tenant>`。Bug 分析默认自动读取当前 Codex 的 local-projects 仓库；如果需要覆盖顺序，再设置：

```env
TOMATO_ANALYSIS_REPOSITORIES=/absolute/path/to/repository-a,/absolute/path/to/repository-b
```

CLI 登录信息由 `gitee` 自己保存；项目只执行 CLI 命令，不接触 token。
