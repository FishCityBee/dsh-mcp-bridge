# Installation and client setup

English | [简体中文](installation.zh-CN.md) | [README](../README.md)

These instructions describe bridge **0.2.2**, based on commit `6dca66e1b099d4bcd50860a25c26496ecc770dce`.

## Requirements and compatibility

- DeepSeek Harness desktop **0.2.1-rc.2**, with a working provider/model and a workspace.
- Node.js **22 or later**, npm, and Git for building from source.
- An MCP client that can launch a local stdio server on the same computer as Harness.

The project targets the Harness version above. Its included [desktop notes](desktop-2026-10-18.md) and [permission notes](ui-permissions-2026-10-18.md) report Windows checks. Those are maintainer-provided records, not a guarantee for other Harness versions, platforms, or MCP clients. The configuration examples below are not a claim of end-to-end testing in every client.

## Build from source

```sh
git clone https://github.com/FishCityBee/dsh-mcp-bridge.git
cd dsh-mcp-bridge
npm ci
npm run build
```

The build produces `dist-package/`. The source package is private and these instructions do not assume an npm-published release. Keep the source checkout and its built bundle in a stable location.

## Install into Harness

Use the CLI bundled with your Harness installation to add `dist-package/` to the desktop profile. This is a Windows PowerShell example; replace both paths with your actual paths:

```powershell
& "D:\Program Files\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:\path\to\dsh-mcp-bridge\dist-package"
```

Completely quit Harness, including its tray process, then reopen it. Look for the bridge toolbar in the lower-right corner. Configure its model/provider, default workspace, and new-session permission before submitting work.

On the first successful startup, the plugin creates `$DSH_HOME/harness-mcp-token.txt`. `$DSH_HOME` defaults to `~/.dsh`; `~` means the home directory of the account running Harness. The MCP relay must use the same data home and account, or be explicitly configured to reach the intended instance.

Do not print or copy the token into a prompt, issue, or shared configuration. The relay reads the default token file automatically.

## Claude Code

Register the relay, substituting its absolute path:

```sh
claude mcp add --transport stdio --scope user dsh-harness -- node "C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"
claude mcp list
```

User scope makes the server available across your Claude Code projects. Use `/mcp` inside Claude Code to inspect or reconnect it. The server must be allowed by your client and workspace policies. See the [official Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

For long calls, an optional server JSON definition can set a timeout in milliseconds. Add it through the client's JSON configuration flow, replacing the existing entry rather than registering a second copy:

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"],
  "timeout": 86400000
}
```

This is a 24-hour client limit, not a task-completion guarantee. Progress notifications do not extend a hard client timeout. Automatic backgrounding depends on Claude Code version and settings. [Official timeout/background behavior](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls).

## Codex

Register the same stdio relay:

```sh
codex mcp add dsh-harness -- node "C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"
codex mcp list
```

Alternatively, add one table to `~/.codex/config.toml`, or edit the entry created by the command:

```toml
[mcp_servers.dsh-harness]
command = "node"
args = ["C:/path/to/dsh-mcp-bridge/dist-package/bin/stdio.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 3600
```

The example allows 30 seconds for startup and one hour per tool call. Adjust the limits to your workflow, or use `start_task` with bounded `wait_task` calls. Codex's MCP view is available through `/mcp` in its TUI. [Official Codex MCP configuration](https://developers.openai.com/codex/mcp/).

On Windows, forward slashes avoid backslash-escaping problems in JSON and TOML paths. If the client cannot find `node`, use the absolute path to your Node executable.

These are local-client instructions. A remote or hosted client cannot reach a local pipe just because the server is listed in a local configuration file.

## Verify without submitting model work

Ask the client to call `harness_status`, then `list_models` and `list_workspaces`. Check that:

- The bridge is enabled, and `startupError` and `storageError` are empty/null.
- The provider/model and workspace are the ones you intended.
- `newSessionPermission` and `harnessDefaultPermission` match your expectations.

These tools inspect bridge/Harness state; they do not launch an agent task. A subsequent `run_task` or `start_task` may send content to your configured provider and incur charges.

## Upgrading

If your installation has queued deletions, read the [known cleanup limitation](troubleshooting.md#cleanup-limitation-and-pending-deletions) before restarting or reloading. Turning automatic cleanup off does not cancel the pending-delete queue.

1. Let active tasks finish, or deliberately cancel them and check their state.
2. Back up important Harness data and record the working bridge revision.
3. Completely quit Harness and disconnect clients before rebuilding or replacing an installed bundle.
4. Update, install the locked dependencies, and rebuild. If the bundle path changed, update both the Harness installation and the MCP client path.
5. Restart Harness, reconnect the client, and repeat the state checks above.

Update the **plugin and the entire relay `bin/` directory together**. Version 0.2.2 uses `tls-pinned-v3`; it does not fall back to the older plaintext or PSK handshakes. Copying only `stdio.mjs` is insufficient because it imports `pipe-tls.mjs`.

See [configuration and permissions](configuration.md) and [troubleshooting](troubleshooting.md) before changing security settings to solve a connection problem.
