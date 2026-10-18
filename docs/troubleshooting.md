# Troubleshooting and FAQ

English | [简体中文](troubleshooting.zh-CN.md) | [README](../README.md)

## Start here

Record the bridge revision, Harness version, Node version, operating system, and MCP client/version. Check `harness_status` and the relevant, redacted portion of `$DSH_HOME/mcp-bridge/bridge.log`. Never share the token file or a complete private session archive.

When upgrading an older installation with pending deletions, read the version-specific maintenance notes below before restarting the old plugin.

## The client cannot connect

1. Confirm the intended Harness desktop host is running and the plugin loaded.
2. Check the client points to the actual `dist-package/bin/stdio.mjs`, with `pipe-tls.mjs` beside it.
3. Confirm the client can launch Node 22+; GUI applications may have a different `PATH`.
4. Confirm the relay and Harness use the same account, `DSH_HOME`, endpoint, and token configuration.
5. After an upgrade, reconnect the MCP client. Old relay processes do not automatically become new ones.

`PIPE_SERVER_AUTH_FAILED`, handshake failures, or missing-module errors commonly call for checking bundle/relay versions and paths. Do not disable TLS checks or expose the HTTP endpoint to work around them. `TOKEN_EMPTY` or token read errors require checking the intended file and its permissions; do not publish, overwrite, or regenerate credentials blindly.

## `CONFIG_CONFLICT` or unexpected model choices

Read `harness_status` and `list_models`. By default, provider mode does not let the caller override the model or reasoning level. Omit guessed route parameters and let the toolbar settings apply. If you intentionally need caller overrides, change that setting yourself and choose a supported value.

A task queued before a settings change can fail at admission if its explicit parameters conflict. A live session owned by another Harness component is also rejected rather than retargeted. Inspect the error before retrying, and do not duplicate a task that is already active.

`effectiveSelection: null` means the bridge has not observed a matching model request for the task. It is not proof that a particular provider was used.

## The task waits for approval or an operation is rejected

Open the relevant Harness session and inspect its actual permission preset and approval state. The MCP client's permission to call the bridge does not approve the agent's file or command operations.

The new-session selector affects only future new sessions. Changing it does not broaden the permissions of an existing session. `never` rejects operations that require approval; it is not an automatic-approval mode. Do not select full access merely to suppress a prompt.

## Calls time out or no progress appears

Check whether the underlying task is still active with `list_tasks` or `get_task`. Then use `wait_task` instead of resubmitting. For a client with short tool limits, use `start_task` plus bounded waits. Progress display requires client support and an MCP progress token.

Client timeouts, bridge wait limits, and task cancellation are different. See [long-task guidance](usage.md#long-tasks-disconnects-and-cancellation).

## Workspace or session errors

- **No default workspace:** choose one in the toolbar, or explicitly specify the intended workspace. Do not substitute the caller's current directory automatically.
- **`SESSION_NOT_MANAGED`:** disk restoration is limited to bridge-managed sessions. Select a managed session returned by the bridge or start a new one.
- **`SESSION_BUSY`:** wait for the existing activity/cancellation to settle. Do not use deletion to force the issue.
- **`UNSUPPORTED_SESSION_STORAGE`:** this version only supports the checked `$DSH_HOME/sessions` JSONL root for session operations. Do not move files or bypass validation to force compatibility.

## Storage errors

`startupError`, `storageError`, `durability: degraded`, or `persistenceError` mean you should not assume the task index is durably saved. Check disk space and access to the intended data directory, preserve a backup, and collect a redacted error report. Do not “fix” a parse error by deleting `tasks.json`, `sessions.json`, or pending-delete state without understanding the consequences.

## Cleanup limitation and pending deletions

**0.2.4 refuses all plugin permanent-deletion execution.** Neither `confirm: true`, a preview token, the toolbar, a legacy mailbox command, nor automatic maintenance can bypass this. If permanent deletion is required, inspect and handle it yourself in the official application or tools; those deletion flows have not been verified here. No `rm` workaround is recommended.

`autoCleanupDays` now controls automatic archival only; `0` disables it. Old `pending-deletes.json` data is retained byte-for-byte and never executed, cleared, or migrated as completed, regardless of the MCP switch or archival setting. `harness_status.permanentDeletion.pending` reports its count or an explicit unreadable state. Invalid JSON and read errors are not treated as an empty queue.

These guarantees apply to the fixed plugin, not a still-running 0.2.2 installation. Before upgrading/reloading an older version with queued deletion requests, stop that old plugin and keep a backup. Do not erase its queue just to hide a warning. The fixed version does not repair data already deleted by an older version.

Automatic archival preserves logs, cache, ledger, and workspace accounting and uses `stopActivity: false`. It skips local live/busy and uncertain sessions and allows the official activity check to refuse archival. It does not prove cross-process idleness and does not reclaim session-file space.

## Does Harness have a CLI?

Yes. The official Harness project includes CLI, headless, SDK, ACP, and web-related workflows. See the [CLI README for the targeted Harness release](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/apps/cli/README.md).

This repository currently documents installing its plugin into the desktop profile and using that running host. That is not a claim that Harness has no CLI. A separately hosted/background profile for this bridge would need configuration and compatibility validation; it is not established by the desktop installation instructions. The CLI does not start the reserved desktop profile as an ordinary CLI session.

## Is it free? Does it bypass Claude or Codex quotas?

No fixed savings or free inference are promised. The bridge delegates work to the provider configured in Harness. Provider charges and the main agent's coordination/review costs still apply. It does not alter provider billing or grant extra Claude/Codex entitlement. Measure the complete workflow rather than assuming every delegated task is cheaper.

## Is this the right workflow for me?

It is most useful when you already use Harness, repeatedly delegate bounded work, and want visible model/permission controls plus reusable sessions. If you only need a single direct model call, the additional plugin, build, and running desktop host may be unnecessary overhead.

For unresolved issues, use the [bug template](../.github/ISSUE_TEMPLATE/bug_report.md) and the [contribution guide](../CONTRIBUTING.md). For security problems, follow [SECURITY.md](../SECURITY.md) without posting exploit details publicly.
