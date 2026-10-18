# Security

English | [简体中文](#安全说明)

## Reporting a vulnerability

Do not publish exploit details, credentials, private session data, or sensitive logs in an issue or pull request.

Check the repository's [Security page](https://github.com/FishCityBee/dsh-mcp-bridge/security) for an available private reporting channel. If a private reporting option is shown, use it. If none is available, open an issue that only asks the maintainer to arrange a private contact channel, without technical details or attachments. This document does not promise that private reporting is enabled or specify an email address or response deadline.

Once a private channel is established, include the affected bridge commit, Harness version, platform, impact, and a minimal reproduction using synthetic data. Do not reproduce data loss against a real installation.

## Security boundaries

Bridge 0.2.4 fails closed for all plugin permanent-deletion execution: the pinned official storage API has no verified safe cross-process deletion boundary. Automatic maintenance only archives with `stopActivity: false`; old pending-delete files are only read and reported, never executed or rewritten. This does not prove external writers are idle. See the [maintenance and upgrade boundary](docs/troubleshooting.md#cleanup-limitation-and-pending-deletions).

- This is a third-party integration, not an official DeepSeek, Anthropic, or OpenAI product.
- Connecting an MCP client grants it access to the bridge's exposed tools. An authenticated connection is not proof of human approval for each operation.
- A client's permission to call an MCP tool is separate from the permissions of the Harness agent that performs the delegated work. Review both.
- Workspace selection and instructions such as “read only” are not substitutes for an execution sandbox or an access-control policy.
- Prompts, files, results, and session metadata can contain private information. Share only what you are authorized to send to the selected model provider and MCP client.
- Protect bridge credentials and local state with appropriate operating-system access controls. Do not commit them or paste them into reports.
- Prefer archiving over permanent deletion when you may need a session again. Back up important data before testing cleanup features.

See the user guide for the exact behavior and data locations of the revision you are running. Review compatibility and permissions again when upgrading Harness or this bridge.

---

## 安全说明

### 报告漏洞

请勿在公开 Issue 或 Pull Request 中披露利用细节、凭据、私密会话数据或敏感日志。

先查看仓库的 [Security 页面](https://github.com/FishCityBee/dsh-mcp-bridge/security) 是否提供私密报告渠道；只有在实际显示该入口时才使用它。若没有可用入口，可以提交一个仅请求维护者提供私密联系方式的 Issue，不附技术细节或附件。本文不承诺已经启用私密报告，也不指定邮箱或响应期限。

建立私密渠道后，请提供受影响的插件 commit、Harness 版本、平台、影响和使用模拟数据的最小复现。不要在真实安装环境中复现数据丢失。

### 安全边界

桥接 0.2.4 对插件内所有永久删除执行均保守拒绝：固定版本的官方存储 API 未提供已验证的跨进程安全删除边界。自动维护仅使用 `stopActivity: false` 归档；旧待删除文件只读报告，绝不执行或改写。这不证明外部写入者空闲。详见[维护与升级边界](docs/troubleshooting.zh-CN.md#清理限制与待删除队列)。

- 这是第三方集成，并非 DeepSeek、Anthropic 或 OpenAI 官方产品。
- 接入 MCP 客户端意味着它可以访问桥接公开的工具。连接通过认证，不等于每次操作都已经得到人的批准。
- 客户端调用 MCP 工具的许可，与实际执行委派任务的 Harness 智能体权限是两层不同控制，需要分别审阅。
- 工作区选择以及“只读”等文字指令不能替代执行沙箱或访问控制策略。
- 提示词、文件、结果和会话元数据可能包含私密信息。只向所选模型供应商和 MCP 客户端共享你有权提供的内容。
- 用适当的操作系统访问控制保护桥接凭据和本地状态，不要提交进仓库或粘贴到报告中。
- 将来可能需要的会话优先归档，不要永久删除。测试清理功能前先备份重要数据。

具体行为和数据位置请以所运行版本的用户指南为准。升级 Harness 或桥接插件后，应重新检查兼容性和权限。
