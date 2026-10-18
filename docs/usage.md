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
| `delete_session` | Read-only preview with `confirm: false`; confirmed permanent deletion is unsupported |
| `manage_sessions` | Preview/archive/unarchive workspace sessions; confirmed `delete` always refuses |

`run_task` and `start_task` accept `task` plus optional `workspace`, `sessionId`, `provider`, `model`, `reasoningEffort`, and `title`. Use IDs returned by the bridge; never invent a session ID or derive one from a filesystem path.

## Long tasks, disconnects, and cancellation

The bridge does not impose a duration-based task cancellation. MCP clients can still time out or disconnect. Progress is sent at roughly 30-second intervals when the client supplies an MCP progress token; a client may choose not to display it.

For clients with short call limits:

1. Call `start_task` once and save its `taskId`.
2. Call `wait_task` with a timeout shorter than the client's call timeout, for example `{"taskId":"<returned task ID>","timeoutSec":45}`.
3. If the task is still active, wait again when appropriate. Avoid tight `get_task` polling.

A wait timeout or lost client connection does not request cancellation. Reconnect and use `list_tasks` to find the task before submitting duplicate work. On a Harness restart, inspect whether a task is `interrupted`; the bridge does not promise that every in-flight operation survives a process exit.

Cancellation is not rollback. Files, commands, or provider requests already performed may have effects or charges. Wait until the task is terminal and inspect the result before managing its session or assuming all activity has stopped.

Task statuses are `queued`, `running`, `waiting_approval`, `done`, `failed`, `cancelled`, and `interrupted`. Review `error`, `termination`, `approval`, and the actual result as applicable. `done` is not a guarantee that the answer is correct or meets your acceptance criteria.

The official consumed-work fold is applied only to this task's `eventBaseline` suffix. A dropped unrun input maps to `cancelled`, including when an earlier consumed turn completed; `termination.droppedUnrun` and the full `consumedEnd` preserve that distinction. An error ending retains its error details and any result. Bridge-requested cancellation takes priority. Ordinary completed/error/blocked/max-tokens/aborted endings retain their mappings; an unaccounted ending is interrupted.

## Continuing a conversation

Supply the previously returned `sessionId` in a new task request. The bridge can continue its own managed sessions; it refuses to take over a live session held by another owner, and disk restoration requires a session recorded as managed by the bridge.

Model constraints are evaluated for the new task. New-session permission choices do not overwrite the existing session's permissions. Read the returned `effectiveSelection` instead of assuming that a toolbar display alone proves a model request occurred.

## Archive and deletion boundaries

**0.2.4 has no executable permanent-deletion path in the plugin.** `delete_session` and `manage_sessions` with `action: "delete"` remain compatible read-only preview interfaces; every confirmed execution returns `PERMANENT_DELETE_UNSUPPORTED`. Tokens, `confirm: true`, toolbar commands, and pending files cannot authorize deletion. No owner is disposed, workspace membership removed, or ledger entry deleted before refusal.

Old pending-delete files are only read and reported, never executed or rewritten. A malformed or unreadable file is reported explicitly rather than treated as an empty queue. See [upgrade notes](troubleshooting.md#cleanup-limitation-and-pending-deletions) if an older plugin is still running.

Archive keeps session files, cache, ledger, and workspace membership and can be reversed by unarchive. Manual `manage_sessions` archive retains its existing `stopActivity: true` behavior: after refusing active MCP tasks, it can request that other locally reported activity stop and drops the pin. The automatic path is separate and always uses `stopActivity: false`.

An absence of local live agents does not prove every CLI/SDK process is idle. For permanent deletion, inspect and handle the session yourself in the official application or tools; their deletion flows have not been verified here.

### Batch scope and preview

`manage_sessions` accepts:

- `workspace`: required workspace ID, title, or path.
- `action`: `archive`, `unarchive`, or `delete`.
- `mcpOnly`: defaults to `true`. Setting `false` includes personal/non-MCP sessions.
- `olderThanDays`: optional, finite nonnegative age filter.
- `includeArchived`: optional; deletion includes archived sessions by default, and unarchive always considers them.
- `confirm`: omit or set `false` to preview.
- `previewToken`: required for a batch that includes non-MCP sessions; available for other previews. It cannot enable permanent deletion.

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

No new pending-delete records are created. Old pending requests stay untouched, including invalid or legacy entries. All permanent-delete execution refuses before acting on an owner or consuming a preview token.

### Automatic archival

The compatibility key `autoCleanupDays` defaults to **0 (off)**. A positive number enables archival of old MCP-created sessions only. Startup runs after 30 seconds; later passes run about every six hours. The toolbar's immediate-archive button uses the same routine. Changed days take effect on the next pass or immediate action. The MCP enabled switch does not control this separate maintenance setting.

The current recognized highest-generation log supplies the activity timestamp; directory mtime is ignored. Already archived, locally live/busy, recent, unknown/ambiguous, or changed sessions are skipped; failed identity/path/activity checks are reported. Checks repeat after asynchronous reads, and the official call receives `stopActivity: false`. The official registry may refuse reported activity; no stop is requested. This is not a cross-process idleness proof.

Results contain `kind: "auto-archive"`, `schemaVersion: 1`, `archived`, `skipped`, and `failed`; compatibility `deleted` is always **0**. The toolbar distinguishes old cleanup records from these receipts. Archive retains logs, cache, ledger, and workspace membership, supports unarchive, and does not reclaim session-file disk space. The checked JSONL root is `$DSH_HOME/sessions`; custom or case-distinct roots are refused.

## Local data and retention

`DSH_HOME` defaults to `~/.dsh`.

| Path | Contents |
| --- | --- |
| `$DSH_HOME/harness-mcp-token.txt` | Shared authentication secret |
| `$DSH_HOME/mcp-bridge/bridge.log` | Bridge diagnostic log |
| `$DSH_HOME/mcp-bridge/tasks.json` | Active tasks and retained terminal history, including task/result metadata |
| `$DSH_HOME/mcp-bridge/sessions.json` | Ledger of MCP-created sessions |
| `$DSH_HOME/mcp-bridge/pending-deletes.json` | Legacy deletion requests: retained unchanged, read-only diagnostics |
| `$DSH_HOME/mcp-bridge/endpoint.json` | Published local endpoint information |
| `$DSH_HOME/sessions/` | Harness session storage, separate from the bridge's task index |
| `$DSH_HOME/storages/session_projcache/sessions/` | Harness session projection cache used by this version |

The task index retains all active records plus at most 200 terminal records from the last seven days. Expiring a task record is separate from deleting a Harness session. Check `storageError`, `durability`, and `persistenceError` if writes fail; task recovery depends on successfully stored state. At-rest snapshots record `durable`; live records become durable only on a matching successful write receipt. New writes and progress mutations invalidate older receipts, and current write failures report degraded state. Cold load describes the saved snapshot, not unpersisted progress from a prior process.

Treat the entire data directory as private. Task records can contain prompt excerpts, paths, outputs, tool arguments, and approval details. Deleting a session does not by itself erase copies already sent to an MCP client, a model provider, backups, or other logs.
