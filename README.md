# dsh-mcp-bridge

让 **Claude Code**（或任何 MCP 客户端）调用 **DeepSeek Harness 桌面端**的智能体来干活，并在 Harness 窗口右下角提供一个工具栏，控制模型、供应商、推理等级、默认工作区和会话清理。

> Drive DeepSeek Harness desktop agents from Claude Code (or any MCP client) over a local named pipe — no TCP port. An in-app toolbar picks the model / provider / reasoning effort and default workspace, and cleans up the sessions MCP creates.

> ⚠️ 非官方插件。DeepSeek Harness 仍处于开发者预览阶段，接口随时可能变化。本插件按桌面端 **v0.2.1-rc.2** 的实际行为开发和测试（Windows）。

## 功能

- **MCP 服务**：插件运行在 Harness 进程内，通过本机命名管道提供 MCP 服务（Windows 为 `\\.\pipe\dsh-mcp-bridge-<用户名>`，其他平台为 `$DSH_HOME/mcp-bridge/bridge.sock`）。**不占用端口**；Streamable HTTP 端点可选开启。
- **长任务不丢**：
  - 插件这边从不因超时取消任务。`run_task` 会一直等到智能体完成，并每 30 秒发送一次进度（运行时长、步数、工具调用次数、是否在等你审批）。
  - Claude Code 会把超过 2 分钟的调用转到后台，完成时通知模型，**不需要轮询**。
  - 任务记录会持久化保存：连接断开后可用 `list_tasks` 找回、用 `wait_task` 继续等待；Harness 重启后，被中断的任务会明确标记出来。
- **右下角工具栏**：
  - **单模型模式**：锁定一个模型和推理等级，所有 MCP 任务都只能用它。
  - **供应商模式**：锁定一个供应商，调用方可以在它下面自选模型和推理等级；没指定时用工具栏里设置的默认模型和默认推理等级。
  - 模型列表和 Harness 对话框里的模型选择器是同一个数据源。
  - 可以设置默认工作区：调用方没明确指定时，会话就建在这里。
  - MCP 总开关、「MCP 任务自动批准」开关。
  - **会话清理**：
    - 自动删除超过 N 天的 MCP 会话；
    - 按工作区批量归档、取消归档、永久删除，默认只处理 MCP 创建的会话，执行前会弹窗确认。
- **会话菜单**：每个会话的「…」菜单里增加「删除会话」（永久删除；需要保留请用 Harness 自带的归档）。
- 所有设置都即时生效，**不会重启插件，也不会中断正在运行的任务**。

## 安装

需要：DeepSeek Harness 桌面端 0.2.x、Node.js 22+。

```bash
git clone https://github.com/FishCityBee/dsh-mcp-bridge.git
cd dsh-mcp-bridge
npm install
npm run build          # 产出 dist-package/
```

把 `dist-package` 装进桌面端的 profile（Windows 示例，路径换成你自己的）：

```bat
"D:\Program Files\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add C:\path\to\dsh-mcp-bridge\dist-package
```

然后**完全退出 Harness（包括托盘）再重新打开**。之后每次改代码重新构建，也都需要重启 Harness。

首次启动时会生成认证 token：`$DSH_HOME/harness-mcp-token.txt`（`$DSH_HOME` 默认为 `~/.dsh`）。

## 在 Claude Code 中使用

```bash
claude mcp add-json dsh-harness -s user '{"type":"stdio","command":"node","args":["C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"],"timeout":86400000}'
```

- `bin/stdio.mjs` 是一个没有任何依赖的中转脚本：读取 token 完成握手，然后在 stdio 和管道之间原样转发。
- `timeout` 设成 24 小时，它同时也是 Claude Code 空闲超时的下限，保证长任务不会被 stdio 默认 30 分钟的空闲超时打断。
- Harness 重启后，中转脚本会随连接断开而退出，需要在 Claude Code 里用 `/mcp` 重连。

可用的环境变量：`DSH_HOME`、`DSH_MCP_BRIDGE_PIPE`、`DSH_MCP_BRIDGE_TOKEN`、`DSH_MCP_BRIDGE_WAIT_MS`（连接等待时间，默认 15000 毫秒）。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `harness_status` | 开关、模式、锁定的模型 / 供应商、默认工作区、是否自动批准 |
| `list_models` | 当前允许使用的模型和推理等级 |
| `list_workspaces` / `list_sessions` | 工作区和会话（标注是否由 MCP 创建、是否已归档） |
| `run_task` | 执行任务，阻塞到完成，期间发送进度。参数：`task`、`workspace?`、`sessionId?`、`model?`、`reasoningEffort?`、`title?` |
| `start_task` / `wait_task` | 后台启动 / 阻塞等待（可设上限，到时只返回进度，不会取消任务） |
| `get_task` / `list_tasks` / `cancel_task` | 查看任务状态、找回任务、取消任务 |
| `delete_session` | 永久删除会话（需要 `confirm: true`） |
| `manage_sessions` | 按工作区批量归档、取消归档、永久删除；不带 `confirm: true` 时只预览 |

只有用户明确指定时，才需要传 `workspace` 参数（工作区 id、名称或目录路径都可以）；不传就用工具栏里设置的默认工作区。

## 实现说明

- **后端**（`src/index.ts`）：普通的 cordis 插件。
  - 用 `ctx.agents.create` 创建智能体，`agentOptions` 里带上 provider、model 和 reasoningEffort；挂载 agent preset；把会话归到对应工作区。
  - 任务完成通过 `agent.whenIdle()` 等待；每 5 秒对会话采样一次，通过 `approval/asked` 和 `approval/decided` 事件判断是否在等待审批。
- **前端**（`src/client/`）：
  - 工具栏注册在 `shell.overlay` 上，删除菜单项注册在 `sidebar.workspaces.session.menu.item` 上。
  - 打包格式按 Harness 的 `window.__ModuleLoader__.load({ id, factory })` 包装，外部依赖只用平台模块表里的模块（见 `build.mjs`）。
- **设置**：所有可调项都是 `.volatile()` 配置字段。工具栏通过 `remote.settings.update` 写入，后端用 `config.x.get()` 实时读取，插件不会重启。
- **前端怎么调用后端**：没有自定义 RPC，复用设置通道。
  - 工具栏把 JSON 命令写进 `command` 字段，后端执行后把结果写到 `commandResult`。
  - 后端回写时必须先用 `hmr.executing.exit()` 退出工具栏那次写入的 HMR 事务上下文，否则会报 `HMR transactions cannot be nested`。
- **删除会话**：Harness 0.2.1 没有删除会话的 API，所以插件的做法是：
  1. 对仍在内存里的会话先 `archiveSession(id, { stopActivity: true })`，停止它的活动并阻止再次唤醒；
  2. 从工作区解除挂载，然后删除会话目录和投影缓存；
  3. 文件被占用删不掉时，记进 `pending-deletes.json`，下次启动时清理。

## 数据文件

都在 `$DSH_HOME/mcp-bridge/` 下：

- `bridge.log`：插件日志（桌面端本身不会把插件日志写到磁盘）
- `tasks.json`：任务记录，保留 7 天
- `sessions.json`：由 MCP 创建的会话
- `pending-deletes.json`：等待清理的文件
- `endpoint.json`：管道地址

## 已知限制

- 依赖 Harness 的内部接口（比如 `hmr.executing`、会话目录结构），Harness 升级后可能需要适配。
- 当前正在界面里打开的会话，删除后它在本次运行期间仍留在内存里，直到 Harness 重启。
- 没有找到 Harness 推送进度的通道，所以在 Claude Code 里显示进度依赖 MCP 的 progress 通知（要求客户端提供 progressToken）。

## 开发

```bash
npm run typecheck
npm test        # 构建，然后跑离线冒烟测试（模拟 Harness 服务，经真实的管道和 MCP SDK）
```

用 `node scripts/tools.mjs` 和 `node scripts/call.mjs <tool> '<json>'` 可以直接调用正在运行的 Harness。

## License

MIT
