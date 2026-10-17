# Tasks and session maintenance

English | [简体中文](usage.zh-CN.md) | [README](../README.md)

## First task

After the [state checks](installation.md#verify-without-submitting-model-work), select a disposable default workspace and the read-only new-session preset. A minimal `run_task` input is:

```json
{
  "task": "Reply with BRIDGE_OK. Do not run tools or change files.",
  "title": "Connection check"
}
```

This launches model work and can incur provider charges. Omitted model/provider/effort use the [toolbar constraints](configuration.md); omitted workspace uses the toolbar default. Keep the returned `taskId` and `sessionId`: they identify different things.

- A **task** is one submitted unit of work and its result/status.
- A **session** holds conversation context and can be used for subsequent tasks.

## Tool reference

| Tool | Purpose and important inputs |
| --- | --- |
| `harness_status` | Inspect enabled state, model mode, permissions, configuration version, and startup/storage errors |
| `list_models` | Inspect the model choices currently allowed by the toolbar |
| `list_workspaces` | List Harness workspace IDs, titles, and paths |
| `list_sessions` | List a workspace's sessions; `workspace` required, `includeArchived` optional |
| `run_task` | Start and wait for one task |
| `start_task` | Start a task and return its `taskId` without waiting for completion |
| `wait_task` | Wait by `taskId`; optional `timeoutSec` bounds this wait, not the task |
| `get_task` | Retrieve an immediate task snapshot |
| `list_tasks` | Find recent tasks; optional `activeOnly` and `limit` |
| `cancel_task` | Request cancellation by `taskId`; check the resulting state |
| `delete_session` | Permanently delete one `sessionId`; `confirm` is required, and `false` previews |
| `manage_sessions` | Preview/archive/unarchive/delete workspace sessions with explicit scope filters |

`run_task` and `start_task` accept `task` plus optional `workspace`, `sessionId`, `provider`, `model`, `reasoningEffort`, and `title`. Use IDs returned by the bridge; never invent a session ID or derive one from a filesystem path.

## Long tasks, disconnects, and cancellation

The bridge does not impose a duration-based task cancellation. MCP clients can still time out or disconnect. Progress is sent at roughly 30-second intervals when the client supplies an MCP progress token; a client may choose not to display it.

For clients with short call limits:

1. Call `start_task` once and save its `taskId`.
2. Call `wait_task` with a timeout shorter than the client's call timeout, for example `{"taskId":"<returned task ID>","timeoutSec":45}`.
3. If the task is still active, wait again when appropriate. Avoid tight `get_task` polling.

A wait timeout or lost client connection does not request cancellation. Reconnect and use `list_tasks` to find the task before submitting duplicate work. On a Harness restart, inspect whether a task is `interrupted`; the bridge does not promise that every in-flight operation survives a process exit.

Cancellation is not rollback. Files, commands, or provider requests already performed may have effects or charges. Wait until the task is terminal and inspect the result before deleting its session or assuming all activity has stopped.

Task statuses are `queued`, `running`, `waiting_approval`, `done`, `failed`, `cancelled`, and `interrupted`. Review `error`, `termination`, `approval`, and the actual result as applicable. `done` is not a guarantee that the answer is correct or meets your acceptance criteria.

## Continuing a conversation

Supply the previously returned `sessionId` in a new task request. The bridge can continue its own managed sessions; it refuses to take over a live session held by another owner, and disk restoration requires a session recorded as managed by the bridge.

Model constraints are evaluated for the new task. New-session permission choices do not overwrite the existing session's permissions. Read the returned `effectiveSelection` instead of assuming that a toolbar display alone proves a model request occurred.

## Archive before deleting

> **Known issue in 0.2.2:** the bridge's local checks cannot reliably detect another CLI/SDK process writing to the same data home. Permanent cleanup can remove an active session in that situation. Keep `autoCleanupDays: 0`, use archiving, and do not use permanent deletion until cross-process protection is implemented. The deletion reference below documents the current interface; it is not a recommendation to use it or a claim that cleanup has passed complete safety validation.

Existing pending deletions are separate: they are still processed about five seconds after plugin startup, even with automatic cleanup off or the MCP switch disabled. If you have queued deletions, arrange safe handling or a fixed version before restarting/reloading the plugin. See the [pending-deletion warning](troubleshooting.md#cleanup-limitation-and-pending-deletions).

Archiving is the preferred option when you might want a conversation again. Permanent deletion removes session storage and associated projection cache; it is not a move to an ordinary recoverable trash folder.

In this version, `manage_sessions` archives with `stopActivity: true`: it requests that Harness stop the session's activity and removes its pin. Archiving is therefore not just hiding a conversation. The bridge rejects sessions with active MCP tasks; archiving other eligible sessions can stop their activity.

Back up important data. Avoid cleanup while another Harness instance or process may be writing to the same data home. Do not treat in-process “not busy” checks as a guarantee about other processes.

### Batch scope and preview

`manage_sessions` accepts:

- `workspace`: required workspace ID, title, or path.
- `action`: `archive`, `unarchive`, or `delete`.
- `mcpOnly`: defaults to `true`. Setting `false` includes personal/non-MCP sessions.
- `olderThanDays`: optional, finite nonnegative age filter.
- `includeArchived`: optional; deletion includes archived sessions by default, and unarchive always considers them.
- `confirm`: omit or set `false` to preview.
- `previewToken`: required to execute deletion or any batch that includes non-MCP sessions.

A non-destructive archive preview example:

```json
{
  "workspace": "<workspace ID returned by list_workspaces>",
  "action": "archive",
  "mcpOnly": true,
  "confirm": false
}
```

Read the exact target IDs before deciding. For an approved execution, submit the same workspace/action/scope with `confirm: true` and the returned `previewToken` within **60 seconds**. The token binds concrete IDs and their recorded versions. New matching sessions are not added to that preview. If it expires or a target changes, preview and review again; do not bypass the check.

`confirm: true` is a caller-supplied value, not independent evidence that a person approved. The calling client must obtain the appropriate user authorization. The single-session `delete_session` flow does not use a batch preview token; review the specific session and use `confirm: false` first.

A live session's removal may be queued until its owner releases it. A queued response does not mean all files have been removed. Changed or unsupported sessions can fail validation and require a fresh review.

### Automatic cleanup

`autoCleanupDays` defaults to **0 (off)**. Keep it off while the cross-process issue above remains. Setting a positive age enables permanent deletion of eligible MCP-created sessions without a new per-session confirmation. It runs after startup, periodically (about every six hours), and when the age setting changes.

Age filtering uses the modification time of the recognized current highest-generation session log, not the session directory's modification time. This is a storage timestamp, not a general semantic guarantee of “no useful recent work.” Live/busy sessions are excluded by the bridge's local checks. Unknown or ambiguous activity cannot justify automatic expiry.

These operations are intended for the checked JSONL storage root `$DSH_HOME/sessions`; do not use custom roots. Path and identity checks reduce risk; they do not make permanent cleanup reversible or establish isolation from every external process.

## Local data and retention

`DSH_HOME` defaults to `~/.dsh`.

| Path | Contents |
| --- | --- |
| `$DSH_HOME/harness-mcp-token.txt` | Shared authentication secret |
| `$DSH_HOME/mcp-bridge/bridge.log` | Bridge diagnostic log |
| `$DSH_HOME/mcp-bridge/tasks.json` | Active tasks and retained terminal history, including task/result metadata |
| `$DSH_HOME/mcp-bridge/sessions.json` | Ledger of MCP-created sessions |
| `$DSH_HOME/mcp-bridge/pending-deletes.json` | Pending deletion IDs and log versions |
| `$DSH_HOME/mcp-bridge/endpoint.json` | Published local endpoint information |
| `$DSH_HOME/sessions/` | Harness session storage, separate from the bridge's task index |
| `$DSH_HOME/storages/session_projcache/sessions/` | Harness session projection cache used by this version |

The task index retains all active records plus at most 200 terminal records from the last seven days. Expiring a task record is separate from deleting a Harness session. Check `storageError`, `durability`, and `persistenceError` if writes fail; task recovery depends on successfully stored state.

Treat the entire data directory as private. Task records can contain prompt excerpts, paths, outputs, tool arguments, and approval details. Deleting a session does not by itself erase copies already sent to an MCP client, a model provider, backups, or other logs.
