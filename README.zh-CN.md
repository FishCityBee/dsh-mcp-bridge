# dsh-mcp-bridge

[English](README.md) | 简体中文

**为 Claude Code／Codex 调用 DeepSeek Harness 提供一个可视化控制台。** 在 Harness 中选择模型、供应商、工作区和新会话权限，通过 MCP 检查任务状态，并找回、继续这些调用产生的会话。

这个项目适合希望减少主模型在辅助任务上投入，并改善反复调用 Harness 和大量会话管理的人。

> 第三方非官方集成，与 DeepSeek、Anthropic、OpenAI 无隶属或背书关系。Harness 接口和 MCP 客户端可能变化，升级前请检查兼容性说明。

> **0.2.4 自动维护仅归档：** 插件所有永久删除执行入口均已关闭。兼容配置键 `autoCleanupDays` 现在只归档符合条件的 MCP 会话，保留文件，并使用官方非停止活动选项；`0` 关闭自动归档。旧待删除文件保持原样，绝不自动执行。详见[维护边界与升级说明](docs/troubleshooting.zh-CN.md#清理限制与待删除队列)。

## 为什么做这个桥接？

- **有选择地委派。** 把范围清楚的审查、总结、文档或调查任务交给 Harness，再将结果带回主智能体。
- **明确谁负责。** 主智能体仍负责拆分任务、检查结果和整合可用的工作。
- **让控制可见。** 在 Harness 工具栏设置任务约束，在会话中查看上下文，并通过 MCP 状态和结果了解执行情况，减少不透明的交接。
- **管理反复委派。** 断线后找回任务 ID，继续桥接管理的会话，将需要保留的对话归档。

委派可能减少主模型承担的工作，但不保证固定比例的额度节省，也不保证总成本或耗时更低。DeepSeek 或所选供应商仍可能收费，协调、重试和审阅也会消耗资源。详见[如何选择和衡量委派任务](docs/delegation.zh-CN.md)。

## 它如何配合你的工作？

1. Claude Code、Codex 或其他兼容的 MCP 客户端发出工具请求。
2. 本地桥接把请求连接到 DeepSeek Harness 中运行的插件。
3. Harness 智能体按配置的供应商、工作区和执行权限开展任务。
4. 客户端收到结果，再进行审阅和后续工作。

**本地桥接不代表模型在本地推理。** 提示词和相关工作区内容可能被发送到 Harness 中配置的供应商。委派私密内容前，请核对供应商条款和你自己的数据共享权限。

当前插件安装到 **desktop profile**，因此需要对应 Harness 宿主持续运行。它更适合已经使用 Harness、经常委派任务的人；只做一次小任务时，额外安装和运行进程可能不划算。Harness 自身也有官方 CLI，本插件在其他宿主 profile 的兼容性尚未验证。参阅 [CLI 与宿主 FAQ](docs/troubleshooting.zh-CN.md#harness-有-cli-吗)。

## 快速开始

桥接版本：**0.2.4**。目标 Harness 桌面版本：**0.2.1-rc.2**。使用 Node.js **22+** 和 npm 构建。维护者的验证记录覆盖 Windows，但不代表所有平台和 MCP 客户端均受支持。

```sh
git clone https://github.com/FishCityBee/dsh-mcp-bridge.git
cd dsh-mcp-bridge
npm ci
npm run build
```

使用 Harness 自带 CLI 安装 `dist-package/`。Windows PowerShell 示例，请替换为实际安装路径：

```powershell
& "D:\Program Files\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:\path\to\dsh-mcp-bridge\dist-package"
```

完全退出 Harness，包括托盘进程，再重新打开。在桥接工具栏中选择供应商／模型、一个可丢弃的默认工作区，以及只读新会话权限。自动归档默认关闭；了解处理范围后再启用。

在所用客户端中注册中转脚本，使用它的绝对路径：

```sh
# Claude Code
claude mcp add --transport stdio --scope user dsh-harness -- node "C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"

# Codex
codex mcp add dsh-harness -- node "C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"
```

先让客户端调用 `harness_status`、`list_models`、`list_workspaces`，再尝试一个不修改文件的小任务。模型任务可能产生供应商费用。完整安装、超时、环境变量和升级步骤，以及官方客户端参考，见[安装指南](docs/installation.zh-CN.md)。

## 关键控制

- **模型约束：** 单模型模式锁定供应商、模型和等级；供应商模式默认也约束模型和等级，只有用户开启调用方覆盖后才可选择，供应商始终锁定。
- **执行证据：** 请求选择和实际选择分开记录；桥接观察到请求后才填写 `effectiveSelection`，不据此证明供应商接收或计费。
- **权限：** 新会话预设调用 Harness 官方权限服务，该选择器不改变已有会话。完全权限属于高风险选项，不是安装要求。
- **任务生命周期：** 启动、等待、查看、找回和取消任务；客户端断线与取消任务不同，取消不能撤销已经产生的效果。
- **会话：** 继续桥接管理的对话，归档或取消归档；自动维护只有归档，永久删除暂不可用。

默认通过 stdio 中转脚本和本机管道／socket 连接，不开启 TCP 端口；可选 HTTP 默认关闭。插件和整个中转脚本必须同步更新，0.2.4 使用 `tls-pinned-v3`，不降级兼容旧握手。

## 文档

- [安装与 Claude Code／Codex 接入](docs/installation.zh-CN.md)
- [配置、模型默认规则与权限边界](docs/configuration.zh-CN.md)
- [工具参考、任务恢复与会话维护](docs/usage.zh-CN.md)
- [排障与常见问题](docs/troubleshooting.zh-CN.md)
- [如何委派合适的任务](docs/delegation.zh-CN.md)
- [贡献指南](CONTRIBUTING.zh-CN.md)
- [安全与负责任报告](SECURITY.md#安全说明)

## 权限边界

MCP 客户端是否可以调用桥接工具，与 Harness 智能体是否可以执行某个操作，是两个独立的决定。客户端的 MCP 审批不能替代 Harness 的执行审批。选择工作区本身也不构成沙箱。

建议先在可丢弃的工作区试一个小型只读任务。不要在提示词、截图或 Issue 中提供凭据。接受变更前先审阅实质结果。请备份重要会话数据。在官方提供可靠的跨进程安全删除边界之前，插件永久删除保持关闭。

## 兼容性与验证范围

桥接依赖特定版本的 Harness API 和存储行为，不意味着已支持其他 Harness 版本、其他 profile 或所有客户端／平台组合。

仓库保留了维护者撰写的中文技术记录：[可靠性改动](docs/audit-2026-10-17.md)、[桌面连接验证](docs/desktop-2026-10-18.md)、[新会话权限验证](docs/ui-permissions-2026-10-18.md)。请留意其中的测试范围和未覆盖部分，不应据此认为所有安全风险或 UI 路径都已验证。

## 参与贡献

欢迎用中文或英文提交缺陷报告、兼容性验证、翻译和范围清楚的 Pull Request。请先阅读[贡献指南](CONTRIBUTING.zh-CN.md)，不要把密钥和私密会话内容放进公开报告。

如果这个项目对你有用，欢迎点个 Star，让更多人发现它。

## 许可证

[MIT](LICENSE)，沿用现有版权及许可声明。

当前自动归档与落盘回执修订见 [0.2.4 维护说明](docs/recheck-0.2.4.md)，请区分新版本验证状态与历史测试记录。
