# dsh-mcp-bridge

English | [简体中文](README.zh-CN.md)

**A visible control panel for Claude Code and Codex delegation to DeepSeek Harness.** Choose the model, provider, workspace, and new-session permissions in Harness; inspect task state through MCP; find and continue the resulting conversations.

This project is for people who want to spend less of their main model's effort on bounded supporting tasks, and make repeated Harness calls and the resulting sessions easier to manage.

> Third-party, unofficial integration. Not affiliated with or endorsed by DeepSeek, Anthropic, or OpenAI. Harness interfaces and MCP clients can change; check the compatibility notes before upgrading.

> **Known data-loss risk in 0.2.2:** permanent cleanup cannot reliably detect a CLI/SDK process writing to the same Harness data home. Keep automatic cleanup off (`autoCleanupDays: 0`), use archiving, and do not use permanent deletion until cross-process protection is implemented. Existing pending deletions still run after plugin startup; neither that setting nor the MCP switch cancels them. If you have queued deletions, read the [cleanup and restart warning](docs/troubleshooting.md#cleanup-limitation-and-pending-deletions) first.

## Why this bridge?

- **Delegate selectively.** Send a narrow review, summary, documentation task, or investigation to Harness, then bring the result back to your main agent.
- **Keep responsibility clear.** The main agent still scopes the task, checks the result, and integrates useful work.
- **Keep controls visible.** Use Harness's toolbar for task constraints and its conversations for context; use MCP status/results to inspect execution rather than relying on a silent handoff.
- **Manage repeated delegation.** Find task IDs after a disconnect, continue managed sessions, and archive conversations you want to keep.

Delegation can reduce the amount of work the main model performs, but it does not guarantee a fixed quota reduction, lower total cost, or faster completion. DeepSeek or your chosen provider can still charge for delegated work, and coordination, retries, and review still consume resources. See [choosing and measuring delegated tasks](docs/delegation.md).

## How it fits together

1. Claude Code, Codex, or another compatible MCP client sends a tool request.
2. The local bridge connects that request to the plugin running in DeepSeek Harness.
3. A Harness agent uses the configured provider, workspace, and execution permissions.
4. The client receives the task result for review and further work.

**A local bridge does not mean local model inference.** Prompts and relevant workspace content may be sent to the provider configured in Harness. Check your provider's terms and your own data-sharing permissions before delegating private material.

The current plugin installs into the **desktop profile**, so that Harness host must be running. This is a good fit if you already use Harness and delegate frequently. A one-off task may not justify the extra installation and process. Harness also has an official CLI; other hosting profiles for this plugin have not been verified. [CLI and hosting FAQ](docs/troubleshooting.md#does-harness-have-a-cli).

## Quick start

Bridge version: **0.2.2**. Target Harness desktop version: **0.2.1-rc.2**. Build with Node.js **22+** and npm. Maintainer-provided verification notes cover Windows; they do not establish support for every platform or MCP client.

```sh
git clone https://github.com/FishCityBee/dsh-mcp-bridge.git
cd dsh-mcp-bridge
npm ci
npm run build
```

Install `dist-package/` with Harness's bundled CLI. Windows PowerShell example, with paths replaced for your installation:

```powershell
& "D:\Program Files\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:\path\to\dsh-mcp-bridge\dist-package"
```

Completely quit Harness, including the tray process, and reopen it. In the bridge toolbar, select your provider/model, a disposable default workspace, and read-only new-session permissions. Leave automatic cleanup off.

Register the relay in the client you use, with its absolute path:

```sh
# Claude Code
claude mcp add --transport stdio --scope user dsh-harness -- node "C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"

# Codex
codex mcp add dsh-harness -- node "C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"
```

Ask the client to call `harness_status`, `list_models`, and `list_workspaces` before starting a task. Then try one small task with no file changes. Model tasks can incur provider charges. See [installation, timeouts, environment variables, and upgrade steps](docs/installation.md) for complete instructions and official client references.

## Controls that matter

- **Model constraints:** single-model mode locks provider/model/effort. Provider mode also locks model/effort unless the user enables caller overrides; the provider stays locked.
- **Execution evidence:** requested and effective model selections are separate. `effectiveSelection` is populated only after the bridge observes a request, and does not prove provider acceptance or billing.
- **Permissions:** new-session presets use Harness's official permission service; that selector leaves existing sessions unchanged. Full access is a high-risk option, not a setup requirement.
- **Task lifecycle:** start, wait, inspect, find, and cancel tasks. Client disconnects are separate from task cancellation; cancellation cannot undo completed effects.
- **Sessions:** continue bridge-managed conversations and archive/unarchive them. Permanent cleanup is currently subject to the warning above.

The default connection uses a local pipe/socket with the stdio relay, without opening a TCP port. Optional HTTP is off by default. Update the plugin and the entire relay together; 0.2.2 uses `tls-pinned-v3` and does not fall back to older handshakes.

## Documentation

- [Installation and Claude Code / Codex setup](docs/installation.md)
- [Configuration, model defaults, and permission boundaries](docs/configuration.md)
- [Tool reference, task recovery, and session maintenance](docs/usage.md)
- [Troubleshooting and FAQ](docs/troubleshooting.md)
- [Delegating useful work](docs/delegation.md)
- [Contributing](CONTRIBUTING.md)
- [Security and responsible reporting](SECURITY.md)

## Permission boundaries

There are two separate decisions: whether your MCP client may call a bridge tool, and whether the Harness agent may perform an operation. Client-side MCP approval is not a replacement for Harness execution approval. Choosing a workspace does not by itself sandbox an agent.

Start in a disposable workspace with a small, read-only task. Keep credentials out of prompts, screenshots, and issue reports. Review substantive results before accepting changes. Back up important session data; keep permanent cleanup disabled while the cross-process issue remains.

## Compatibility and verification

This bridge relies on version-specific Harness APIs and storage behavior. Other Harness versions, alternate profiles, and all client/platform combinations are not implied to be supported.

The repository includes maintainer-written technical records in Chinese: [reliability changes](docs/audit-2026-10-17.md), [desktop transport checks](docs/desktop-2026-10-18.md), and [new-session permission checks](docs/ui-permissions-2026-10-18.md). Their stated test scope and remaining gaps matter; they are not a claim that all security risks or UI paths have been validated.

## Contribute

Bug reports, compatibility checks, translations, and focused pull requests are welcome in English or Chinese. Please read the [contribution guide](CONTRIBUTING.md), and keep secrets and private session content out of public reports.

If this project helps your workflow, a star helps others discover it.

## License

[MIT](LICENSE). The existing copyright and license notices apply.
