// Offline smoke test: loads the built host face with a fake Harness ctx, then
// drives it through bin/stdio.mjs over the local pipe with the real MCP SDK client.
import { mkdtemp, mkdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'

const root = fileURLToPath(new URL('..', import.meta.url))
const home = await mkdtemp(join(tmpdir(), 'dmb-home-'))
const workdir = await mkdtemp(join(tmpdir(), 'dmb-ws-'))
process.env.DSH_HOME = home
process.env.DSH_MCP_BRIDGE_PROGRESS_MS = '200'
process.env.DSH_MCP_BRIDGE_MONITOR_MS = '100'
await writeFile(join(home, 'harness-mcp-token.txt'), 'test-token\n')
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\dmb-smoke-${process.pid}` : join(home, 'smoke.sock')

const { apply } = await import(`file://${root}dist-package/lib/index.js`)
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
const sleep = ms => new Promise(res => setTimeout(res, ms))

// ---- fake Harness services ---------------------------------------------------
const values = {
  enabled: true, mode: 'single', singleProvider: 'opencode', singleModel: 'flash', singleEffort: 'high',
  providerId: 'opencode', providerDefaultModel: 'flash', providerDefaultEffort: '', defaultWorkspace: 'ws-1', autoApprove: false,
  providerAllowOverrides: false, approvalMode: 'inherit', autoCleanupDays: 0, command: '', commandResult: '', cleanupStatus: '',
}
const config = {
  pipePath: pipe, httpEnabled: false, host: '127.0.0.1', port: 0, authTokenFile: '', preset: '', maxConcurrentTasks: 2,
  ...Object.fromEntries(Object.keys(values).map(k => [k, { get: () => values[k] }])),
}
const workspace = {
  id: 'ws-1', title: 'Demo', path: workdir, sessionIds: [],
  async attachSession(id) { this.sessionIds.push(String(id)) },
  async detachSession(id) { this.sessionIds = this.sessionIds.filter(s => s !== String(id)) },
}
const workspaces = [workspace]
const archived = []
const disposers = []
const listeners = {}
let fireVolatileEvents = true
// Mirrors dsh-hmr: settings writes run inside an exclusive transaction and refuse to nest.
const hmr = { executing: new AsyncLocalStorage(), queue: Promise.resolve() }
function runExclusive(operation) {
  if (hmr.executing.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'))
  const task = hmr.queue.then(() => hmr.executing.run(true, operation))
  hmr.queue = task.catch(() => {})
  return task
}
const cancelled = []

// Faithful offline seams: persisted request headers, actual official approval
// decisions, cancellation, and turn/end are independent from whenIdle.
const knownSessions = new Map()
const approval = Object.create(ApprovalService.prototype)
Object.defineProperty(approval, 'ctx', { value: { waterfall(_target, _name, req) {
  return new Promise(resolve => setTimeout(() => resolve('allowed-once'), req.fixtureDelay ?? 100))
} } })
approval.config = { policy: 'ask' }
const waterfall = (table, name, payload, terminal) => {
  const list = table[name] ?? []
  const run = i => list[i] ? (name === 'system-prompt/assemble' ? list[i](payload, {}, () => run(i + 1)) : list[i](payload, () => run(i + 1))) : terminal()
  return run(0)
}
function fakeAgent(sessionId, cwd, options) {
  const messages = [], events = [], hooks = {}
  let idle = Promise.resolve(), controller = new AbortController(), turn = 0
  const agent = {
    id: sessionId, status: 'idle',
    ctx: { on(name, fn, opts) { const list = hooks[name] ??= []; opts?.prepend ? list.unshift(fn) : list.push(fn); return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1) } } },
    session: {
      header: { id: sessionId, cwd }, deriveMessages: () => [...messages], snapshotEvents: (from = 0) => events.slice(from),
      get seq() { return events.length }, eventAt: seq => events[seq],
      append(type, data) { const event = { type, seq: events.length, data }; events.push(event); return event },
      requestHeader: () => events.findLast(e => e.type === 'request/header')?.data.header,
    },
    inject(message) { messages.push(message) },
    followup(message) {
      controller = new AbortController(); agent.status = 'running'; const t = ++turn
      messages.push(message)
      const text = message.content[0].text, delay = Number(/slow:(\d+)/.exec(text)?.[1] ?? 0)
      agent.session.append('turn/start', { turn: t })
      agent.session.append('agent/inbox/spliced', { removedCount: 1, inserted: [] })
      idle = (async () => {
        let reason = { kind: 'completed' }
        try {
          await waterfall(hooks, 'system-prompt/assemble', {}, () => Promise.resolve({ variables: {} }))
          const route = await waterfall(hooks, 'agent/request', { agent }, () => Promise.resolve(agent.session.requestHeader()?.config ?? options.agentOptions))
          agent.session.append('step/start', { turn: t, step: 1 })
          agent.session.append('request/header', { header: { config: route }, reason: 'change' })
          const stream = waterfall(listeners, 'llm/stream', { ...route, sessionId, signal: controller.signal }, () => (async function* () { yield {} })())
          for await (const _chunk of stream) {}
          if (text.includes('approve')) await approval.request({ agent, toolName: 'bash', signal: controller.signal, fixtureDelay: delay })
          else if (delay) await Promise.race([sleep(delay), new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }))])
          if (controller.signal.aborted) reason = { kind: 'aborted', reason: controller.signal.reason }
          else messages.push({ role: 'assistant', content: [
            { type: 'tool-call', name: 'bash', arguments: '{"cmd":"ls"}' },
            { type: 'text', text: `done: ${text} via ${route.model}/${route.reasoningEffort}` },
          ] })
        } catch (e) { reason = { kind: 'error', error: { code: 'FIXTURE', message: e.message } } }
        agent.session.append('turn/end', { turn: t, reason }); agent.status = 'idle'
      })()
    },
    whenIdle: () => idle,
    cancel(cause) { if (cause?.kind === 'user') cancelled.push(sessionId); controller.abort(cause) },
  }
  knownSessions.set(sessionId, agent)
  return agent
}

const ctx = {
  logger: { info: () => {}, warn: m => console.error('[warn]', m), error: m => console.error('[error]', m) },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  get(name) { return this[name] },
  hmr,
  approval,
  sessionPersistence: { root: join(home, 'sessions'), async stat(id) { const agent = knownSessions.get(id) ?? ctx.agents.live.get(id); return agent || workspace.sessionIds.includes(id) ? { header: { id, cwd: workdir }, revision: String(agent?.session?.seq ?? 0) } : undefined } },
  on(name, fn) { (listeners[name] ??= []).push(fn) },
  settings: {
    update(ns, patch) {
      return runExclusive(async () => {
        Object.assign(values, patch)
        if (fireVolatileEvents) for (const fn of listeners['loader/volatile-update'] ?? []) fn()
      })
    },
    configure: () => () => {},
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'opencode', model: 'flash' }) },
  llm: {
    listProviders: () => [{ id: 'opencode', name: 'OpenCode' }, { id: 'other', name: 'Other' }],
    listModels: async p => p === 'opencode' ? [{ id: 'flash', name: 'V4.1 Flash' }, { id: 'pro', name: 'V4.1 Pro' }] : [{ id: 'x', name: 'X' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } }),
  },
  agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => {} },
  agents: {
    live: new Map(),
    get(id) { return this.live.get(String(id)) },
    async create(options) {
      const agent = fakeAgent(options.sessionId, options.meta.cwd, options)
      await options.setup?.(agent.ctx, agent)
      this.live.set(options.sessionId, agent)
      return { agent, dispose: async () => { agent.cancel({ kind: 'disposed' }); await agent.whenIdle(); this.live.delete(options.sessionId) } }
    },
  },
  workspaceRegistry: {
    list: () => workspaces,
    get: id => workspaces.find(w => w.id === id),
    resolveByPath: async path => workspaces.find(w => w.path === path),
    async create(path) {
      const made = { ...workspace, id: `ws-${workspaces.length + 1}`, title: 'Created', path, sessionIds: [] }
      workspaces.push(made)
      return made
    },
    get archivedSessionIds() { return archived },
    pinnedSessionIds: [],
    async archiveSession(id) { if (!archived.includes(String(id))) archived.push(String(id)) },
    async unarchiveSession(id) { const i = archived.indexOf(String(id)); if (i >= 0) archived.splice(i, 1) },
    async unpinSession() {},
  },
}

apply(ctx, config)
await sleep(300)

// ---- drive it through the stdio relay ------------------------------------------
const client = new Client({ name: 'smoke', version: '0' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist-package', 'bin', 'stdio.mjs')],
  env: { ...process.env, DSH_HOME: home, DSH_MCP_BRIDGE_PIPE: pipe },
}))
const call = async (name, args = {}, options) => {
  const result = await client.callTool({ name, arguments: args }, undefined, options)
  const body = result.content?.[0]?.text
  return { isError: !!result.isError, body: (() => { try { return JSON.parse(body) } catch { return body } })() }
}
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      ${JSON.stringify(detail).slice(0, 600)}`}`)
  if (!ok) failures++
}
const sessionDir = async id => {
  const dir = join(home, 'sessions', '--fake--', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x')
  return dir
}
const exists = path => stat(path).then(() => true, () => false)

const listed = (await client.listTools()).tools
const tools = listed.map(t => t.name).sort()
check('tools listed', tools.length === 12 && tools.includes('wait_task') && tools.includes('list_tasks'), tools)
const runParams = Object.keys(listed.find(t => t.name === 'run_task').inputSchema.properties)
check('run_task has no cwd parameter', !runParams.includes('cwd'), runParams)

// ---- models & workspaces ---------------------------------------------------------
let r = await call('harness_status')
check('status single mode', r.body.mode === 'single' && r.body.model.model === 'flash', r)
r = await call('list_models')
check('single mode lists only locked model', r.body.models.length === 1 && r.body.locked, r)

r = await call('run_task', { task: 'hello' })
check('run_task blocks until done, default workspace, locked model/effort',
  !r.isError && r.body.status === 'done' && r.body.workspace?.id === 'ws-1' && r.body.result.finalText.includes('flash/high'), r)
r = await call('run_task', { task: 'x', model: 'pro' })
check('single mode rejects other model', r.isError && String(r.body).includes('单模型'), r)
r = await call('run_task', { task: 'stray cwd', cwd: 'C:/should/not/be/used' })
check('stray cwd is ignored, default workspace wins', !r.isError && r.body.workspace?.id === 'ws-1', r)
values.defaultWorkspace = ''
r = await call('run_task', { task: 'no default' })
check('no default + no workspace -> clear error', r.isError && String(r.body).includes('默认工作区'), r)
const extraDir = await mkdtemp(join(tmpdir(), 'dmb-extra-'))
r = await call('run_task', { task: 'explicit path', workspace: extraDir })
check('explicit directory path creates its workspace', !r.isError && r.body.workspace?.title === 'Created', r)
values.defaultWorkspace = 'ws-1'
r = await call('run_task', { task: 'p', workspace: 'nope' })
check('unknown workspace name rejected', r.isError && String(r.body).includes('找不到工作区'), r)

values.mode = 'provider'
values.providerAllowOverrides = true // Explicit opt-in preserves this existing override smoke case.
r = await call('list_models')
check('provider mode lists provider models', r.body.models.length === 2 && !r.body.locked, r)
values.providerDefaultEffort = 'high'
r = await call('run_task', { task: 'eff', model: 'pro' })
check('provider default effort applied', !r.isError && r.body.reasoningEffort === 'high', r)
values.providerDefaultEffort = 'max'
r = await call('run_task', { task: 'eff2' })
check('unsupported default effort falls back to model default', !r.isError && r.body.reasoningEffort === 'low', r)
r = await call('run_task', { task: 'eff3', reasoningEffort: 'high' })
check('caller effort overrides default', !r.isError && r.body.reasoningEffort === 'high', r)
r = await call('run_task', { task: 'p', model: 'x' })
check('provider mode rejects foreign model', r.isError, r)
values.mode = 'single'

// ---- long tasks: no cancellation, progress, approval, wait_task -------------------
const progress = []
r = await call('run_task', { task: 'slow:1500 approve' }, { onprogress: p => progress.push(p.message), timeout: 60_000 })
check('slow task completes (not cancelled)', !r.isError && r.body.status === 'done' && cancelled.length === 0, r)
check('progress notifications sent while waiting', progress.length >= 2, progress)
check('progress reported pending approval', progress.some(m => String(m).includes('审批')), progress)

r = await call('start_task', { task: 'slow:1200' })
const asyncId = r.body.taskId
check('start_task returns immediately with active status', ['queued', 'running'].includes(r.body.status), r)
r = await call('wait_task', { taskId: asyncId, timeoutSec: 0.3 })
check('wait_task with timeout returns progress, task keeps running', ['queued', 'running'].includes(r.body.status) && r.body.summary, r)
r = await call('list_tasks', { activeOnly: true })
check('list_tasks finds the running task', Array.isArray(r.body) && r.body.some(t => t.taskId === asyncId), r)
r = await call('wait_task', { taskId: asyncId })
check('wait_task blocks until done', r.body.status === 'done' && r.body.result.finalText.includes('slow'), r)

r = await call('start_task', { task: 'slow:3000' })
const cancelId = r.body.taskId
await sleep(300)
await call('cancel_task', { taskId: cancelId })
r = await call('wait_task', { taskId: cancelId })
check('cancel_task stops the agent', r.body.status === 'cancelled' && cancelled.length === 1, r)

// ---- deletion -------------------------------------------------------------------
r = await call('list_sessions', { workspace: 'ws-1' })
check('list_sessions shows MCP sessions', r.body.sessions.length >= 5 && r.body.sessions.every(s => s.mcp), r.body.sessions?.length)

const victim = workspace.sessionIds[0]
const victimDir = await sessionDir(victim)
r = await call('delete_session', { sessionId: victim, confirm: true })
check('delete_session removes files permanently',
  !r.isError && r.body.deleted === victim && !(await exists(victimDir)) && !(await exists(join(home, 'mcp-bridge-trash'))), r)

// A session the Harness UI has open (resident agent this plugin does not own).
const residentId = 'session-resident'
workspace.sessionIds.push(residentId)
const residentDir = await sessionDir(residentId)
ctx.agents.live.set(residentId, { session: { header: { id: residentId, cwd: workdir } }, whenIdle: async () => {} })
r = await call('delete_session', { sessionId: residentId, confirm: true })
// Another owner may retain a writer after idle: queue instead of deleting under it.
check('resident session: stopped, detached, files safely queued for owner release',
  !r.isError && archived.includes(residentId) && !workspace.sessionIds.includes(residentId) && await exists(residentDir) && !!r.body.note, r)
ctx.agents.live.delete(residentId)

// ---- toolbar mailbox (also without volatile-update events: host polls) ------------
const mailbox = async command => {
  const id = 'cmd-' + Math.random().toString(36).slice(2)
  await ctx.settings.update('mcp-bridge', { command: JSON.stringify({ ...command, id, at: Date.now() }) })
  for (let i = 0; i < 100; i++) {
    const reply = values.commandResult && JSON.parse(values.commandResult)
    if (reply?.id === id) return reply
    await sleep(30)
  }
  throw new Error('no mailbox reply')
}
let reply = await mailbox({ action: 'manage-sessions', workspace: 'ws-1', manageAction: 'archive', filter: { mcpOnly: true }, confirm: false })
check('mailbox preview (dry run)', reply.ok && reply.result.dryRun && reply.result.count >= 1, reply)
fireVolatileEvents = false
const target = workspace.sessionIds.at(-1)
await sessionDir(target)
reply = await mailbox({ action: 'delete-session', sessionId: target })
check('mailbox works without volatile events (1s poll)', reply.ok && !workspace.sessionIds.includes(target), reply)
fireVolatileEvents = true
await ctx.settings.update('mcp-bridge', { command: JSON.stringify({ id: 'stale', at: Date.now() - 120_000, action: 'delete-session', sessionId: workspace.sessionIds[0] }) })
await sleep(200)
check('stale mailbox command discarded', values.command === '' && !String(values.commandResult).includes('"stale"'), values.commandResult)
reply = await mailbox({ action: 'manage-sessions', workspace: 'ws-1', manageAction: 'archive', filter: { mcpOnly: true }, confirm: true })
check('mailbox batch archive executes', reply.ok && reply.result.done >= 1, reply)

// ---- auto cleanup -----------------------------------------------------------------
const oldId = workspace.sessionIds[0]
const oldDir = await sessionDir(oldId)
const longAgo = new Date(Date.now() - 10 * 86_400_000)
// Directory age is not activity; the current log must actually be old.
await utimes(join(oldDir, 'session.v4.jsonl.zstd'), longAgo, longAgo)
await utimes(oldDir, longAgo, longAgo)
ctx.agents.live.delete(oldId)
const freshId = workspace.sessionIds[1]
await sessionDir(freshId)
await ctx.settings.update('mcp-bridge', { autoCleanupDays: 7 })
for (let i = 0; i < 100 && !values.cleanupStatus; i++) await sleep(30)
const cleanup = values.cleanupStatus && JSON.parse(values.cleanupStatus)
check('auto cleanup deletes only old MCP sessions',
  cleanup?.deleted === 1 && !workspace.sessionIds.includes(oldId) && workspace.sessionIds.includes(freshId), { cleanup })

// ---- switch -------------------------------------------------------------------------
values.enabled = false
r = await call('run_task', { task: 'off' })
check('disabled toggle blocks tools', r.isError && String(r.body).includes('关闭'), r)
r = await call('harness_status')
check('status still readable when disabled', !r.isError && r.body.enabled === false, r)

await client.close()
for (const d of disposers) d()
console.log(failures ? `SMOKE FAILED (${failures})` : 'SMOKE OK')
setTimeout(() => process.exit(failures ? 1 : 0), 300)
