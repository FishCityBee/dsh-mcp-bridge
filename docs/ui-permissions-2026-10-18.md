# 0.2.2 开关与新会话权限

## 行为

- MCP 启用、允许调用方覆盖、清理范围三处原生复选控件改成滑动开关，保留键盘、禁用、焦点和屏幕阅读器语义。
- “MCP 会话审批”改为“新建 MCP 会话权限”。三个独立选项为仅可查看、工作区访问、完全权限，调用官方 `permissionPresets.set(session, preset)`，同时设置沙箱和审批；与对话框使用同一服务及预设。
- 迁移默认是 `newSessionPermission: default`。选项会明确显示 Harness 新会话默认预设，而不是模糊地说“沿用会话”。客户端通过官方 `remote.permissionPresets.catalog()` 读取默认值与可用项，旧响应不会覆盖新目录。
- 只给新创建的 MCP 会话应用所选预设。续聊和磁盘恢复保留既有会话的权限，人类在对话框里收紧的权限不会被新会话设置扩大。其他 owner 的 live 会话仍拒绝接管。
- 不修改 Harness 全局默认权限。不缓存单次允许，不把 MCP 调用许可当作文件/命令许可。完全权限仅在用户显式选择后用于之后的新 MCP 会话。
- 后端继续兼容旧 `approvalMode`。UI 明确选择新预设时会将旧审批选项设为 `inherit`，避免独立审批策略破坏完整预设；旧 `autoApprove` 仍不生效。
- 预设不可用时启动失败，不能回退到更宽范围。新会话权限与 Harness 默认值都计入配置版本，异步创建期间变化会在发送前返回冲突。

## 证据

先补回归，前五个案例在旧 0.2.1 上为 4 失败、1 通过：新权限被忽略、回执来源含混、缺失预设仍发请求、创建时权限变化未被检测；磁盘恢复保留权限原本已正确。

修复后实际运行 `npm run typecheck`、`npm test`、`git diff --check`。`npm test` 内含构建，33 smoke + 10 units + 38 regression + 8 pipe-security，共 **89 项通过**。新增 8 个权限回归使用已安装官方 `PermissionPresetService` 的真实 setter/状态推导以及官方审批服务；投影存储、智能体与模型仍是隔离 fixture，文件仅在临时目录。

官方已安装版本为 0.2.1-rc.2。源码确认 `session/created` 会调用 `pinInitialPermission`，真正新建的会话会使用当前 `defaultPreset`；它与某个已有对话框当前权限是不同的设置。官方权限前端同样使用 `remote.permissionPresets.catalog()` 和目录变更事件。

桌面部署通过命令完成，0.2.1 原目录保留供回滚。安装后真实 MCP 状态返回：

```json
{"version":"0.2.2","newSessionPermission":"default","harnessDefaultPermission":"workspace-write"}
```

用户明确允许真实模型请求后，实际新任务完成：

```json
{
  "status": "done",
  "requestedSelection": {},
  "effectiveSelection": {"provider":"opencode","model":"deepseek-v4.1-flash","reasoningEffort":"high"},
  "approval": {"mode":"ask","source":"harness-new-session-default","preset":"workspace-write","sandbox":"workspace-write","persistentGrants":false},
  "result": {"finalText":"MCP_TEST_OK","toolCalls":[]}
}
```

额外的显式冲突模型调用返回 `CONFIG_CONFLICT`，不启动模型任务。本次未在用户真实会话中切换权限或执行文件/命令权限测试，未改全局安全设置，未使用 computer-use。开关视觉和选择交互尚未做桌面界面操作验收；源代码、类型、构建、官方权限调用及实际新会话默认行为均已核对。
