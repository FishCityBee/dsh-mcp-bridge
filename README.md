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
  - **供应商模式**：始终锁定供应商；“允许调用方选择模型/推理等级”默认关闭，关闭时默认模型和等级也是任务约束。
  - 模型列表和 Harness 对话框里的模型选择器是同一个数据源。
  - 可以设置默认工作区：调用方没明确指定时，会话就建在这里。
  - **会话审批**：沿用会话设置、需要时询问、需要审批时自动拒绝；不改变沙箱或扩大权限。该版上游只支持单次允许。
  - **会话清理**：
    - 自动删除超过 N 天的 MCP 会话；
    - 按工作区批量归档、取消归档、永久删除，默认只处理 MCP 创建的会话，执行前会弹窗确认。
- **会话菜单**：每个会话的「…」菜单里增加「删除会话」（永久删除；需要保留请用 Harness 自带的归档）。
- 设置用于下一任务；排队任务启动前重新核对，已经运行的任务保留启动快照。修改这些设置不会重启插件。

## 0.2.0 配置迁移与生效时点

- 供应商模式旧版的默认值原本允许调用方覆盖。**本次产品调整**新增 `providerAllowOverrides`，缺失值迁移为 `false`；并非把旧行为重新描述成原有硬锁。需要调用方明确选模型时，先由用户打开开关。供应商仍不能覆盖；单模型模式始终锁定供应商、模型和等级，显式冲突返回 `CONFIG_CONFLICT`，不发送模型请求。
- 空推理配置解析为目录中该模型的实际默认等级。锁定模式下不支持的旧等级明确报错，须重新选择；不会静默换级。MCP 调用通常省略 `model/reasoningEffort`，只有用户明确要求且允许覆盖时才填。
- 已运行任务保留启动时快照。排队任务在取得会话锁和执行额度后重新解析当前配置；显式参数与新约束冲突则失败。异步准备期间再次改变配置则拒绝启动，要求重试。resume 的自动唤醒在首个 step 前等待接纳、监控和取消检查。
- 回执分别提供 `requestedSelection`、`effectiveSelection`、`configVersion` 和 `configSource`。版本是无密钥配置内容指纹；有效值仅在官方 `llm/stream` 看到真实请求信封后填写，否则为 `null`，不等于证明供应商收到了请求或计费。旧的 provider/model 字段为任务约束，供旧 MCP 客户端兼容。
- 旧 `autoApprove` 不再作为授权来源；原来错误的 `never` 实际是自动拒绝。新 `approvalMode` 默认 `inherit`，已有会话保留原策略；明确选择 ask/never 仅用于本插件管理的会话。不会把单次允许记忆为持续授权，也不复制其他会话的权限。
- 0.2.1-rc.2 只有 `ask/never` 和 `allowed-once/rejected/cancelled/unavailable`。需要同范围持续授权时必须先有上游支持的范围机制；本次没有自建放行缓存、切换全局沙箱或实施永久授权。Claude 的 MCP 工具许可、Harness 的审批/沙箱、Auto review 与操作系统提示是不同层；桥接日志只报告它可观察到的层。
- 批量永久删除需先预览，再在 60 秒内提交原 `previewToken` 与 `confirm:true`；令牌固定具体 ID 和版本。包含个人会话必须显式 `mcpOnly:false`。会话变化需重新确认，新出现的匹配会话不会被加入原确认。

逐项证据、修改文件和桌面手工验收步骤见 [本次修复报告](docs/audit-2026-10-17.md)。

## 安装

需要：DeepSeek Harness 桌面端 **0.2.1-rc.2**、Node.js 22+。本次修复版本为 **0.2.1**，未验证其他 Harness 版本。0.2.1 修复了 0.2.0 的 OpenSSL PSK 密码套件在桌面 Electron / BoringSSL 中不可用的问题。

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

- `bin/stdio.mjs` 使用标准 TLS 1.3 加密。双方分别从本地 token 派生独立的 P-256 签名密钥，并核对对端公钥；客户端验证服务端后才转发 MCP，服务端验证客户端后才接纳 MCP。自签证书只作 TLS 容器，信任依据是派生的公钥锁定；长期 token 与私钥均不在管道上发送。无需外部 OpenSSL 或证书文件。必须同时更新插件和中转脚本，协议为 `tls-pinned-v3`；旧明文及 PSK 握手不降级兼容。
- `timeout` 设成 24 小时，它同时也是 Claude Code 空闲超时的下限，保证长任务不会被 stdio 默认 30 分钟的空闲超时打断。
- Harness 重启后，中转脚本会随连接断开而退出，需要在 Claude Code 里用 `/mcp` 重连。

可用的环境变量：`DSH_HOME`、`DSH_MCP_BRIDGE_PIPE`、`DSH_MCP_BRIDGE_TOKEN`、`DSH_MCP_BRIDGE_WAIT_MS`（连接等待时间，默认 15000 毫秒）。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `harness_status` | 开关、模式、锁定的模型 / 供应商、默认工作区、审批模式 / 存储状态 |
| `list_models` | 当前允许使用的模型和推理等级 |
| `list_workspaces` / `list_sessions` | 工作区和会话（标注是否由 MCP 创建、是否已归档） |
| `run_task` | 执行任务，阻塞到完成，期间发送进度。参数：`task`、`workspace?`、`sessionId?`、`provider?`、`model?`、`reasoningEffort?`、`title?` |
| `start_task` / `wait_task` | 后台启动 / 阻塞等待（可设上限，到时只返回进度，不会取消任务） |
| `get_task` / `list_tasks` / `cancel_task` | 查看任务状态、找回任务、取消任务 |
| `delete_session` | 永久删除会话（需要 `confirm: true`） |
| `manage_sessions` | 按工作区批量归档、取消归档、永久删除；默认 `mcpOnly:true`，删除需携带预览返回的 `previewToken` |

只有用户明确指定时，才需要传 `workspace` 参数（工作区 id、名称或目录路径都可以）；不传就用工具栏里设置的默认工作区。

## 实现说明

- **后端**（`src/index.ts`）：普通的 cordis 插件。
  - 在同会话锁内创建 / 恢复智能体，通过官方 `installModelSelection` 影响 prompt assembly 和每次请求；不直接改 `agent.options`。非本插件拥有的 live 会话明确拒绝续用，不更改其模型或权限。
  - `whenIdle()` 只用于等待边界；任务成败按本任务日志后缀的官方 `foldConsumedWork` / `turn/end` 分类。审批显示从历史事件重建；`approval/asked` 是请求审计，不能据此断言真的弹出了窗口。
- **前端**（`src/client/`）：
  - 工具栏注册在 `shell.overlay` 上，删除菜单项注册在 `sidebar.workspaces.session.menu.item` 上。
  - 打包格式按 Harness 的 `window.__ModuleLoader__.load({ id, factory })` 包装，外部依赖只用平台模块表里的模块（见 `build.mjs`）。
- **设置**：所有可调项都是 `.volatile()` 配置字段。工具栏通过 `remote.settings.update` 写入，后端用 `config.x.get()` 实时读取，插件不会重启。
- **前端怎么调用后端**：没有自定义 RPC，复用设置通道。
  - 工具栏把 JSON 命令写进 `command` 字段，后端执行后把结果写到 `commandResult`。
  - 后端回写时必须先用 `hmr.executing.exit()` 退出工具栏那次写入的 HMR 事务上下文，否则会报 `HMR transactions cannot be nested`。
- **删除会话**：先检查合法 ID、官方持久化身份、配置的 JSONL 存储根、每层真实路径与链接；默认仅支持 `$DSH_HOME/sessions`，其他根明确拒绝。对另一 owner 仍持有的 live 会话先归档停止并排队，释放后重新验证 ID 与日志版本再删除。旧队列中的绝对路径不再执行，需要重新确认。当前有效最高代日志文件的时间用于自动及批量过期判断；目录 mtime 不代表活动。

## 数据文件

都在 `$DSH_HOME/mcp-bridge/` 下：

- `bridge.log`：插件日志（桌面端本身不会把插件日志写到磁盘）
- `tasks.json`：全部活动任务 + 最近 7 天最多 200 条终态历史；接纳与终态等待同步写入，失败显式报告
- `sessions.json`：由 MCP 创建的会话
- `pending-deletes.json`：等待 owner 释放后校验删除的具体 ID / 日志版本，不存可信删除路径
- `endpoint.json`：管道地址

## 已知限制

- 依赖 Harness 的内部接口（比如 `hmr.executing`、会话目录结构），Harness 升级后可能需要适配。
- 当前正在界面里打开的会话，删除后它在本次运行期间仍留在内存里，直到 Harness 重启。
- 没有找到 Harness 推送进度的通道，所以在 Claude Code 里显示进度依赖 MCP 的 progress 通知（要求客户端提供 progressToken）。

## 开发

```bash
npm run typecheck
npm run build
npm test        # 构建 + smoke + 单元 + 回归 + 真实临时管道安全测试；不访问真实会话或模型
```

用 `node scripts/tools.mjs` 和 `node scripts/call.mjs <tool> '<json>'` 可以直接调用正在运行的 Harness。

## License

MIT
