# 安装与客户端接入

[English](installation.md) | 简体中文 | [README](../README.zh-CN.md)

本文对应桥接插件 **0.2.4**。当前安全边界见版本维护说明。

## 环境要求与兼容性

- DeepSeek Harness 桌面端 **0.2.1-rc.2**，已配置可用的供应商／模型和工作区。
- 从源码构建需要 Node.js **22 或更高版本**、npm 和 Git。
- MCP 客户端能够在 Harness 所在的同一台电脑上启动本地 stdio 服务。

项目面向上述 Harness 版本。仓库的[桌面验证记录](desktop-2026-10-18.md)和[权限验证记录](ui-permissions-2026-10-18.md)记载了 Windows 验证；它们属于维护者提供的记录，不保证其他 Harness 版本、平台或 MCP 客户端均兼容。下方配置示例也不代表每个客户端都完成了端到端实测。

## 从源码构建

```sh
git clone https://github.com/FishCityBee/dsh-mcp-bridge.git
cd dsh-mcp-bridge
npm ci
npm run build
```

构建产物位于 `dist-package/`。源码包标记为 private，本文不假设存在已发布的 npm 安装包。请把源码和构建目录放在稳定的位置。

## 安装到 Harness

使用 Harness 安装目录自带的 CLI，将 `dist-package/` 加入 desktop profile。以下是 Windows PowerShell 示例，两处路径都需要替换为实际路径：

```powershell
& "D:\Program Files\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:\path\to\dsh-mcp-bridge\dist-package"
```

完全退出 Harness，包括托盘进程，再重新打开。右下角应出现桥接工具栏。提交任务前，先选择模型／供应商、默认工作区和新会话权限。

首次成功启动后，插件会创建 `$DSH_HOME/harness-mcp-token.txt`。`$DSH_HOME` 默认是 `~/.dsh`；`~` 指运行 Harness 的账号的主目录。MCP 中转脚本应使用相同账号和数据目录，或明确配置为连接目标实例。

不要打印 token，也不要把它复制到提示词、Issue 或共享配置中。中转脚本会自动读取默认 token 文件。

## Claude Code

注册中转脚本，把路径换成它的绝对路径：

```sh
claude mcp add --transport stdio --scope user dsh-harness -- node "C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"
claude mcp list
```

user scope 会让服务在你的多个 Claude Code 项目中可用。可以在 Claude Code 内使用 `/mcp` 查看状态或重新连接。客户端和工作区策略仍需允许该服务。参阅 [Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)。

较长调用可选择使用带毫秒超时的 JSON 定义。通过客户端的 JSON 配置流程添加，并替换已有条目，避免重复注册：

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"],
  "timeout": 86400000
}
```

这表示客户端允许最多 24 小时，不是任务一定完成的保证。进度通知不会延长客户端的硬超时；自动转后台也取决于 Claude Code 版本和设置。参阅[官方超时与后台行为说明](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls)。

## Codex

注册同一个 stdio 中转脚本：

```sh
codex mcp add dsh-harness -- node "C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"
codex mcp list
```

也可以在 `~/.codex/config.toml` 添加以下配置，或修改上述命令已创建的条目：

```toml
[mcp_servers.dsh-harness]
command = "node"
args = ["C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 3600
```

此示例允许启动等待 30 秒、单次工具调用一小时。按自己的流程调整，或使用 `start_task` 配合有时间上限的 `wait_task`。Codex TUI 中可以用 `/mcp` 查看服务。参阅 [Codex 官方 MCP 配置文档](https://developers.openai.com/codex/mcp/)。

Windows 路径使用正斜杠，可以避免 JSON 和 TOML 中的反斜杠转义问题。客户端找不到 `node` 时，可改用 Node 可执行文件的绝对路径。

以上是本地客户端接入方式。仅在本地配置文件中加入服务，并不会让远程或托管客户端获得访问本机管道的能力。

## 不启动模型任务的接入检查

让客户端依次调用 `harness_status`、`list_models` 和 `list_workspaces`，检查：

- 桥接已启用，`startupError` 和 `storageError` 为空／null。
- 供应商、模型和工作区符合预期。
- `newSessionPermission` 和 `harnessDefaultPermission` 符合预期。

这些工具读取桥接／Harness 状态，不启动智能体任务。之后的 `run_task` 或 `start_task` 可能向所配置供应商发送内容并产生费用。

## 升级

从 0.2.2 升级时，应先停止旧插件，再载入修复版本：旧版待删除执行器存在风险。0.2.4 只读报告旧待删除记录，不执行、不改写。请阅读[升级边界](troubleshooting.zh-CN.md#清理限制与待删除队列)。

1. 等待活动任务结束，或明确取消后检查状态。
2. 备份重要 Harness 数据，并记录当前可用的插件版本。
3. 重建或替换已安装目录前，完全退出 Harness 并断开客户端连接。
4. 更新源码、安装锁定依赖并重新构建。产物路径改变时，同步更新 Harness 安装位置和 MCP 客户端路径。
5. 重启 Harness、重连客户端，并重复上述状态检查。

**插件与整个中转脚本 `bin/` 目录必须一起更新。** 0.2.4 使用 `tls-pinned-v3`，不会降级兼容旧明文或 PSK 握手。不能只复制 `stdio.mjs`，因为它还导入 `pipe-tls.mjs`。

为排除连接问题而修改安全设置前，请先阅读[配置与权限](configuration.zh-CN.md)和[排障指南](troubleshooting.zh-CN.md)。
