# 番茄工作台 for Codex

GitHub：<https://github.com/StephenLGF/tomato-dashboard>

本项目采用 [MIT License](LICENSE)。

将番茄 Team 事项同步为本地看板，并嵌入 Codex 桌面应用。你可以从卡片详情选择开发仓库、创建或继续 Codex 对话，并将可见的对话内容同步回对应事项。

> 当前版本主要面向 macOS。Codex 侧栏通过 Chrome DevTools Protocol（CDP）注入，不是官方公开插件 API；Codex 桌面应用升级后可能需要同步适配。

## 功能

- 按番茄状态展示事项看板
- 通过本机 `gitee` CLI 拉取事项并执行状态流转
- 在卡片详情选择实际开发仓库
- 在卡片内创建、恢复和继续 Codex 对话
- 将 Codex 原生对话中的用户消息和助手回复同步回事项
- 使用本地 SQLite 持久化卡片、仓库选择、评论、附件和对话索引
- 右上角提供“重载”按钮，强制重新加载页面

## 依赖边界

### 番茄 CLI：必需

番茄同步链路不依赖 Tomato MCP。项目通过 `TOMATO_CLI_EXECUTABLE` 调用本机番茄 CLI，默认可执行文件名为 `gitee`。

先安装番茄 CLI，然后在本机完成登录：

```bash
gitee auth login \
  --host https://osc.gitee.work \
  --token '<你的 PAT>'
gitee context switch <your-context>
```

Token 只由 CLI 保存到用户本机配置中，不写入本仓库的 `.env`、SQLite 或浏览器。不同版本的番茄 CLI 可能使用不同的上下文配置，请以实际 CLI 文档为准。

可以用下面的命令确认 CLI 可用和登录状态：

```bash
gitee version
gitee auth status
gitee team item search --page 1 --size 1 --output json
```

其中 `gitee version` 只检查 CLI 是否能执行，`gitee auth status` 只检查认证状态，不会输出 token。

### Tomato MCP：可选

Tomato MCP 不是本项目同步和状态流转的必需依赖。如果你希望在 Codex 的其他工作流中直接调用 Tomato MCP，可以按[可选 MCP 配置说明](docs/mcp-setup.md)配置；不配置也不影响看板通过 CLI 同步。番茄 Bug 手动分析功能读取远端详情和评论时，可以使用当前 Codex 会话中已配置的 Tomato MCP；这不影响同步、查看看板或状态流转。

### Code MCP：可选

Code MCP 不是项目固定依赖。只有需要代码搜索或代码操作的 Codex 工作流才需要配置，配置应放在使用者自己的 Codex 配置中，不要放进本仓库。

## 环境要求

- macOS
- Node.js 22.5 或更高版本
- Codex 桌面应用（使用 `npm run codex` 时）
- 已登录 Codex（使用嵌入式 Codex 对话时）
- 已安装并登录番茄 `gitee` CLI（使用番茄看板时）

## 快速开始

```bash
git clone https://github.com/StephenLGF/tomato-dashboard.git
cd tomato-dashboard
npm install
cp .env.example .env
npm run build
```

通常不需要修改 `.env`。如 CLI 可执行文件不在 `PATH`，可以设置：

```env
TOMATO_CLI_EXECUTABLE=/absolute/path/to/gitee
```

如果使用番茄卡片外链或番茄 Bug 的代码仓库分析，还需要按自己的环境配置租户和候选仓库。候选仓库按配置顺序排查，不再假设某个组织的目录名：

```env
TOMATO_HOST=https://osc.gitee.work
TOMATO_CONTEXT=<your-context>
TOMATO_TENANT=<your-tenant>
TOMATO_ANALYSIS_REPOSITORIES=/absolute/path/to/repository-a,/absolute/path/to/repository-b
```

`TOMATO_ANALYSIS_REPOSITORIES` 支持逗号、分号或换行分隔，也可以写 JSON 数组。第一个仓库证据不足时才检查下一个；不配置时，服务会自动读取当前 Codex 的 local-projects 仓库目录并去重后作为候选，不会猜测 `/Users/...` 等本机路径。

不要在 `.env` 中填写 token，也不要提交 `.env`。番茄 PAT 由本机 `gitee` CLI 保存。

### 安装后诊断

安装依赖后，可以运行只读诊断命令检查项目、CLI、MCP 和 Skill：

```bash
npm run doctor
```

诊断会检查：

- Node.js、npm 和 `package.json` 依赖；
- 服务、前端、环境模板、项目 Skill 和插件清单；
- Codex CLI 以及用户侧 MCP 配置；
- `tomato`、`code` MCP 是否启用；
- `gitee version` 是否可执行；
- `gitee auth status` 是否已登录；
- 仓库内项目级 `tomato-workboard` Skill（无需额外安装到用户目录）。

也可以输出机器可读的 JSON：

```bash
npm run doctor -- --json
```

诊断不会修改项目文件、Codex 配置或 token。Tomato MCP、Code MCP 和番茄 CLI 登录状态属于按使用场景提供的可选检查；缺失时会显示提醒，不会阻止浏览器模式启动。项目 Skill 已随仓库发布，不检查用户级 Skill 安装状态。

### 浏览器模式

```bash
npm run build
npm run taskboard
```

打开 `http://127.0.0.1:47823/`。该模式只启动本地看板，不启动或注入 Codex。

### Codex 集成模式

启动前请退出普通方式启动的 Codex 窗口，然后运行：

```bash
npm run codex
```

命令会：

1. 启动本地工作台服务；
2. 使用仅限回环地址的 CDP 端口启动 Codex；
3. 在 Codex 侧栏注入看板入口；
4. 自动打开番茄工作台。

使用 `Ctrl-C` 停止。首次启动会在 `.data/taskboard.sqlite` 创建本地数据库。

## 使用方式

### 同步番茄事项

打开番茄看板后点击“重载”或看板工具栏中的同步按钮。服务端会执行：

```text
网页 → POST /api/local/tomato/sync
     → TomatoSyncService
     → TomatoCliClient
     → gitee team item search
     → 番茄 Team
     → SQLite 本地缓存
     → 网页读取 /api/projects、/api/tasks
```

同步失败时，请先在终端直接验证 `gitee` 登录状态和 JSON 输出，再检查 `TOMATO_CLI_EXECUTABLE`。

### 流转番茄事项

卡片详情中的状态操作会通过本地 API 查询可用 transition，再调用 `gitee team transition execute`，执行后重新读取事项确认状态。

### 选择开发仓库和继续 Codex

打开卡片后，在对话区域选择开发仓库。选择会写入本地 SQLite，重启服务或 Codex 后仍会回显。

在卡片对话中发送第一条消息后，可打开对应的 Codex 原生任务。在 Codex 中继续工作后，返回番茄工作台即可同步新增对话。本地工作台只保存对话索引和可见事件副本，Codex 原生对话仍由 Codex 自己持久化。

番茄工作台右上角的“仓库管理”按钮会打开仓库弹窗，显示 Codex 当前配置的本地仓库、分支和分析顺序。你可以点击“上移”或“下移”调整顺序，调整结果保存在浏览器本地存储 `taskboard.analysisRepositoryOrder.v1` 中；下一轮 Bug 分析会按照这个顺序逐个取证，前一个仓库证据不足时才继续下一个。

## 技术原理

### Codex 是如何嵌入这个页面的

本项目不是通过 Codex 官方插件 API 嵌入，而是使用“本地 HTTP 服务 + CDP + 用户脚本 + iframe”的方式接入 Codex 桌面应用：

```text
npm run codex
  → scripts/codex-injector.mjs 启动本地工作台服务
  → 通过 macOS open 启动 ChatGPT.app，并附加 CDP 调试端口
  → 通过 CDP Runtime.evaluate 注入 inject/codex-taskboard.user.js
  → 用户脚本在 Codex 侧栏增加“番茄工作台”入口
  → 点击入口后，在 Codex 页面内部挂载本地工作台 iframe
  → iframe 加载 http://127.0.0.1:47823/?host=codex
```

相关代码：

- `scripts/codex-injector.mjs`：启动 Codex、连接 CDP、注入和刷新用户脚本；
- `inject/codex-taskboard.user.js`：查找 Codex 侧栏、创建入口、挂载 iframe，并与 Codex 宿主通信；
- `web/src/App.tsx`：检测 `host=codex`，切换嵌入模式并渲染看板；
- `server/index.mjs`、`server/app.mjs`：提供本地 API 和 SQLite 数据访问。

工作台页面和 Codex 原生页面是两个不同的页面上下文。它们通过 `window.postMessage` 传递有限的宿主上下文和操作请求，例如当前项目、当前对话、打开对话、创建对话和展开侧栏。用户脚本只负责桥接，不把番茄 token 放进网页或 iframe。

右上角的“重载”也是这条链路的一部分：用户脚本销毁当前 iframe，给本地工作台 URL 增加 `__codex_taskboard_refresh` 时间戳，再重新挂载 iframe，从而强制重新加载页面，而不是只刷新 React 状态。

### 页面功能是如何生效的

看板前端不直接访问番茄服务或 Codex 数据文件，典型边界如下：

```text
React 页面
  → web/src/api.ts
  → server/app.mjs 本地 API
  → SQLite / gitee CLI / Codex CLI
  → API 返回结果或 SSE 事件
  → React 更新卡片、详情和对话
```

#### 打开番茄事项链接

1. 同步时，`server/tomato-sync.mjs` 通过 `server/tomato-cli.mjs` 执行 `gitee team item search`；
2. 事项和本地元数据写入 `.data/taskboard.sqlite`，前端通过 `/api/projects`、`/api/tasks` 读取；
3. 打开详情时，`web/src/components/TomatoTaskDetail.tsx` 从事项的 `itemKey` 生成番茄 URL；
4. 点击链接后使用 `window.open(url, "_blank", "noopener,noreferrer")` 打开番茄网页。如果浏览器阻止新窗口，则显示备用链接操作。

URL 生成逻辑集中在 `shared/tomato-url.mjs`，因此页面不会从卡片标题猜测或拼接多个不同格式的 URL。

#### 打开已有 Codex 对话

当卡片已经关联 Codex 对话时，点击“打开对话”会：

```text
详情页 / 对话组件
  → App.tsx 的 openThread(threadId)
  → 嵌入模式下 postMessage("taskboard:open-thread")
  → inject/codex-taskboard.user.js 接收消息
  → 关闭工作台 iframe
  → 点击 Codex 侧栏已有对话，或导航到 /local/:threadId
```

非嵌入模式下，前端也可以调用 `POST /api/local/codex/threads/:id/open`。服务端会执行 `server/app.mjs` 中的打开逻辑，通过操作系统打开 `codex://threads/<threadId>`，然后由 Codex 定位到原生对话。

#### 在详情页直接对话

详情页中的 `AiChat` 组件把对话和当前番茄事项绑定，而不是创建一个无来源的普通聊天：

```text
详情页输入消息
  → AiChat.tsx
  → POST /api/local/ai/threads
      创建或复用关联事项的本地对话线程
  → POST /api/local/ai/threads/:id/turns
      提交消息、Skill 和附件
  → AiChatService.startTurn()
      解析工作区、构造 Codex prompt、启动 Codex app-server/CLI
  → SQLite 保存 run/event
  → GET /api/local/ai/threads/:id/events（SSE）
  → AiChat 实时显示 Codex 回复和执行事件
```

对番茄事项而言，本地线程会保存事项标识、项目、工作区和 Codex 原生线程 ID。后续再次打开详情页时，前端可以恢复同一条对话；服务端还会读取 Codex 本地状态，把原生对话中尚未写入看板的消息补回本地事件表。

因此，“详情页直接对话”与“打开 Codex 原生对话”是两条互补路径：前者在工作台内提交并展示 Codex 回合，后者把用户带回 Codex 原生页面继续操作。

### Codex 对话的生命周期

工作台不会自己实现大模型调用，也不会把 Codex 对话内容发送到番茄服务。它只负责把事项上下文、工作区和用户消息交给本机 Codex，再把结果投影到本地看板。首回合和后续回合的调用方式不同：

```text
首条消息
  → server/ai-chat-process.mjs#spawnCodexAppServerTurn
  → codex app-server --stdio
  → initialize
  → thread/start（threadSource=vscode，ephemeral=false）
  → turn/start
  → 返回 Codex 原生 thread id
  → server/ai-chat.mjs 写入本地线程的 codexThreadId

后续消息
  → codex exec resume --json <codexThreadId> -
  → 继续同一个 Codex 原生线程
```

`threadSource=vscode` 用于让 Codex 将工作台创建的线程视为本地开发工作流线程；`ephemeral=false` 表示线程需要持久化。工作台数据库中的 `codexThreadId` 是关联索引，不是 Codex 对话的替代存储。

### 事件是如何从 Codex 到达页面的

`server/ai-chat-process.mjs` 将 app-server/CLI 输出的线程、回合、助手消息、命令执行、文件变更、MCP 调用、搜索和 Todo 事件转换成统一的工作台事件格式。`AiChatService` 将事件写入 SQLite，并通过本地 SSE 推送；`web/src/api.ts` 创建 `EventSource`，`web/src/aiChatState.ts` 合并快照和增量事件，最后由 `web/src/components/AiChat.tsx` 渲染。

这样做有两个好处：

- 页面不需要理解 Codex CLI 的每一种原始输出格式；
- 即使页面暂时关闭，事件也已经保存在本地，重新打开详情页后可以恢复。

### 宿主桥接和 `postMessage`

嵌入模式下，工作台 iframe 与 Codex 原生页面属于不同的页面上下文，不能直接访问对方的 DOM、React 状态或本地文件。两者只通过 `inject/codex-taskboard.user.js` 中的消息桥通信：

| 消息 | 作用 |
| --- | --- |
| `taskboard:ready` | iframe 加载完成，向宿主请求上下文 |
| `taskboard:host-context` | 宿主传入当前项目、当前原生线程和主题 |
| `taskboard:open-thread` | 工作台请求宿主打开 Codex 对话 |
| `taskboard:open-review` | 工作台请求宿主打开 Codex Review 视图 |
| `taskboard:create-thread` | 从事项详情把任务上下文带到 Codex 新对话 |
| `taskboard:expand-sidebar` | 请求展开 Codex 原生侧栏 |

这种边界使 `web/` 可以作为普通浏览器页面运行，也使番茄账号信息不会因为 iframe 被暴露给 Codex 页面。

### 新建 Codex 对话的两条入口

工作台支持两种创建方式：

1. **详情页直接对话**：消息先进入工作台的本地对话线程，由后端启动 Codex 回合；适合在事项上下文中持续交流。
2. **从事项创建 Codex 任务**：注入脚本先切换到事项对应的工作区/项目，导航到 Codex 首页，再通过宿主桥把事项说明、Skill 名称和 Skill 路径预填到原生 composer；用户确认后由 Codex 原生页面创建任务。

第二条路径由 `inject/codex-taskboard.user.js#createThreadForTask`、`electron-set-active-workspace-root` 和 `requestHostTaskComposerPrefill` 协作完成。它不是复制一份任务，而是把番茄事项作为创建 Codex 对话时的上下文。

### 原生侧栏可见性边界

Codex 原生线程的持久化和侧栏目录由 Codex Desktop 自己维护。工作台创建线程后会立即拿到原生 `thread id`，并写入 `~/.codex` 的 Codex 状态；但某些 Codex Desktop 版本对“由独立 app-server 进程创建的线程”不会立刻刷新侧栏目录。此时可能出现：工作台详情页已经有对话，点击“打开对话”后原生页面才把线程同步到侧栏。

这不是番茄同步失败，也不是工作台 SQLite 丢失了 `codexThreadId`，而是 Codex Desktop 的本地 catalog 刷新时机问题。排查时应先看详情页是否已经生成 `codexThreadId`，再确认 Codex 原生页面是否完成侧栏刷新。

### 其他值得注意的设计点

- **本地优先**：番茄数据通过 CLI 拉取后缓存到 SQLite；Codex 对话通过本机 app-server/CLI 执行，服务不承担远端中转。
- **配置与凭证分离**：`.env.example` 只描述端口、目录和可执行文件路径；番茄 token 由 `gitee` CLI 保存，MCP 配置由使用者自己的 Codex 配置保存。
- **浏览器模式与 Codex 模式解耦**：不使用 Codex 时，`npm run taskboard` 仍可启动完整看板；只有 `npm run codex` 才需要 CDP 和注入器。
- **工作区绑定**：对话创建后会记录项目工作区和 Git 分支，服务端会在继续对话前重新解析并校验工作区，避免把消息发送到错误仓库。
- **可恢复状态**：看板线程、事件、附件索引和仓库选择都在 `.data/taskboard.sqlite`；Codex 原生消息仍以 Codex 自己的状态文件为准。
- **可观测性**：`npm run doctor` 检查运行环境、Codex、MCP、项目 Skill 和 `gitee` CLI；开发时可用 `npm run typecheck`、`npm run build` 和 `npm test` 分层验证。

## 项目内置 Codex Skill

仓库已经包含 `skills/tomato-workboard/SKILL.md`，用于让 Codex 按番茄事项流程工作。开源用户克隆仓库后即可看到该文件，不需要再复制或软链接到 `~/.codex/skills`。

工作台服务会通过 `/api/meta` 提供该 Skill 的实际路径；从事项打开或继续 Codex 对话时，前端会把这个路径作为 `[$tomato-workboard](...)` 引用传给 Codex。因此它属于项目发布内容，不是用户机器上的额外安装依赖。

仓库还包含 `.agents/plugins/marketplace.json` 和 `plugins/tomato-workboard/`，用于在支持本地个人插件的 Codex 环境中展示“番茄工作台”入口。插件不包含 MCP 地址、账号或密钥。

## 项目结构

项目按“本地服务、前端界面、共享模型、Codex 集成、可选扩展、文档和测试”分层。运行时数据和用户凭证不放在源码目录中。

```text
.
├── server/                         # 本地 Node.js 服务和业务 API
│   ├── index.mjs                   # 服务启动入口
│   ├── app.mjs                     # HTTP 路由、请求校验和静态资源服务
│   ├── database.mjs                # SQLite 数据访问和数据库迁移
│   ├── env.mjs                     # 环境变量读取
│   ├── ai-chat.mjs                 # Codex 对话服务
│   ├── ai-chat-process.mjs         # Codex 对话进程和事件解析
│   ├── ai-chat-catalog.mjs         # Skill、MCP 和对话能力目录
│   ├── tomato-cli.mjs              # 番茄 CLI 适配层
│   └── tomato-sync.mjs             # 番茄事项同步和状态流转服务
│
├── web/                            # React + Vite 前端
│   ├── index.html                  # 前端 HTML 入口
│   ├── vite.config.ts              # Vite 配置
│   └── src/
│       ├── main.tsx                # React 启动入口
│       ├── App.tsx                 # 看板页面、工具栏和页面级状态
│       ├── api.ts                  # 浏览器端 API 客户端
│       ├── types.ts                # 前端数据类型
│       └── components/             # 看板、任务详情、工作流和对话组件
│
├── shared/                         # 前后端共用的领域模型和转换逻辑
│   ├── domain.mjs                  # 任务、状态和优先级定义
│   ├── tomato-*.mjs                # 番茄事项标识、状态和 URL 转换
│   └── workflow-*.mjs              # 工作流数据结构和迁移逻辑
│
├── inject/                         # Codex 桌面应用中的看板注入脚本
│   └── codex-taskboard.user.js     # 用户脚本入口
│
├── scripts/                        # 开发、启动和 Codex 注入器脚本
│   ├── dev.mjs                     # 同时启动 API 和前端开发服务
│   ├── open-taskboard.mjs          # 打开本地看板
│   ├── codex-injector.mjs          # 启动并注入 Codex
│   ├── codex-injector-runtime.mjs  # 注入页面运行时
│   └── codex-dev.mjs               # Codex 集成开发模式
│
├── skills/                         # 项目级、可选的 Codex Skill
│   └── tomato-workboard/SKILL.md   # 番茄工作台的任务上下文和协作规则
│
├── plugins/                        # 可选的 Codex 插件包装
│   └── tomato-workboard/           # “打开番茄工作台”的插件入口和元数据
│
├── docs/                           # 配置和开发说明
│   └── mcp-setup.md                # 用户侧可选 MCP 配置说明
│
├── test/                           # Node.js、API 和前端源码级测试
├── .env.example                    # 本地配置模板，不包含真实 token
├── package.json                    # npm 脚本和依赖
└── README.md                       # 项目说明和开发入口
```

### 目录职责边界

- **`server/` 是运行时后端**：负责 HTTP API、SQLite、本地 Codex 对话以及番茄数据适配。
- **`web/` 是用户界面**：只通过 `web/src/api.ts` 调用本地服务，不直接访问 SQLite 或远端服务。
- **`shared/` 只放可复用模型**：避免把 React 组件或 Node.js 服务逻辑放进去。
- **`inject/` 和 `scripts/` 是 Codex 集成层**：不参与普通浏览器模式下的看板业务。
- **`skills/` 是工作规则**：给 Codex 读取的指引文件，不是运行时代码，也不保存凭证。
- **`plugins/` 是可选入口**：用于在支持本地插件的 Codex 环境中展示“番茄工作台”，不是看板服务的运行依赖。
- **`docs/` 是使用说明**：用户自己的 MCP、账号和 token 配置不应提交到这里。
- **`test/` 只验证源码行为**：测试数据使用临时目录，不依赖用户本机的真实 token 或生产数据。

### 本地运行目录

以下目录由运行或构建过程生成，已加入 `.gitignore`，不应提交：

```text
.data/          SQLite 数据库和本地运行数据
.env            用户自己的环境变量
.tmp/           临时文件
dist/           前端构建产物
output/         自动化或截图输出
*.log           本地日志
```

认证信息、MCP URL、token 和本地开发目录均属于使用者环境，不放入仓库。

## 开发

```bash
npm run dev          # API + Vite 开发服务器
npm run codex:dev    # Codex 内开发热更新
npm run typecheck    # TypeScript 类型检查
npm run build        # 前端构建并刷新已运行的注入页面
npm test             # 测试
npm run doctor       # 只读检查依赖、MCP、项目 Skill 和番茄 CLI
```

`npm run codex:dev` 适合修改 React、TypeScript 或 CSS。修改 `inject/codex-taskboard.user.js`、`scripts/codex-injector.mjs` 或其他注入器脚本后，需要停止并重新运行命令。

## 配置文件

`.env.example` 只放本地服务、番茄连接和 CLI 可执行文件配置，不包含 token：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `127.0.0.1` | 本地服务监听地址 |
| `CODEX_TASKBOARD_PORT` | `47823` | 本地服务端口 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 和本地运行数据目录 |
| `CODEX_EXECUTABLE` | `codex` | 嵌入式 Codex 对话使用的可执行文件 |
| `TOMATO_CLI_EXECUTABLE` | `gitee` | 番茄 CLI 可执行文件 |
| `TOMATO_HOST` | `https://osc.gitee.work` | 番茄 CLI 登录和卡片链接使用的服务地址 |
| `TOMATO_PROFILE` | `osc` | 本机 Gitee CLI profile |
| `TOMATO_CONTEXT` | 空 | 登录后默认切换的番茄 context |
| `TOMATO_TENANT` | 空 | 番茄卡片链接使用的租户标识 |
| `TOMATO_ANALYSIS_REPOSITORIES` | 空（自动读取 Codex 仓库） | Bug 分析的候选仓库顺序；设置后覆盖自动发现 |

Token、MCP URL、账号信息和本地开发目录都属于使用者环境，不应提交到 Git。

## 开源前检查

仓库源码不依赖固定的个人目录、项目名或本机 token。发布前仍建议逐项确认：

- `.env`、`.data/`、Codex 状态文件、日志和截图没有被提交；
- `TOMATO_ANALYSIS_REPOSITORIES` 使用发布者自己的本地路径，不写进源码；
- Tomato MCP、Code MCP 只配置在使用者自己的 Codex 配置中；
- 已采用 MIT License；贡献、问题反馈和支持范围仍可按发布需要补充；
- 用全新的工作目录执行 `npm ci && npm run doctor && npm run typecheck && npm run build`，确认不依赖当前机器的登录状态。

项目会把候选仓库列表从服务端 `/api/codex-repositories` 传给前端分析入口，分支由对应工作区的 Git 查询；前端再把顺序写入本次 Codex 分析指令。默认列表来自当前 Codex 的 `local-projects` 和 `project-order`；只有设置 `TOMATO_ANALYSIS_REPOSITORIES` 时才使用显式路径覆盖顺序。

## 数据与安全

- 本地数据库：`.data/taskboard.sqlite`
- `.data/`、`.env` 和运行时临时文件已加入 Git 忽略规则
- 服务默认只监听回环地址
- CDP 对本机其他进程没有身份认证；注入器运行期间只运行可信代码
- 启动器不会修改 `ChatGPT.app` 或 `app.asar`
- 当前启动器依赖 macOS 的 `open`、`pgrep` 和 `lsof`
- Windows/Linux 暂不支持 Codex 注入模式；浏览器模式可按实际环境调整

## 验证

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run doctor
```
