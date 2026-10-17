# 排障与常见问题

[English](troubleshooting.md) | 简体中文 | [README](../README.zh-CN.md)

## 先检查这些

记录插件 revision、Harness 版本、Node 版本、操作系统和 MCP 客户端及版本。检查 `harness_status` 和 `$DSH_HOME/mcp-bridge/bridge.log` 中相关的脱敏片段。不要共享 token 文件或整份私密会话存档。

如果已有待删除队列，**重启 Harness 或插件之前**先阅读下方清理警告。

## 客户端无法连接

1. 确认目标 Harness 桌面宿主正在运行，且插件已加载。
2. 检查客户端是否指向真正的 `dist-package/bin/stdio.mjs`，同目录应有 `pipe-tls.mjs`。
3. 确认客户端能够启动 Node 22+；图形应用的 `PATH` 可能不同。
4. 确认中转脚本与 Harness 使用一致的账号、`DSH_HOME`、端点和 token 配置。
5. 升级后重连 MCP 客户端，旧中转进程不会自动变成新版。

出现 `PIPE_SERVER_AUTH_FAILED`、握手失败或缺失模块时，优先核对插件／中转脚本版本和路径，不要禁用 TLS 校验或对外暴露 HTTP 端点绕过问题。`TOKEN_EMPTY` 或 token 读取失败时，检查目标文件和权限，不要公开、盲目覆盖或重新生成凭据。

## `CONFIG_CONFLICT` 或模型选择不符合预期

读取 `harness_status` 和 `list_models`。供应商模式默认不允许调用方覆盖模型或推理等级。不要猜测并填写路由参数，让工具栏配置生效。确实需要调用方覆盖时，由你主动调整该设置，并选择受支持的值。

设置变化前排队的任务，若显式参数与新约束冲突，可能在启动检查时失败。其他 Harness 组件持有的 live 会话也会被拒绝接管，不会被强行改模型。重试前先看具体错误，不要重复提交已在运行的任务。

`effectiveSelection: null` 表示桥接尚未为该任务观察到匹配的模型请求，不能据此认定已使用某个供应商。

## 任务等待审批或操作被拒绝

打开对应 Harness 会话，检查实际权限预设和审批状态。MCP 客户端允许调用桥接，不代表智能体的文件或命令操作已经获得批准。

新会话选择器只影响以后新建的会话，改变它不会扩大已有会话权限。`never` 会拒绝需要审批的操作，不是自动批准模式。不要仅为去掉提示就选择完全权限。

## 调用超时或没有显示进度

通过 `list_tasks` 或 `get_task` 检查底层任务是否仍在活动，再使用 `wait_task`，不要直接重复提交。单次工具时间较短的客户端可以用 `start_task` 配合有上限的等待。进度显示依赖客户端支持以及 MCP progress token。

客户端超时、桥接等待上限和取消任务是三件事，详见[长任务说明](usage.zh-CN.md#长任务断线与取消)。

## 工作区或会话错误

- **没有默认工作区：** 在工具栏选择，或明确传入目标工作区；不要自动替换成调用方当前目录。
- **`SESSION_NOT_MANAGED`：** 磁盘恢复仅限桥接管理的会话。选择桥接返回的受管理会话，或新建一个。
- **`SESSION_BUSY`：** 等待已有活动／取消过程结束，不要用删除强行处理。
- **`UNSUPPORTED_SESSION_STORAGE`：** 本版本的会话操作仅支持已核对的 `$DSH_HOME/sessions` JSONL 根。不要移动文件或绕过校验来强行兼容。

## 存储错误

出现 `startupError`、`storageError`、`durability: degraded` 或 `persistenceError`，就不应假设任务索引已可靠保存。检查磁盘空间及目标数据目录访问权限，保留备份，并收集脱敏错误报告。不要在不理解后果时通过删除 `tasks.json`、`sessions.json` 或待删除状态来“修复”解析错误。

## 清理限制与待删除队列

**0.2.2 的永久删除可能遗漏共享 `DSH_HOME` 的其他 CLI／SDK 进程中的活跃写入者。** 自动清理保持 `0`，优先归档，在实现跨进程保护之前，也不要使用手动永久删除。

`autoCleanupDays: 0` 只会关闭按年龄自动清理，**不会**取消 `pending-deletes.json`。待删除队列会在插件启动后不久（约五秒）继续处理，MCP 启用开关也不控制该队列。

如果已经产生待删除任务，不要以为关掉开关就能安全重启。应先安排安全处理或使用已修复删除问题的版本，再重启／重载插件；同时避免其他写入者使用相同数据目录。不要只为隐藏警告而清空队列记录。备份和预览令牌不能代替跨进程排他保护。

`CONFIRMATION_EXPIRED` 和 `SESSION_CHANGED` 都要求重新预览并由用户审阅；即使独立的跨进程问题已修复，也不应绕过这些检查。

## Harness 有 CLI 吗？

有。Harness 官方项目包含 CLI、headless、SDK、ACP 和 web 相关使用方式，参阅[目标 Harness 版本的 CLI README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/apps/cli/README.md)。

本仓库目前记录的是把插件装进 desktop profile，并连接该运行中的宿主，不代表 Harness 没有 CLI。若要让本插件使用单独的后台 profile，还需要配置和兼容性验证，不能从桌面安装步骤直接推定可用。CLI 也不会把保留的 desktop profile 当成普通 CLI 会话启动。

## 免费吗？能绕过 Claude 或 Codex 额度吗？

不承诺固定节省比例或免费推理。桥接把任务交给 Harness 中配置的供应商，供应商费用和主智能体的协调／审阅开销仍然存在。它不改变供应商计费，也不增加 Claude／Codex 的账号权益。应衡量完整流程，而不是假设所有委派都更便宜。

## 适合我吗？

如果你已经使用 Harness、经常把边界清楚的任务交出去，并希望有可见的模型／权限控制和可继续使用的会话，这个流程更有价值。如果只需要一次直接模型调用，额外的插件、构建和运行中的桌面宿主可能没有必要。

尚未解决的问题可使用[缺陷模板](../.github/ISSUE_TEMPLATE/bug_report.md)，并参阅[贡献指南](../CONTRIBUTING.zh-CN.md)。安全问题遵循 [SECURITY.md](../SECURITY.md#安全说明)，不要公开利用细节。
