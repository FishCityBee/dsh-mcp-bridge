# 任务与会话维护

[English](usage.md) | 简体中文 | [README](../README.zh-CN.md)

## 第一个任务

完成[状态检查](installation.zh-CN.md#不启动模型任务的接入检查)后，选择一个可丢弃的默认工作区，以及只读新会话预设。最小 `run_task` 输入示例：

```json
{
  "task": "Reply with BRIDGE_OK. Do not run tools or change files.",
  "title": "Connection check"
}
```

这会启动模型任务，可能产生供应商费用。省略模型／供应商／等级时使用[工具栏约束](configuration.zh-CN.md)，省略工作区时使用工具栏默认值。保留返回的 `taskId` 和 `sessionId`，它们不是同一个概念：

- **任务**是一次提交的工作及其状态／结果。
- **会话**保存对话上下文，可用于后续任务。

## 工具参考

| 工具 | 用途与重要参数 |
| --- | --- |
| `harness_status` | 检查开关、模型模式、权限、配置版本和启动／存储错误 |
| `list_models` | 查看工具栏当前允许选择的模型 |
| `list_workspaces` | 列出 Harness 工作区 ID、标题和路径 |
| `list_sessions` | 列出工作区会话；必填 `workspace`，可选 `includeArchived` |
| `run_task` | 启动并等待一次任务 |
| `start_task` | 启动后返回 `taskId`，不等完成 |
| `wait_task` | 按 `taskId` 等待；可选 `timeoutSec` 只限制本次等待，不限制任务 |
| `get_task` | 立即取得任务快照 |
| `list_tasks` | 找回近期任务；可选 `activeOnly`、`limit` |
| `cancel_task` | 按 `taskId` 请求取消，并检查后续状态 |
| `delete_session` | `confirm: false` 只读预览；确认永久删除始终拒绝 |
| `manage_sessions` | 按明确范围预览、归档、取消归档；确认 `delete` 始终拒绝 |

`run_task` 和 `start_task` 接受 `task`，以及可选的 `workspace`、`sessionId`、`provider`、`model`、`reasoningEffort`、`title`。使用桥接返回的 ID，不要自行编造会话 ID，也不要从文件路径推导它。

## 长任务、断线与取消

桥接不会因为任务耗时长而主动取消。MCP 客户端仍可能超时或断开；客户端提供 MCP progress token 时，桥接约每 30 秒发送进度，客户端不一定会显示。

对于单次调用时间较短的客户端：

1. 只调用一次 `start_task`，保存 `taskId`。
2. 用比客户端工具超时更短的上限调用 `wait_task`，例如 `{"taskId":"<返回的任务 ID>","timeoutSec":45}`。
3. 仍在执行时，按需要继续等待。避免高频调用 `get_task` 轮询。

等待超时或客户端断线不会提出取消请求。重连后先用 `list_tasks` 找回任务，再决定是否重新提交。Harness 重启后，检查任务是否标为 `interrupted`；桥接不保证每个执行中的操作都能跨进程退出继续存活。

取消不是回滚。已经执行的文件操作、命令或供应商请求可能已经产生效果或费用。任务变为终态后检查结果，再管理会话或判断活动已完全停止。

任务状态包括 `queued`、`running`、`waiting_approval`、`done`、`failed`、`cancelled`、`interrupted`。按情况查看 `error`、`termination`、`approval` 和实际结果。`done` 不保证答案正确，也不保证达到你的验收标准。

官方 consumed-work fold 只处理本任务 `eventBaseline` 之后的事件。未运行输入被丢弃时映射为 `cancelled`，即使此前已消费的 turn 已 completed；`termination.droppedUnrun` 和完整 `consumedEnd` 保留这一区别。错误终态仍保留原错误详情及已有结果，桥接主动取消优先。普通 completed／error／blocked／max-tokens／aborted 保持既有映射，缺少有效结算终态时为 interrupted。

## 继续已有对话

在新任务中传入此前返回的 `sessionId`。桥接可继续自己管理的会话，拒绝接管其他 owner 持有的 live 会话；从磁盘恢复时，会话也必须在桥接管理记录中。

模型约束会针对新任务重新计算。新会话权限选择不会覆盖既有会话的权限。应读取返回的 `effectiveSelection`，而不是仅凭工具栏显示就认定已实际发起对应模型请求。

## 归档与删除边界

**0.2.4 插件内不存在可执行的永久删除路径。** `delete_session` 和 `manage_sessions` 的 `action: "delete"` 保留兼容的只读预览接口；确认执行始终返回 `PERMANENT_DELETE_UNSUPPORTED`。令牌、`confirm: true`、工具栏命令或旧 pending 文件都不能授权删除。拒绝之前不会处置 owner、移除工作区归属或删除 ledger 记录。

旧待删除文件只读报告，绝不执行或改写。损坏或无法读取会明确报告，不能当作空队列。若仍运行旧插件，请先阅读[升级说明](troubleshooting.zh-CN.md#清理限制与待删除队列)。

归档保留会话文件、缓存、ledger 与工作区归属，可通过取消归档恢复。手动 `manage_sessions` 归档保留原有 `stopActivity: true` 行为：拒绝活动中的 MCP 任务后，可能请求停止其他本地可见活动，并取消置顶。自动路径独立实现，始终使用 `stopActivity: false`。

本进程没有 live agent 不证明所有 CLI／SDK 进程均空闲。如需永久删除，请在官方应用或工具中自行检查、手动处理，相关删除流程不在本次验证范围。

### 批量范围与预览

`manage_sessions` 接受：

- `workspace`：必填，工作区 ID、标题或路径。
- `action`：`archive`、`unarchive` 或 `delete`。
- `mcpOnly`：默认 `true`；设为 `false` 会包含个人／非 MCP 会话。
- `olderThanDays`：可选，有限且非负的天数过滤值。
- `includeArchived`：可选；删除默认包含已归档会话，取消归档始终考虑它们。
- `confirm`：省略或设为 `false` 表示预览。
- `previewToken`：操作范围包含非 MCP 会话时必填；其他预览也可使用。令牌不能启用永久删除。

下面只预览归档，不执行变更：

```json
{
  "workspace": "<list_workspaces 返回的工作区 ID>",
  "action": "archive",
  "mcpOnly": true,
  "confirm": false
}
```

决定前先查看具体目标 ID。得到授权后，在 **60 秒**内带同样的工作区／动作／范围、`confirm: true` 和返回的 `previewToken` 提交。令牌绑定具体 ID 及记录版本；之后新出现的匹配会话不会加入该预览。令牌过期或目标变化时，应重新预览和审阅，不要绕过检查。

`confirm: true` 是调用方提交的值，不是人已批准的独立证据；调用客户端仍需获得适当用户授权。单会话 `delete_session` 不使用批量预览令牌，应先核对具体会话并用 `confirm: false` 预览。

不再产生新的待删除记录。旧请求保持原样，包括无效或历史格式条目。所有永久删除执行在处置 owner 或消耗预览令牌之前就拒绝。

### 自动归档

兼容配置键 `autoCleanupDays` 默认 **0（关闭）**。正数表示仅自动归档旧 MCP 会话。插件启动 30 秒后运行，此后约每六小时一次；工具栏“立即自动归档”使用相同实现。修改天数在下一轮或立即操作时生效。MCP 启用开关不控制这个独立维护选项。

年龄依据可识别的当前最高代日志文件活动时间，不使用目录 mtime。已归档、本进程 live／busy、近期活动、未知／歧义活动或版本变化会跳过；身份、路径或官方活动检查失败会报告。异步读取后再次检查，向官方接口明确传入 `stopActivity: false`，由其拒绝已报告的活动，不请求停止任务。这不证明跨进程均空闲。

结果包含 `kind: "auto-archive"`、`schemaVersion: 1`、`archived`、`skipped`、`failed`；兼容字段 `deleted` 始终为 **0**。工具栏区分旧清理记录与新归档回执。归档保留日志、缓存、ledger 和工作区归属，可取消归档恢复，不释放会话文件占用的磁盘空间。仅支持已核对的 `$DSH_HOME/sessions` JSONL 根；自定义或大小写不同的其他根会拒绝。

## 本地数据与保留策略

`DSH_HOME` 默认是 `~/.dsh`。

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/harness-mcp-token.txt` | 共享认证密钥 |
| `$DSH_HOME/mcp-bridge/bridge.log` | 桥接诊断日志 |
| `$DSH_HOME/mcp-bridge/tasks.json` | 活动任务与保留的终态历史，包括任务／结果元数据 |
| `$DSH_HOME/mcp-bridge/sessions.json` | MCP 创建会话的台账 |
| `$DSH_HOME/mcp-bridge/pending-deletes.json` | 历史删除请求：原样保留，只读诊断 |
| `$DSH_HOME/mcp-bridge/endpoint.json` | 已发布的本地端点信息 |
| `$DSH_HOME/sessions/` | Harness 会话存储，独立于桥接任务索引 |
| `$DSH_HOME/storages/session_projcache/sessions/` | 本版本使用的 Harness 会话投影缓存 |

任务索引保留全部活动记录，以及最近七天内最多 200 条终态记录。任务记录过期与删除 Harness 会话是两件事。写入失败时查看 `storageError`、`durability`、`persistenceError`；任务恢复依赖成功存储的状态。磁盘快照标记为 `durable`，内存记录只在匹配的写成功回执到达后才标为 durable；新写入与进度变化会作废旧回执，当前写失败会显示 degraded。冷加载只描述已保存的快照，不代表上次进程未落盘的后续进度。

把整个数据目录当作私密内容保护。任务记录可能包含提示词片段、路径、输出、工具参数和审批细节。删除一个会话，不会自动抹去已经发送到 MCP 客户端、模型供应商、备份或其他日志中的副本。
