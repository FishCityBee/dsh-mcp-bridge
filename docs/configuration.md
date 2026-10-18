# Configuration and permissions

English | [简体中文](configuration.zh-CN.md) | [README](../README.md)

This page describes bridge 0.2.4. Use `harness_status` to inspect current configuration and storage health, and `list_models` to see the choices currently permitted to the caller.

## Model selection

The toolbar controls task constraints. There is no hard-coded universal DeepSeek model name in the bridge: available providers, models, and reasoning levels come from Harness.

| Mode | Provider | Model and reasoning |
| --- | --- | --- |
| Single model | Locked | Locked |
| Provider; caller overrides off (default) | Locked | Toolbar defaults are constraints |
| Provider; caller overrides on | Locked | Caller may choose a supported model/level within that provider |

Normally omit `provider`, `model`, and `reasoningEffort` from a task request. Supply model/effort only when the user explicitly requests them and the toolbar permits overrides. A conflicting explicit value produces `CONFIG_CONFLICT` rather than silently changing the selected route.

When fields are empty:

- Single-model provider/model fall back to Harness's current default selection.
- Provider mode's provider falls back to the provider in that selection.
- Provider mode's model falls back to the first model in that provider's catalog if no toolbar default is set.
- Reasoning falls back to that model's catalog default. In a locked mode, an old unsupported configured level is an error. With overrides enabled, a configured level unsupported by the caller's chosen model is skipped in favor of that model's default; an explicitly requested unsupported level is an error.

Set explicit toolbar choices if you need predictable routing rather than catalog-order fallbacks.

## When changes take effect

- Already running tasks keep their startup configuration snapshot.
- Queued tasks re-check current configuration before starting, after obtaining execution capacity and the session lock.
- A settings change during asynchronous preparation can cause a conflict instead of starting under ambiguous configuration. Check current state before retrying.
- Changing toolbar settings does not restart the plugin. Turning the MCP switch off is not an emergency stop for work already running; use task cancellation or Harness's own controls.

Results distinguish `requestedSelection`, `effectiveSelection`, `configVersion`, and `configSource`. Legacy top-level provider/model fields describe task constraints. `effectiveSelection` remains `null` until the bridge observes a real request envelope through Harness's `llm/stream` event. This confirms what the bridge observed, not that a provider accepted, completed, or billed the request.

## Workspace selection

For a new session, an explicit `workspace` takes precedence over the toolbar default. It can identify an existing workspace by ID, title, or path. An explicitly supplied existing directory can also cause a Harness workspace to be created for that directory. Omitting `workspace` requires a valid toolbar default; the bridge does not substitute the caller's current directory.

When continuing with `sessionId`, the existing session supplies its workspace context. Do not use `workspace` to try to relocate an existing session. A live session owned elsewhere is rejected rather than taken over. Workspace selection alone does not impose a security boundary.

## New-session permissions

The toolbar uses Harness's official permission presets for **new MCP sessions only**:

| Choice | Preset | Standard sandbox / approval policy |
| --- | --- | --- |
| Harness new-session default | `default` in bridge configuration | Uses Harness's current new-session default |
| View only | `read-only` | `read-only` / `ask` |
| Workspace access | `workspace-write` | `workspace-write` / `ask` |
| Full access | `danger-full-access` | `danger-full-access` / `never` |

`default` is the migration and configuration default. It does **not** necessarily mean read-only; inspect `harnessDefaultPermission`. For an initial read-only trial, explicitly select the read-only preset.

**Full access removes the normal sandbox restriction and can permit commands or file changes beyond the workspace.** Select it only when you understand and intend that access. It is not needed merely to connect an MCP client.

The new-session selector does not overwrite continued/restored sessions, including permission changes made by a person in Harness, and does not change Harness's global default. If a requested preset is unavailable, startup fails instead of falling back to a broader preset. An explicit legacy `approvalMode` can still change the approval policy on bridge-managed continuations; keep it at `inherit` to preserve that policy.

`never` means requests that require approval are rejected without asking; it does not mean “approve everything.” Operations already allowed by a preset may proceed without an approval request. A one-time approval is not converted into a persistent grant.

## Separate approval layers

1. The MCP client's rules decide whether it may call `run_task`, session-management tools, or other exposed tools.
2. Harness's session sandbox and approval policy govern the delegated agent's operations.
3. Operating-system prompts and any external review layer remain separate.

An `approval/asked` event is evidence of an approval request, not proof that a particular window was displayed. Check Harness when the task reports a pending approval. Do not solve a client timeout by granting broader execution permissions.

### Legacy settings

- `autoApprove` is ignored and is not an authorization source.
- `approvalMode` (`inherit`, `ask`, `never`) remains for backend compatibility. Explicit `ask`/`never` can apply to managed continuations and restoration as well. The new UI resets it to `inherit` when an explicit new-session preset is chosen, so the full preset controls both sandbox and approval policy.
- `providerAllowOverrides` defaults to `false`, including when missing in old configuration. This is an intentional change from the original provider-mode behavior.

## Automatic archival

`autoCleanupDays` keeps its legacy name for compatibility. Its value now means **automatic archival only**: `0` disables it, a positive number selects MCP-created sessions whose recognized current log is older than that many days. It runs 30 seconds after plugin startup and about every six hours; the toolbar's immediate-archive button uses the same implementation. Changes take effect on the next pass or immediate action. It is independent of the MCP enabled switch.

Automatic archival skips already archived, live/busy, recent, unknown-activity, changed, and invalid-boundary sessions. It passes `stopActivity: false` to the official registry, preserves files and the MCP ledger, and can be undone with unarchive. This does not establish that every external process is idle or reclaim session-file disk space. `harness_status.automaticArchive` reports configuration and the latest result; the compatibility field `automaticCleanupActive` now refers to archive-only maintenance.

`cleanupStatus` now stores a versioned `kind: "auto-archive"` receipt with `archived`, `skipped`, and `failed`; `deleted` is always `0` for compatibility. Historical or malformed cleanup records are not displayed as new archive results. `harness_status.permanentDeletion.pending` reports retained pending counts or an unreadable state without modifying the old file.

## Transport and environment

The default connection is local stdio → relay → Windows named pipe or Unix socket → Harness plugin. It does not open a TCP port. The default pipe is `\\.\pipe\dsh-mcp-bridge-<username>` on Windows, or `$DSH_HOME/mcp-bridge/bridge.sock` elsewhere.

The relay uses TLS 1.3 and token-derived, role-specific public-key pins (`tls-pinned-v3`). It verifies the peer before forwarding MCP traffic. This authenticates possession of the shared token; it is not verification of a Windows process signature. Protect the token and local files even when the transport is encrypted.

| Relay variable | Meaning |
| --- | --- |
| `DSH_HOME` | Harness data home; default `~/.dsh` |
| `DSH_MCP_BRIDGE_PIPE` | Explicit pipe/socket address; otherwise use published `endpoint.json`, then platform default |
| `DSH_MCP_BRIDGE_TOKEN` | Secret token override; otherwise read the default token file |
| `DSH_MCP_BRIDGE_WAIT_MS` | Connection retry window in milliseconds; default `15000` |

For Codex, explicitly forward a needed non-secret variable with its `env_vars` option, or set it in the server's `env` table. Follow the client's own environment syntax; do not assume every GUI client inherits a terminal's environment.

Host settings include `pipePath`, `authTokenFile`, `preset`, and `maxConcurrentTasks` (default `2`). Changing these non-toolbar transport/runtime fields may require a plugin reload/restart. A custom host token-file path is not automatically read by the relay; align the configuration deliberately and keep any secret override private.

Optional Streamable HTTP is disabled by default (`httpEnabled: false`). When enabled, the default is `http://127.0.0.1:8090/mcp`, using bearer-token authentication. This optional HTTP listener is not TLS-encrypted by the bridge. Do not expose it to an untrusted network or treat a loopback address as per-client isolation. Prefer the local relay unless you have a specific requirement.

For storage and destructive-operation behavior, see [tasks and session maintenance](usage.md).
