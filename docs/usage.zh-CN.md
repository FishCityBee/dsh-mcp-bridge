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
| `delete_session` | 永久删除一个 `sessionId`；必填 `confirm`，`false` 为预览 |
| `manage_sessions` | 按明确范围预览、归档、取消归档或删除工作区会话 |

`run_task` 和 `start_task` 接受 `task`，以及可选的 `workspace`、`sessionId`、`provider`、`model`、`reasoningEffort`、`title`。使用桥接返回的 ID，不要自行编造会话 ID，也不要从文件路径推导它。

## 长任务、断线与取消

桥接不会因为任务耗时长而主动取消。MCP 客户端仍可能超时或断开；客户端提供 MCP progress token 时，桥接约每 30 秒发送进度，客户端不一定会显示。

对于单次调用时间较短的客户端：

1. 只调用一次 `start_task`，保存 `taskId`。
2. 用比客户端工具超时更短的上限调用 `wait_task`，例如 `{"taskId":"<返回的任务 ID>","timeoutSec":45}`。
3. 仍在执行时，按需要继续等待。避免高频调用 `get_task` 轮询。

等待超时或客户端断线不会提出取消请求。重连后先用 `list_tasks` 找回任务，再决定是否重新提交。Harness 重启后，检查任务是否标为 `interrupted`；桥接不保证每个执行中的操作都能跨进程退出继续存活。

取消不是回滚。已经执行的文件操作、命令或供应商请求可能已经产生效果或费用。任务变为终态后检查结果，再删除会话或判断活动已完全停止。

任务状态包括 `queued`、`running`、`waiting_approval`、`done`、`failed`、`cancelled`、`interrupted`。按情况查看 `error`、`termination`、`approval` 和实际结果。`done` 不保证答案正确，也不保证达到你的验收标准。

## 继续已有对话

在新任务中传入此前返回的 `sessionId`。桥接可继续自己管理的会话，拒绝接管其他 owner 持有的 live 会话；从磁盘恢复时，会话也必须在桥接管理记录中。

模型约束会针对新任务重新计算。新会话权限选择不会覆盖既有会话的权限。应读取返回的 `effectiveSelection`，而不是仅凭工具栏显示就认定已实际发起对应模型请求。

## 优先归档，再考虑删除

> **0.2.2 已知问题：** 桥接的本进程检查无法可靠识别另一个正在向相同数据目录写入的 CLI／SDK 进程，此时永久清理可能删除活跃会话。请保持 `autoCleanupDays: 0`，优先归档，在实现跨进程保护之前不要使用永久删除。以下删除参考仅记录当前接口，不是使用推荐，也不代表清理已经通过完整安全验收。

已有待删除队列独立存在：即使关闭自动清理或 MCP 开关，插件启动后约五秒仍会处理。已经排队的删除，应先安排安全处理或使用已修复版本，再重启／重载插件。详见[待删除队列警告](troubleshooting.zh-CN.md#清理限制与待删除队列)。

以后可能还要用的对话优先归档。永久删除会移除会话存储及相关投影缓存，不是移入普通可恢复的回收站。

本版本的 `manage_sessions` 使用 `stopActivity: true` 归档：它会请求 Harness 停止该会话的活动，并取消置顶，因此归档不只是隐藏对话。桥接会拒绝归档仍有活动 MCP 任务的会话；归档其他符合条件的会话可能停止其活动。

请备份重要数据。其他 Harness 实例或进程可能写入同一个数据目录时，不要执行清理；进程内的“不忙”检查不保证其他进程没有活动。

### 批量范围与预览

`manage_sessions` 接受：

- `workspace`：必填，工作区 ID、标题或路径。
- `action`：`archive`、`unarchive` 或 `delete`。
- `mcpOnly`：默认 `true`；设为 `false` 会包含个人／非 MCP 会话。
- `olderThanDays`：可选，有限且非负的天数过滤值。
- `includeArchived`：可选；删除默认包含已归档会话，取消归档始终考虑它们。
- `confirm`：省略或设为 `false` 表示预览。
- `previewToken`：执行删除，或操作范围包含非 MCP 会话时必填。

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

live 会话的删除可能排队等待 owner 释放；排队回执不意味着所有文件已经移除。发生变化或不受支持的会话可能校验失败，需要重新审阅。

### 自动清理

`autoCleanupDays` 默认 **0（关闭）**。上方跨进程问题解决前，应保持关闭。设为正数会自动永久删除符合条件的 MCP 会话，不再逐个询问确认；它会在启动后、约每六小时以及修改保留天数时运行。

年龄过滤使用可识别的当前最高代会话日志文件的修改时间，不使用会话目录修改时间。这是存储时间戳，不能普遍等同于“最近没有任何有用工作”。桥接通过本进程检查排除 live／busy 会话；无法确认或有歧义的活动时间不足以支持自动过期删除。

这些操作面向已核对的 `$DSH_HOME/sessions` JSONL 存储根；不要使用自定义根。路径与身份检查降低风险，但不会使永久删除可恢复，也不证明与所有外部进程充分隔离。

## 本地数据与保留策略

`DSH_HOME` 默认是 `~/.dsh`。

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/harness-mcp-token.txt` | 共享认证密钥 |
| `$DSH_HOME/mcp-bridge/bridge.log` | 桥接诊断日志 |
| `$DSH_HOME/mcp-bridge/tasks.json` | 活动任务与保留的终态历史，包括任务／结果元数据 |
| `$DSH_HOME/mcp-bridge/sessions.json` | MCP 创建会话的台账 |
| `$DSH_HOME/mcp-bridge/pending-deletes.json` | 待删除 ID 及日志版本 |
| `$DSH_HOME/mcp-bridge/endpoint.json` | 已发布的本地端点信息 |
| `$DSH_HOME/sessions/` | Harness 会话存储，独立于桥接任务索引 |
| `$DSH_HOME/storages/session_projcache/sessions/` | 本版本使用的 Harness 会话投影缓存 |

任务索引保留全部活动记录，以及最近七天内最多 200 条终态记录。任务记录过期与删除 Harness 会话是两件事。写入失败时查看 `storageError`、`durability`、`persistenceError`；任务恢复依赖成功存储的状态。

把整个数据目录当作私密内容保护。任务记录可能包含提示词片段、路径、输出、工具参数和审批细节。删除一个会话，不会自动抹去已经发送到 MCP 客户端、模型供应商、备份或其他日志中的副本。
