/**
 * dsh-mcp-bridge — host face.
 *
 * Runs an MCP (Streamable HTTP) server inside DeepSeek Harness so an external
 * client (Claude Code) can hand tasks to Harness agents. Provider / model /
 * reasoning effort / default workspace / auto-approve are volatile config
 * fields edited live by the client-face toolbar through `ctx.remote.settings`,
 * so a toolbar change never restarts this plugin or interrupts running tasks.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { foldConsumedWork, installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { createPipeIdentity, PIPE_PROTOCOL } from '../bin/pipe-tls.mjs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildCatalog, findModel, type Catalog } from './catalog.ts'
import { SessionLedger } from './ledger.ts'
import { createFileLogger, type BridgeLogger } from './log.ts'
import { ACTIVE, TaskStore, type StoredTask, type TaskProgress } from './tasks.ts'
import { configVersion, sameSelection, select, type Selection, type SelectionSettings } from './selection.ts'
import { Semaphore } from './scheduler.ts'
import { SessionFiles, validateSessionId } from './session-files.ts'
import { JsonWriter, readJson } from './persistence.ts'

export const name = 'mcp-bridge'
export const inject = ['llm', 'agents', 'agentPresets', 'workspaceRegistry', 'sessionPersistence']

type Mode = 'single' | 'provider'

export const Config = Schema.object({
  pipePath: Schema.string().default('').description('本地管道路径；留空为 \\\\.\\pipe\\dsh-mcp-bridge-<用户名>（Windows）或 $DSH_HOME/mcp-bridge/bridge.sock'),
  httpEnabled: Schema.boolean().default(false).description('额外开启 Streamable HTTP 端点（给不支持 stdio 的客户端用）'),
  host: Schema.string().default('127.0.0.1').description('HTTP 监听地址'),
  port: Schema.number().default(8090).description('HTTP 监听端口'),
  authTokenFile: Schema.string().default('').description('Bearer token 文件；留空为 $DSH_HOME/harness-mcp-token.txt'),
  preset: Schema.string().default('').description('Agent preset；留空用默认'),
  maxConcurrentTasks: Schema.number().default(2),
  enabled: Schema.boolean().default(true).volatile(),
  mode: Schema.union(['single', 'provider'] as const).default('single').volatile(),
  singleProvider: Schema.string().default('').volatile(),
  singleModel: Schema.string().default('').volatile(),
  singleEffort: Schema.string().default('').volatile(),
  providerId: Schema.string().default('').volatile(),
  providerDefaultModel: Schema.string().default('').volatile(),
  providerDefaultEffort: Schema.string().default('').volatile(),
  providerAllowOverrides: Schema.boolean().default(false).volatile(),
  defaultWorkspace: Schema.string().default('').volatile(),
  autoApprove: Schema.boolean().default(false).volatile(),
  approvalMode: Schema.union(['inherit', 'ask', 'never'] as const).default('inherit').volatile(),
  autoCleanupDays: Schema.number().default(0).volatile(),
  // Toolbar → host mailbox (JSON strings); see handleCommand.
  command: Schema.string().default('').volatile(),
  commandResult: Schema.string().default('').volatile(),
  cleanupStatus: Schema.string().default('').volatile(),
})

interface Ref<T> { get(): T }
interface BridgeConfig {
  pipePath: string
  httpEnabled: boolean
  host: string
  port: number
  authTokenFile: string
  preset: string
  maxConcurrentTasks: number
  enabled: Ref<boolean>
  mode: Ref<Mode>
  singleProvider: Ref<string>
  singleModel: Ref<string>
  singleEffort: Ref<string>
  providerId: Ref<string>
  providerDefaultModel: Ref<string>
  providerDefaultEffort: Ref<string>
  providerAllowOverrides?: Ref<boolean>
  defaultWorkspace: Ref<string>
  autoApprove: Ref<boolean>
  approvalMode?: Ref<'inherit' | 'ask' | 'never'>
  autoCleanupDays: Ref<number>
  command: Ref<string>
  commandResult: Ref<string>
  cleanupStatus: Ref<string>
}

interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  attachSession(id: unknown): Promise<void>
  detachSession?(id: unknown): Promise<void>
}

interface TaskArgs {
  task: string
  workspace?: string
  sessionId?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  title?: string
}

/** In-memory companion of a stored task: completion promise and cancel hook. */
interface TaskRuntime {
  done: Promise<void>
  controller: AbortController
  sessionId?: string
  cancel?: () => void
  detach?: () => void
}

/** How often a waiting MCP call emits a progress notification (keeps Claude Code's idle timer alive). */
const PROGRESS_INTERVAL_MS = Number(process.env.DSH_MCP_BRIDGE_PROGRESS_MS) || 30_000
/** How often a running task's session is sampled for progress / approval state. */
const MONITOR_INTERVAL_MS = Number(process.env.DSH_MCP_BRIDGE_MONITOR_MS) || 5_000
const MAX_OWNED_AGENTS = 8

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Default local endpoint: a per-user named pipe on Windows, a socket file elsewhere. Must match bin/stdio.mjs. */
function defaultPipePath(): string {
  if (process.platform === 'win32') {
    const user = (userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_')
    return `\\\\.\\pipe\\dsh-mcp-bridge-${user}`
  }
  return join(dshHome(), 'mcp-bridge', 'bridge.sock')
}


function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

async function loadToken(file: string, logger: BridgeLogger): Promise<string> {
  const path = file || join(dshHome(), 'harness-mcp-token.txt')
  try {
    const token = (await readFile(path, 'utf8')).trim()
    if (token) return token
    throw new Error('TOKEN_EMPTY: refusing to replace an existing empty token')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const token = randomBytes(24).toString('hex')
  await mkdir(dirname(path), { recursive: true })
  let tokenHandle
  try { tokenHandle = await open(path, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = (await readFile(path, 'utf8')).trim()
    if (!existing) throw new Error('TOKEN_EMPTY')
    return existing
  }
  try { await tokenHandle.writeFile(token + '\n'); await tokenHandle.sync() } finally { await tokenHandle.close() }
  logger.info(`generated MCP token at ${path}`)
  return token
}

export function apply(ctx: Context, config: BridgeConfig): void {
  const c = ctx as any
  const logger = createFileLogger(ctx.logger, join(dshHome(), 'mcp-bridge', 'bridge.log'))
  const ledger = new SessionLedger(join(dshHome(), 'mcp-bridge', 'sessions.json'))
  type RouteControl = { current: any; assembled: any; taskSignal: AbortSignal; ready: Promise<void>; activate: () => void }
  type Owned = { agent: any; dispose: () => Promise<void>; selection: RouteControl }
  const owned = new Map<string, Owned>()
  const sessionLocks = new Map<string, Promise<unknown>>()
  const taskStore = new TaskStore(join(dshHome(), 'mcp-bridge', 'tasks.json'), () => logger.error('STORAGE_WRITE_FAILED: task progress durability degraded'))
  const files = new SessionFiles(dshHome())
  const runtimes = new Map<string, TaskRuntime>()
  const dispatching = new Map<string, StoredTask>()
  let unloading = false
  const busySessions = () => new Set([
    ...[...taskStore.records.values()].filter(r => ACTIVE.includes(r.status) && r.sessionId).map(r => r.sessionId!),
    ...[...runtimes.values()].flatMap(r => r.sessionId ? [r.sessionId] : []),
  ])
  const semaphore = new Semaphore(() => config.maxConcurrentTasks)

  // ---- model selection ---------------------------------------------------

  const catalog = (): Promise<Catalog> => buildCatalog(ctx)

  function defaultSelection(): Selection | undefined {
    return c.get('agentDefaultModel')?.currentSelection?.()
  }

  function snapshot(): SelectionSettings {
    return {
      enabled: config.enabled.get(), mode: config.mode.get(),
      singleProvider: config.singleProvider.get(), singleModel: config.singleModel.get(), singleEffort: config.singleEffort.get(),
      providerId: config.providerId.get(), providerDefaultModel: config.providerDefaultModel.get(), providerDefaultEffort: config.providerDefaultEffort.get(),
      providerAllowOverrides: config.providerAllowOverrides?.get() ?? false,
      approvalMode: config.approvalMode?.get() ?? 'inherit',
      defaultWorkspace: config.defaultWorkspace.get(), fallback: defaultSelection(),
    }
  }

  async function resolveSelection(model?: string, reasoningEffort?: string, provider?: string) {
    const settings = snapshot()
    const selection = select(settings, { model, reasoningEffort, provider }, await catalog())
    if (configVersion(settings) !== configVersion(snapshot())) throw new Error('CONFIG_CONFLICT: 配置在解析期间改变，请重试')
    return { selection, version: configVersion(settings), settings }
  }

  // ---- workspace resolution ---------------------------------------------

  const registry = () => c.workspaceRegistry as {
    list(): WorkspaceLike[]
    get(id: unknown): WorkspaceLike | undefined
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>
    create(path: string, title?: string): Promise<WorkspaceLike>
    archivedSessionIds: readonly string[]
    pinnedSessionIds: readonly string[]
    archiveSession(id: unknown, options?: { stopActivity?: boolean }): Promise<void>
    unarchiveSession(id: unknown): Promise<void>
    unpinSession(id: unknown): Promise<void>
  }

  function findWorkspace(query: string): WorkspaceLike | undefined {
    const list = registry().list()
    return list.find(w => w.id === query)
      ?? list.find(w => w.title === query)
      ?? list.find(w => samePath(w.path, query))
  }

  function workspaceNotFound(query: string): Error {
    const names = registry().list().map(w => `${w.title} (${w.id})`).join('; ')
    return new Error(`找不到工作区 "${query}"。现有工作区：${names || '（无）'}`)
  }

  async function ensureDirectory(path: string): Promise<string> {
    const canonical = await realpath(path).catch(() => resolve(path))
    const info = await stat(canonical).catch(() => undefined)
    if (!info?.isDirectory()) throw new Error(`目录不存在：${path}`)
    return canonical
  }

  /**
   * Pick the session workspace: an explicitly requested one > the toolbar default.
   * Only an explicitly requested directory path may create a new workspace.
   */
  async function resolveTarget(args: TaskArgs): Promise<{ cwd: string; workspace?: WorkspaceLike }> {
    if (args.workspace) {
      const known = findWorkspace(args.workspace)
      if (known) return { cwd: await ensureDirectory(known.path), workspace: known }
      if (!/[\\/]/.test(args.workspace)) throw workspaceNotFound(args.workspace)
      const cwd = await ensureDirectory(args.workspace)
      const reg = registry()
      const workspace = (await reg.resolveByPath(cwd)) ?? (await reg.create(cwd))
      return { cwd, workspace }
    }
    const preferred = config.defaultWorkspace.get()
    if (preferred) {
      const workspace = findWorkspace(preferred)
      if (!workspace) throw new Error(`默认工作区 ${preferred} 已不存在，请在 Harness 工具栏重新选择`)
      return { cwd: await ensureDirectory(workspace.path), workspace }
    }
    throw new Error('未指定 workspace，且 Harness 工具栏未设置默认工作区。请在 Harness 右下角工具栏选择默认工作区，或明确告诉我用哪个工作区。')
  }

  // ---- agents --------------------------------------------------------------

  async function presetId(): Promise<string> {
    return (await c.agentPresets.resolve(config.preset || undefined)).id
  }

  function agentOptions(selection: Selection) {
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) } : {}),
    }
  }

  /** Keep handles for reuse; evict the least recently used idle ones (never one with a running task). */
  function remember(id: string, handle: Owned) {
    owned.set(id, handle)
    const busy = busySessions()
    for (const [candidate, old] of owned) {
      if (owned.size <= MAX_OWNED_AGENTS) break
      if (candidate === id || busy.has(candidate)) continue
      owned.delete(candidate)
      void old.dispose().catch(error => logger.warn(`dispose ${candidate} failed`))
    }
  }

  function applyApproval(agent: any, mode: SelectionSettings['approvalMode'], initializing = false) {
    // No grant is synthesized. 0.2.1-rc.2 supports ask/never and allowed-once only.
    if (mode === 'inherit') return
    if (initializing) setApprovalPolicy(agent.session, mode)
    else {
      const approval = c.get('approval')
      if (!approval?.setPolicy) throw new Error('APPROVAL_UNAVAILABLE: 无法安全应用审批设置')
      approval.setPolicy(agent, mode)
    }
  }

  function routeControl(selection: Selection, taskSignal: AbortSignal): RouteControl {
    let activate!: () => void
    const ready = new Promise<void>(resolve => { activate = resolve })
    return { current: agentOptions(selection), assembled: undefined, taskSignal, ready, activate }
  }

  function installRoute(agentCtx: Context, control: RouteControl) {
    installModelSelection(agentCtx, control)
    // Official resume may wake persisted inbox work before its Promise returns.
    // Hold its first pre-step until admission is durable and monitoring is attached.
    agentCtx.on('agent/pre-step', async (_payload, next) => {
      const signal = control.taskSignal
      signal.throwIfAborted()
      let detach = () => {}
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => signal.removeEventListener('abort', onAbort)
      })
      try { await Promise.race([control.ready, aborted]); signal.throwIfAborted(); return await next() } finally { detach() }
    })
  }

  async function createAgent(args: TaskArgs, selection: Selection, target: { cwd: string; workspace?: WorkspaceLike }, mode: SelectionSettings['approvalMode'], id: string, signal: AbortSignal) {
    const { cwd, workspace } = target
    const preset = await presetId()
    const control = routeControl(selection, signal)
    const sessionId = SessionId(id)
    const handle = await c.agents.create({
      sessionId, meta: { cwd, agentPreset: preset }, agentOptions: agentOptions(selection),
      setup: async (agentCtx: Context, agent: any) => {
        await c.agentPresets.mount(agentCtx, preset)
        installRoute(agentCtx, control)
        applyApproval(agent, mode, true)
      },
    })
    remember(sessionId, { ...handle, selection: control })
    if (workspace) await workspace.attachSession(sessionId)
    const title = `[MCP] ${args.title || args.task.replace(/\s+/g, ' ').slice(0, 40)}`
    c.get('sessionTitle')?.rename(handle.agent.session, title)
    await ledger.add(sessionId, { title, createdAt: Date.now(), workspaceId: workspace?.id })
    return handle.agent
  }

  async function continueAgent(id: string, selection: Selection, mode: SelectionSettings['approvalMode'], signal: AbortSignal) {
    validateSessionId(id)
    const known = owned.get(id)
    if (known) {
      if (known.agent.status === 'running') throw new Error('SESSION_BUSY: Harness 中的会话仍在运行')
      known.selection.current = agentOptions(selection)
      known.selection.taskSignal = signal
      applyApproval(known.agent, mode)
      return known.agent
    }
    // A bare live Agent has neither our disposer capability nor our routing hooks.
    if (c.agents.get(SessionId(id))) throw new Error('CONFIG_CONFLICT: 非本插件拥有的 live 会话不能安全切换模型或审批配置，请先在 Harness 关闭该会话')
    if (!(await ledger.get(id))) throw new Error('SESSION_NOT_MANAGED: 只能恢复本插件创建的磁盘会话')
    await requireSession(id, false)
    const preset = await presetId()
    const control = routeControl(selection, signal)
    const handle = await c.agents.resume({
      resumeSessionId: SessionId(id), agentOptions: agentOptions(selection),
      setup: async (agentCtx: Context, agent: any) => {
        await c.agentPresets.mount(agentCtx, preset)
        installRoute(agentCtx, control)
        applyApproval(agent, mode, true)
      },
    })
    remember(id, { ...handle, selection: control })
    return handle.agent
  }

  async function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const tail = next.catch(() => undefined)
    sessionLocks.set(id, tail)
    try { return await next } finally { if (sessionLocks.get(id) === tail) sessionLocks.delete(id) }
  }

  // This is the resolved request envelope at the official dispatch seam, not a
  // guessed TaskRecord selection or evidence of provider billing/receipt.
  c.on('llm/stream', (request: any, next: () => AsyncIterable<any>) => {
    const record = dispatching.get(String(request.sessionId))
    if (!record) return next()
    const observed: Selection = { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: String(request.reasoningEffort) }) }
    const runtime = runtimes.get(record.id)
    runtime?.controller.signal.throwIfAborted()
    if (!sameSelection(record, observed)) throw new Error('CONFIG_CONFLICT: 实际请求与本任务锁定配置冲突，已阻止发送')
    const stream = next()
    record.effectiveSelection = observed
    record.selectionEvidence = 'llm/stream'
    record.requestCount = (record.requestCount ?? 0) + 1
    taskStore.save()
    logger.info(JSON.stringify({ taskId: record.id, sessionId: record.sessionId, configVersion: record.configVersion, event: 'request-dispatch', ...observed }))
    return stream
  }, { prepend: true })

  // ---- tasks ---------------------------------------------------------------
  //
  // A task never times out on this side: it runs until the agent goes idle.
  // A monitor samples the session every few seconds (steps, tool calls,
  // pending approvals) and persists the record, so callers can reconnect,
  // wait again, or learn that a Harness restart interrupted the work.

  function summarize(messages: readonly any[]) {
    const toolCalls: { name: string; arguments: string }[] = []
    let finalText = ''
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const texts: string[] = []
      for (const block of message.content ?? []) {
        if (block.type === 'text' && block.text) texts.push(block.text)
        if (block.type === 'tool-call') toolCalls.push({ name: block.name, arguments: String(block.arguments ?? '').slice(0, 1000) })
      }
      if (texts.length) finalText = texts.join('\n')
    }
    return { finalText: finalText.slice(0, 20000), toolCalls: toolCalls.slice(-50) }
  }

  interface MonitorState { eventSeq: number; approvals: Map<string, { toolName: string; reason?: string }>; singleUseSeen: boolean }

  /** Sample one running task's session into its progress record. */
  function sample(record: StoredTask, agent: any, state: MonitorState) {
    const messages = agent.session.deriveMessages().slice(record.baseline ?? 0)
    let steps = 0
    let toolCalls = 0
    let lastTool: string | undefined
    let lastText: string | undefined
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      steps++
      for (const block of message.content ?? []) {
        if (block.type === 'tool-call') { toolCalls++; lastTool = block.name }
        if (block.type === 'text' && block.text) lastText = block.text
      }
    }
    try {
      for (const event of agent.session.snapshotEvents(state.eventSeq)) {
        if (event.type === 'approval/asked') {
          const tool = String(event.data.toolName)
          state.approvals.set(String(event.data.id), { toolName: tool })
          const reason = state.singleUseSeen ? 'no-reusable-grant; previous-result-allowed-once' : 'operation-requires-approval; scope-not-persisted'
          if (Number(event.seq) >= (record.eventBaseline ?? 0)) {
            record.approvalDiagnostics = [...(record.approvalDiagnostics ?? []), { tool, reason }].slice(-40)
            logger.info(JSON.stringify({ taskId: record.id, sessionId: record.sessionId, configVersion: record.configVersion, approval: record.approval, event: 'approval-request', tool, grantHit: false, reason }))
          }
        } else if (event.type === 'approval/decided') {
          const tool = state.approvals.get(String(event.data.id))?.toolName ?? 'unknown'
          state.approvals.delete(String(event.data.id))
          if (event.data.outcome === 'allowed-once') state.singleUseSeen = true
          if (Number(event.seq) >= (record.eventBaseline ?? 0)) {
            record.approvalDiagnostics = [...(record.approvalDiagnostics ?? []), { tool, outcome: String(event.data.outcome), reason: 'official-approval-result' }].slice(-40)
            logger.info(JSON.stringify({ taskId: record.id, sessionId: record.sessionId, configVersion: record.configVersion, event: 'approval-decided', tool, outcome: event.data.outcome }))
          }
        }
      }
      state.eventSeq = Number(agent.session.seq)
    } catch { logger.warn(`task ${record.id}: approval diagnostics unavailable`) }
    const pendingApproval = [...state.approvals.values()].at(-1)
    const previous = record.progress
    const changed = steps !== previous.steps || toolCalls !== previous.toolCalls || !!pendingApproval !== !!previous.pendingApproval
    const progress: TaskProgress = {
      steps,
      toolCalls,
      ...(lastTool ? { lastTool } : {}),
      ...(lastText ? { lastText: lastText.slice(-300) } : {}),
      lastActivityAt: changed ? Date.now() : previous.lastActivityAt,
      ...(pendingApproval ? { pendingApproval } : {}),
    }
    record.progress = progress
    if (ACTIVE.includes(record.status)) record.status = pendingApproval ? 'waiting_approval' : 'running'
    taskStore.save()
  }

  async function durable(record: StoredTask) {
    record.durability = 'pending'
    try {
      await taskStore.flush()
      record.durability = 'durable'
      delete record.persistenceError
    } catch (error) {
      record.durability = 'degraded'
      record.persistenceError = 'STORAGE_WRITE_FAILED'
      throw error
    }
  }

  /** whenIdle is only a boundary; the owned log suffix supplies the outcome. */
  async function follow(record: StoredTask, agent: any, runtime: TaskRuntime, prompt?: string) {
    const signal = runtime.controller.signal
    signal.throwIfAborted()
    if (unloading) throw new Error('BRIDGE_UNLOADING')
    const state: MonitorState = { eventSeq: 0, approvals: new Map(), singleUseSeen: false }
    const cancel = () => agent.cancel({ kind: 'user' })
    signal.addEventListener('abort', cancel, { once: true })
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      if (prompt !== undefined) {
        record.baseline = agent.session.deriveMessages().length
        record.eventBaseline = Number(agent.session.seq)
        record.status = 'running'
        record.startedAt = Date.now()
        await durable(record)
        signal.throwIfAborted()
        if (configVersion(snapshot()) !== record.configVersion) throw new Error('CONFIG_CONFLICT: 配置在启动准备期间改变，请重试')
        dispatching.set(record.sessionId!, record)
        agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } } as any))
        owned.get(record.sessionId!)?.selection.activate()
      } else dispatching.set(record.sessionId!, record)
      sample(record, agent, state)
      timer = setInterval(() => {
        try { sample(record, agent, state) } catch { logger.warn(`monitor ${record.id}: sample failed`) }
      }, MONITOR_INTERVAL_MS)
      let detached = false
      const detachedDone = new Promise<void>(resolve => { runtime.detach = () => { detached = true; resolve() } })
      await Promise.race([agent.whenIdle(), detachedDone])
      runtime.detach = undefined
      if (detached) { record.status = 'interrupted'; record.error = 'Plugin observer unloaded; live work remains with its owner'; return }
      sample(record, agent, state)
      record.result = summarize(agent.session.deriveMessages().slice(record.baseline ?? 0))
      const events = agent.session.snapshotEvents(record.eventBaseline ?? 0)
      const reason = foldConsumedWork(events).end?.data.reason
      record.termination = reason ?? { kind: 'missing-turn-end' }
      if (signal.aborted || record.status === 'cancelled') record.status = 'cancelled'
      else if (reason?.kind === 'completed') record.status = 'done'
      else if (reason?.kind === 'aborted') record.status = reason.reason.kind === 'disposed' ? 'interrupted' : 'cancelled'
      else if (reason?.kind === 'error' || reason?.kind === 'blocked' || reason?.kind === 'max-tokens') {
        record.status = 'failed'
        record.error = reason.kind === 'error' ? reason.error.message : reason.kind
      } else { record.status = 'interrupted'; record.error = 'No accounting turn/end for this task' }
      delete record.progress.pendingApproval
    } finally {
      clearInterval(timer)
      signal.removeEventListener('abort', cancel)
      if (dispatching.get(record.sessionId!) === record) dispatching.delete(record.sessionId!)
    }
  }

  function track(record: StoredTask, work: (runtime: TaskRuntime) => Promise<void>): TaskRuntime {
    const controller = new AbortController()
    const runtime: TaskRuntime = { done: Promise.resolve(), controller, sessionId: record.sessionId }
    runtime.cancel = () => {
      if (ACTIVE.includes(record.status)) {
        record.status = 'cancelled'
        record.finishedAt = Date.now()
        controller.abort(new Error('TASK_CANCELLED'))
      }
    }
    runtimes.set(record.id, runtime)
    runtime.done = work(runtime).catch(error => {
      if (!controller.signal.aborted && record.status !== 'cancelled') {
        record.status = 'failed'
        record.error = error instanceof Error ? error.message : String(error)
        controller.abort(error)
      }
      logger.warn(`task ${record.id} ended status=${record.status}`)
    }).finally(async () => {
      record.finishedAt ??= Date.now()
      runtime.cancel = undefined
      runtime.detach = undefined
      try { await durable(record) } catch { logger.error(`task ${record.id}: terminal state is not durable`) }
      runtimes.delete(record.id)
    })
    return runtime
  }

  /** Validate at admission; resolve again after queueing, under the session lock. */
  async function launch(args: TaskArgs): Promise<StoredTask> {
    await ready
    if (unloading) throw new Error('BRIDGE_UNLOADING')
    if (args.sessionId) validateSessionId(args.sessionId)
    const initial = await resolveSelection(args.model, args.reasoningEffort, args.provider)
    if (!args.sessionId) await resolveTarget(args)
    const now = Date.now()
    const record: StoredTask = {
      id: `task-${randomUUID()}`, status: 'queued', task: args.task.slice(0, 2000), createdAt: now,
      sessionId: args.sessionId ?? `session-${randomUUID()}`,
      ...initial.selection, requestedSelection: { ...(args.provider === undefined ? {} : { provider: args.provider }), ...(args.model === undefined ? {} : { model: args.model }), ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }) },
      effectiveSelection: null, configVersion: initial.version, configSource: 'toolbar-v2',
      progress: { steps: 0, toolCalls: 0, lastActivityAt: now },
    }
    taskStore.records.set(record.id, record)
    try { await durable(record) } catch (error) { taskStore.records.delete(record.id); throw error }
    track(record, runtime => withSessionLock(record.sessionId!, () => semaphore.run(async () => {
      runtime.controller.signal.throwIfAborted()
      const resolved = await resolveSelection(args.model, args.reasoningEffort, args.provider)
      runtime.controller.signal.throwIfAborted()
      const target = args.sessionId ? undefined : await resolveTarget(args)
      runtime.controller.signal.throwIfAborted()
      delete record.reasoningEffort
      Object.assign(record, resolved.selection, { configVersion: resolved.version })
      const agent = args.sessionId
        ? await continueAgent(args.sessionId, resolved.selection, resolved.settings.approvalMode, runtime.controller.signal)
        : await createAgent(args, resolved.selection, target!, resolved.settings.approvalMode, record.sessionId!, runtime.controller.signal)
      runtime.controller.signal.throwIfAborted()
      const reg = registry()
      if (reg.archivedSessionIds.map(String).includes(record.sessionId!)) await reg.unarchiveSession(SessionId(record.sessionId!))
      runtime.controller.signal.throwIfAborted()
      record.cwd = agent.session.header.cwd
      if (target?.workspace) record.workspace = { id: target.workspace.id, title: target.workspace.title, path: target.workspace.path }
      record.approval = {
        mode: c.get('approval')?.effectivePolicy?.(agent.session) ?? 'unknown', source: resolved.settings.approvalMode === 'inherit' ? 'session-or-harness-default' : 'toolbar-managed-session',
        preset: c.get('permissionPresets')?.current?.(agent.session), persistentGrants: false,
        sandbox: [...agent.session.snapshotEvents()].reverse().find((e: any) => e.type === 'sandbox/mode')?.data.mode ?? c.get('shell')?.sandboxMode,
      }
      await follow(record, agent, runtime, args.task)
    }, runtime.controller.signal)))
    return record
  }

  async function recoverTasks() {
    await taskStore.load()
    await ledger.entries()
    const claimed = new Set<string>()
    for (const record of taskStore.records.values()) {
      if (!ACTIVE.includes(record.status)) continue
      const agent = record.sessionId ? c.agents.get(SessionId(record.sessionId)) : undefined
      if (agent && record.baseline !== undefined && record.eventBaseline !== undefined && !claimed.has(record.sessionId!)) {
        validateSessionId(record.sessionId!)
        claimed.add(record.sessionId!)
        // Observe existing work without modifying another owner's route or permissions.
        // Adopted work reserves capacity before new admissions are enabled.
        track(record, runtime => withSessionLock(record.sessionId!, () => semaphore.run(() => follow(record, agent, runtime), undefined, true)))
      } else {
        record.status = 'interrupted'
        record.error = 'Harness/插件生命周期已结束，或缺少可验证的任务边界；可使用 sessionId 显式恢复'
        record.finishedAt = Date.now()
      }
    }
    await taskStore.flush()
  }
  let startupError: string | undefined
  const ready = recoverTasks().catch(error => { startupError = 'STORAGE_RECOVERY_FAILED'; throw error })
  void ready.catch(() => logger.error('STORAGE_RECOVERY_FAILED: task admission blocked'))

  function describeProgress(record: StoredTask): string {
    const minutes = Math.floor((Date.now() - (record.startedAt ?? record.createdAt)) / 60_000)
    if (record.status === 'queued') return `排队中（并发上限 ${config.maxConcurrentTasks}）`
    if (record.progress.pendingApproval) return `等待你在 Harness 中审批：${record.progress.pendingApproval.toolName}`
    const last = record.progress.lastTool ? ` · 最近：${record.progress.lastTool}` : ''
    return `运行中 ${minutes} 分钟 · ${record.progress.steps} 步 · 工具调用 ${record.progress.toolCalls} 次${last}`
  }

  function taskView(record: StoredTask) {
    const idleSec = Math.round((Date.now() - record.progress.lastActivityAt) / 1000)
    return {
      taskId: record.id,
      ...record,
      ...(ACTIVE.includes(record.status) ? { summary: describeProgress(record), idleSec } : {}),
    }
  }

  /**
   * Block until the task finishes, the optional timeout passes, or the client
   * gives up — never cancelling the task. Emits progress notifications so
   * Claude Code's idle timer keeps the call alive.
   */
  async function waitFor(record: StoredTask, extra: any, timeoutSec?: number): Promise<void> {
    const runtime = runtimes.get(record.id)
    if (!runtime) return
    const token = extra?._meta?.progressToken
    let count = 0
    const tick = setInterval(() => {
      if (token === undefined) return
      void Promise.resolve(extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: ++count, message: describeProgress(record) },
      })).catch(() => undefined)
    }, PROGRESS_INTERVAL_MS)
    let timer: ReturnType<typeof setTimeout> | undefined
    const waits: Promise<unknown>[] = [runtime.done]
    if (timeoutSec && timeoutSec > 0) waits.push(new Promise(done => { timer = setTimeout(done, timeoutSec * 1000) }))
    const signal: AbortSignal | undefined = extra?.signal
    let detachAbort = () => {}
    if (signal) waits.push(new Promise(done => {
      if (signal.aborted) { done(undefined); return }
      const onAbort = () => done(undefined)
      signal.addEventListener('abort', onAbort, { once: true })
      detachAbort = () => signal.removeEventListener('abort', onAbort)
    }))
    try {
      await Promise.race(waits)
    } finally {
      clearInterval(tick)
      clearTimeout(timer)
      detachAbort()
    }
  }

  function findTask(taskId: string): StoredTask {
    const record = taskStore.records.get(taskId)
    if (!record) throw new Error(`任务 ${taskId} 不存在或已过期（记录保留 7 天）`)
    return record
  }

  ctx.effect(() => () => {
    unloading = true
    // The official factory attaches created handles to the plugin's owner fiber;
    // unload drains/disposes them. Do not promise that these agents survive HMR.
    for (const [id, runtime] of runtimes) {
      const record = taskStore.records.get(id)!
      if (owned.has(record.sessionId!)) runtime.cancel?.()
      else runtime.detach?.()
    }
    const handles = [...owned.values()]
    owned.clear()
    return Promise.allSettled(handles.map(h => h.dispose())).then(async () => {
      await Promise.allSettled([...runtimes.values()].map(r => r.done))
      await taskStore.flush()
    })
  }, 'mcp-bridge: owned agents')

  // ---- workspaces & sessions ----------------------------------------------

  function requireStorageRoot() {
    // This pinned backend exposes its configured root as a JS data property.
    // Use it only as a refusal guard, never as a caller-controlled delete target.
    const root = c.sessionPersistence.root
    if (typeof root !== 'string' || !samePath(root, join(dshHome(), 'sessions'))) throw new Error('UNSUPPORTED_SESSION_STORAGE: 仅支持已核对的 $DSH_HOME/sessions JSONL 存储根')
  }

  async function requireSession(id: string, destructive = true) {
    validateSessionId(id)
    // Validate all destructive roots before asking the official reader to verify identity.
    if (destructive) { requireStorageRoot(); await files.directory(id); await files.cache(id) }
    const snapshot = await c.sessionPersistence.stat(SessionId(id))
    const live = c.agents.get(SessionId(id))
    if (snapshot?.header?.id !== id && live?.session?.header?.id !== id) throw new Error('SESSION_NOT_FOUND: 无法验证真实会话')
    return snapshot
  }

  async function sessionTitle(id: string): Promise<string | undefined> {
    const cache = await files.cache(id)
    try {
      const value = JSON.parse(cache ? await readFile(cache, 'utf8') : '{}')?.record?.rows?.title?.val
      if (typeof value === 'string') return value
    } catch { /* not cached */ }
    return (await ledger.get(id))?.title
  }

  async function describeSession(id: string) {
    requireStorageRoot()
    const reg = registry()
    validateSessionId(id)
    const activity = await files.activity(id)
    const snapshot = await c.sessionPersistence.stat(SessionId(id))
    const modified = activity.updatedAt
    return {
      sessionId: id,
      version: JSON.stringify([activity.version, snapshot?.revision ?? null, c.agents.get(SessionId(id))?.session?.seq ?? null, reg.archivedSessionIds.map(String).includes(id)]),
      title: await sessionTitle(id),
      mcp: (await ledger.get(id)) !== undefined,
      archived: reg.archivedSessionIds.includes(id),
      pinned: reg.pinnedSessionIds.includes(id),
      live: c.agents.get(SessionId(id)) !== undefined,
      updatedAt: modified ? new Date(modified).toISOString() : undefined,
    }
  }

  async function listSessions(query: string, includeArchived: boolean) {
    const workspace = findWorkspace(query)
    if (!workspace) throw workspaceNotFound(query)
    const rows = await Promise.all(workspace.sessionIds.map(id => describeSession(String(id))))
    return { workspace: { id: workspace.id, title: workspace.title, path: workspace.path }, sessions: rows.filter(r => includeArchived || !r.archived) }
  }

  // ---- permanent deletion ------------------------------------------------------
  //
  // Deletion is final (recovery is what Harness's own archive is for). A
  // session still resident in Harness (opened in the UI) is archived with
  // stopActivity first, which stops its work and gates further wakes. Files a
  // live handle still holds are queued and removed on the next start.

  const pendingDeletesFile = join(dshHome(), 'mcp-bridge', 'pending-deletes.json')
  interface PendingDelete { id: string; version?: string; directory?: string }
  const pendingWriter = new JsonWriter(pendingDeletesFile)
  let deleteQueue = Promise.resolve()
  const readPending = () => readJson<PendingDelete[]>(pendingDeletesFile, () => [])
  async function updatePending(update: (items: PendingDelete[]) => PendingDelete[]) {
    const operation = deleteQueue.catch(() => undefined).then(async () => {
      const items = await readPending()
      if (!Array.isArray(items)) throw new Error('INVALID_PENDING_DELETES')
      await pendingWriter.write(update(items))
    })
    deleteQueue = operation
    return operation
  }

  async function deleteSession(id: string, expectedVersion?: string): Promise<{ deleted: string; note?: string }> {
    validateSessionId(id)
    if (busySessions().has(id)) throw new Error('SESSION_BUSY: 会话仍有 MCP 任务或取消尚未完成')
    return withSessionLock(id, async () => {
      await requireSession(id)
      if (expectedVersion !== undefined && (await describeSession(id)).version !== expectedVersion) throw new Error('SESSION_CHANGED: 预览后会话已改变，请重新确认')
      const fileVersion = (await files.activity(id)).version
      if (busySessions().has(id)) throw new Error('SESSION_BUSY: 会话仍有 MCP 任务或取消尚未完成')
      const sid = SessionId(id)
      const reg = registry()
      const handle = owned.get(id)
      if (handle) { await handle.dispose(); owned.delete(id) }
      const resident = c.agents.get(sid)
      if (resident) {
        await reg.archiveSession(sid, { stopActivity: true })
        // Another owner can still hold a persistence writer after idle. Keep files
        // until that owner has gone; never dispose its handle or delete under it.
        const version = (await files.activity(id)).version
        await updatePending(items => [...items.filter(p => p.id !== id), { id, version }])
      } else {
        // Revalidate cache/junctions BEFORE removing any session files.
        await requireSession(id)
        if (expectedVersion !== undefined && (await files.activity(id)).version !== fileVersion) throw new Error('SESSION_CHANGED: owner 释放期间日志已改变，请重新确认')
        await files.cache(id)
        await files.remove(id)
      }
      for (const workspace of reg.list().filter(w => w.sessionIds.map(String).includes(id))) await workspace.detachSession?.(sid)
      if (reg.pinnedSessionIds.map(String).includes(id)) await reg.unpinSession(sid)
      if (!resident && reg.archivedSessionIds.map(String).includes(id)) await reg.unarchiveSession(sid)
      if (!resident) await ledger.remove(id)
      logger.info(JSON.stringify({ event: 'session-delete', sessionId: id, pending: !!resident }))
      return { deleted: id, ...(resident ? { note: '会话已停止并从列表移除；其他 owner 释放文件后再安全删除。若文件改变将要求重新确认。' } : {}) }
    })
  }

  async function finishPendingDeletes() {
    await ready
    const pending = await readPending()
    if (!Array.isArray(pending)) throw new Error('INVALID_PENDING_DELETES')
    for (const item of pending) {
      try {
        validateSessionId(item.id)
        if (!item.version || item.directory) throw new Error('LEGACY_PENDING_DELETE_REQUIRES_CONFIRMATION')
        if (c.agents.get(SessionId(item.id)) || busySessions().has(item.id)) continue
        await withSessionLock(item.id, async () => {
          await requireSession(item.id)
          if ((await files.activity(item.id)).version !== item.version) throw new Error('SESSION_CHANGED')
          await files.cache(item.id)
          await files.remove(item.id)
          await ledger.remove(item.id)
          if (registry().archivedSessionIds.map(String).includes(item.id)) await registry().unarchiveSession(SessionId(item.id))
          await updatePending(items => items.filter(p => p.id !== item.id))
        })
      } catch { logger.warn('pending delete refused: invalid boundary, changed files, or legacy confirmation required') }
    }
  }
  ctx.effect(() => {
    const timer = setTimeout(() => { void finishPendingDeletes().catch(() => logger.warn('pending deletes failed')) }, 5_000)
    return () => clearTimeout(timer)
  }, 'mcp-bridge: pending deletes')

  type BatchAction = 'archive' | 'unarchive' | 'delete'
  interface BatchFilter { mcpOnly?: boolean; olderThanDays?: number; includeArchived?: boolean }

  type SessionRow = Awaited<ReturnType<typeof describeSession>>
  const previews = new Map<string, { expires: number; workspace: string; action: BatchAction; mcpOnly: boolean; targets: SessionRow[] }>()
  async function manageSessions(query: string, action: BatchAction, filter: BatchFilter, confirm: boolean, previewToken?: string) {
    await ready
    if (filter.olderThanDays !== undefined && (!Number.isFinite(filter.olderThanDays) || filter.olderThanDays < 0)) throw new Error('INVALID_FILTER')
    const includeArchived = action === 'unarchive' ? true : filter.includeArchived ?? action === 'delete'
    const { workspace, sessions } = await listSessions(query, includeArchived)
    const mcpOnly = filter.mcpOnly ?? true
    const cutoff = filter.olderThanDays === undefined ? undefined : Date.now() - filter.olderThanDays * 86_400_000
    let targets = sessions.filter(s =>
      (!mcpOnly || s.mcp) && (action !== 'unarchive' || s.archived) && (action !== 'archive' || !s.archived)
      && (cutoff === undefined || (s.updatedAt !== undefined && Date.parse(s.updatedAt) < cutoff)))
    for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key)
    if (!confirm) {
      if (previews.size >= 500) throw new Error('PREVIEW_LIMIT: 请稍后重试')
      const token = randomBytes(24).toString('hex')
      previews.set(token, { expires: Date.now() + 60_000, workspace: workspace.id, action, mcpOnly, targets })
      return { workspace, action, dryRun: true, mcpOnly, count: targets.length, targets, previewToken: token, expiresInSec: 60, hint: '确认这些具体 ID 后携带 previewToken 与 confirm: true；mcpOnly:false 明确包含个人会话' }
    }
    if (previewToken) {
      const preview = previews.get(previewToken)
      if (!preview || preview.expires < Date.now() || preview.workspace !== workspace.id || preview.action !== action || preview.mcpOnly !== mcpOnly) throw new Error('CONFIRMATION_EXPIRED: 请重新预览并确认')
      targets = preview.targets
      for (const target of targets) if ((await describeSession(target.sessionId)).version !== target.version) throw new Error('SESSION_CHANGED: 预览后会话发生变化，请重新确认')
      previews.delete(previewToken)
    } else if (action === 'delete' || !mcpOnly) throw new Error('CONFIRMATION_REQUIRED: 永久删除或包含个人会话必须携带预览令牌')
    const results: { sessionId: string; ok: boolean; detail?: string }[] = []
    for (const target of targets) {
      try {
        if (action === 'delete') results.push({ sessionId: target.sessionId, ok: true, detail: (await deleteSession(target.sessionId, target.version)).note })
        else {
          await withSessionLock(target.sessionId, async () => {
            await requireSession(target.sessionId)
            if (busySessions().has(target.sessionId)) throw new Error('SESSION_BUSY')
            if (action === 'archive') await registry().archiveSession(SessionId(target.sessionId), { stopActivity: true })
            else await registry().unarchiveSession(SessionId(target.sessionId))
          })
          results.push({ sessionId: target.sessionId, ok: true })
        }
      } catch (error) { results.push({ sessionId: target.sessionId, ok: false, detail: error instanceof Error ? error.message : String(error) }) }
    }
    return { workspace, action, done: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }
  }

  async function cleanupOldSessions(days: number) {
    await ready
    const cutoff = Date.now() - days * 86_400_000
    const deleted: string[] = []
    const failed: { sessionId: string; detail: string }[] = []
    for (const [id] of await ledger.entries()) {
      try {
        validateSessionId(id)
        if (c.agents.get(SessionId(id)) || busySessions().has(id)) continue
        const row = await describeSession(id)
        if (row.updatedAt === undefined || Date.parse(row.updatedAt) >= cutoff) continue
        await deleteSession(id, row.version)
        deleted.push(id)
      } catch { failed.push({ sessionId: id, detail: 'Session boundary, activity, or storage validation failed' }) }
    }
    return { at: Date.now(), days, deleted: deleted.length, failed }
  }

  // ---- toolbar mailbox ------------------------------------------------------
  //
  // The client face cannot call host functions directly, so it writes a JSON
  // command into the volatile `command` field through remote.settings; the
  // host executes it on `loader/volatile-update` and answers through
  // `commandResult`. Ids are executed once, and commands older than a minute
  // (e.g. left over across a restart) are discarded.

  const NS = 'mcp-bridge'
  const COMMAND_TTL_MS = 60_000
  const handled = new Set<string>()

  interface BridgeCommand {
    id: string
    at: number
    action: 'delete-session' | 'manage-sessions' | 'cleanup-now'
    sessionId?: string
    workspace?: string
    manageAction?: BatchAction
    filter?: BatchFilter
    confirm?: boolean
    previewToken?: string
  }

  async function writeBack(patch: Record<string, string>) {
    const settings = c.get('settings')
    if (!settings) {
      logger.warn('settings service unavailable; toolbar command result dropped')
      return
    }
    // We usually react to the toolbar's own settings write, i.e. from inside its
    // HMR transaction (an AsyncLocalStorage context that timers and promises
    // inherit). Writing from there throws "HMR transactions cannot be nested";
    // stepping out lets our edit queue behind the toolbar's, as Harness's own
    // watchConfig does.
    const hmr = c.get('hmr') as { executing?: { exit<T>(fn: () => T): T } } | undefined
    const write = () => settings.update(NS, patch)
    await (hmr?.executing?.exit ? hmr.executing.exit(write) : write())
  }

  async function runCommand(command: BridgeCommand): Promise<unknown> {
    switch (command.action) {
      case 'delete-session':
        if (!command.sessionId) throw new Error('缺少 sessionId')
        return deleteSession(command.sessionId)
      case 'manage-sessions':
        if (!command.workspace || !command.manageAction) throw new Error('缺少 workspace 或 action')
        return manageSessions(command.workspace, command.manageAction, command.filter ?? {}, command.confirm === true, command.previewToken)
      case 'cleanup-now': {
        const days = config.autoCleanupDays.get()
        if (days <= 0) throw new Error('未设置自动清理天数')
        const summary = await cleanupOldSessions(days)
        await writeBack({ cleanupStatus: JSON.stringify(summary) })
        return summary
      }
      default:
        throw new Error(`未知命令 ${(command as { action?: string }).action}`)
    }
  }

  async function handleCommand() {
    const raw = config.command.get()
    if (!raw) return
    let command: BridgeCommand
    try { command = JSON.parse(raw) } catch { return }
    if (!command?.id || handled.has(command.id)) return
    handled.add(command.id)
    logger.info(`toolbar command ${command.id} ${command.action}`)
    if (Date.now() - Number(command.at ?? 0) > COMMAND_TTL_MS) {
      await writeBack({ command: '' }).catch(() => undefined)
      return
    }
    let reply: Record<string, unknown>
    try {
      reply = { id: command.id, ok: true, result: await runCommand(command) }
    } catch (error) {
      reply = { id: command.id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    await writeBack({ ...(config.command.get() === raw ? { command: '' } : {}), commandResult: JSON.stringify(reply) })
      .then(() => logger.info(`toolbar command ${command.id} answered ok=${String(reply.ok)}`))
      .catch(error => logger.error(`toolbar reply failed: ${error instanceof Error ? error.stack : String(error)}`))
  }

  let lastCleanupDays = config.autoCleanupDays.get()
  async function autoCleanup() {
    const days = config.autoCleanupDays.get()
    if (days <= 0) return
    try {
      const summary = await cleanupOldSessions(days)
      if (summary.deleted || summary.failed.length) logger.info(`auto cleanup removed ${summary.deleted} MCP session(s)`)
      await writeBack({ cleanupStatus: JSON.stringify(summary) })
    } catch (error) {
      logger.warn(`auto cleanup failed: ${String(error)}`)
    }
  }

  ctx.on('loader/volatile-update' as any, () => {
    void handleCommand()
    const days = config.autoCleanupDays.get()
    if (days !== lastCleanupDays) {
      lastCleanupDays = days
      void autoCleanup()
    }
  })

  ctx.effect(() => {
    const first = setTimeout(() => { void autoCleanup() }, 30_000)
    // Fallback in case a volatile-update notification is missed: commands are cheap to re-check.
    const poll = setInterval(() => { void handleCommand().catch(error => logger.warn(`command poll: ${String(error)}`)) }, 1_000)
    const every = setInterval(() => { void autoCleanup() }, 6 * 60 * 60 * 1000)
    return () => {
      clearTimeout(first)
      clearInterval(every)
      clearInterval(poll)
    }
  }, 'mcp-bridge: auto cleanup')

  // The toolbar is this plugin's UI; keep the internal mailbox fields off the auto-generated settings page.
  ctx.effect(() => c.get('settings')?.configure?.({ auto: false }) ?? (() => undefined), 'mcp-bridge: settings page')

  // ---- MCP surface ---------------------------------------------------------

  async function status() {
    const mode = config.mode.get()
    const fallback = defaultSelection()
    const preferred = config.defaultWorkspace.get()
    const workspace = preferred ? findWorkspace(preferred) : undefined
    return {
      enabled: config.enabled.get(),
      mode,
      autoApprove: false,
      legacyAutoApproveIgnored: config.autoApprove.get(),
      approvalMode: snapshot().approvalMode,
      persistentAuthorizationSupported: false,
      providerAllowOverrides: snapshot().providerAllowOverrides,
      configVersion: configVersion(snapshot()), configSource: 'toolbar-v2',
      startupError, storageError: taskStore.error,
      defaultWorkspace: workspace ? { id: workspace.id, title: workspace.title, path: workspace.path } : null,
      ...(mode === 'single'
        ? { model: { provider: config.singleProvider.get() || fallback?.provider, model: config.singleModel.get() || fallback?.model, reasoningEffort: config.singleEffort.get() || null } }
        : { provider: config.providerId.get() || fallback?.provider, defaultModel: config.providerDefaultModel.get() || null, defaultReasoningEffort: config.providerDefaultEffort.get() || null }),
    }
  }

  async function listModels() {
    const cat = await catalog()
    const fallback = defaultSelection()
    if (config.mode.get() === 'single') {
      const provider = config.singleProvider.get() || fallback?.provider
      const model = config.singleModel.get() || fallback?.model
      const entry = provider && model ? findModel(cat, provider, model) : undefined
      return { mode: 'single', locked: true, provider, models: entry ? [entry] : [], reasoningEffort: config.singleEffort.get() || null }
    }
    const provider = config.providerId.get() || fallback?.provider
    const group = cat.groups.find(g => g.id === provider)
    const overrides = config.providerAllowOverrides?.get() ?? false
    const defaultModel = config.providerDefaultModel.get() || group?.models[0]?.id
    return { mode: 'provider', locked: !overrides, providerAllowOverrides: overrides, provider, defaultModel, models: (group?.models ?? []).filter(m => overrides || m.id === defaultModel) }
  }

  const taskShape = {
    task: z.string().describe('交给 Harness 智能体执行的完整任务描述'),
    workspace: z.string().optional().describe('仅当用户明确指定工作区或目录时才传（工作区 id、名称或目录路径）。不要用你自己的当前工作目录填充；不传则使用用户在 Harness 工具栏设置的默认工作区。'),
    sessionId: z.string().optional().describe('继续一个已有会话（来自之前结果的 sessionId）'),
    provider: z.string().optional().describe('供应商始终由工具栏锁定；通常省略，冲突返回 CONFIG_CONFLICT'),
    model: z.string().optional().describe('通常省略。仅用户明确要求且工具栏允许选择时填写；后端冲突返回 CONFIG_CONFLICT，不发送模型请求'),
    reasoningEffort: z.string().optional().describe('通常省略。仅用户明确要求且允许覆盖时填写；不得自行猜测或覆盖右下角配置'),
    title: z.string().optional().describe('新会话标题（自动加 [MCP] 前缀）'),
  }

  async function guarded<T>(fn: () => Promise<T>) {
    if (!config.enabled.get()) return failure('DeepSeek Harness MCP 已在 Harness 右下角工具栏关闭')
    try { await ready; if (unloading) throw new Error('BRIDGE_UNLOADING'); return text(await fn()) } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
  }

  function buildServer(): McpServer {
    const server = new McpServer({ name: 'dsh-mcp-bridge', version: '0.2.1' })
    server.tool('harness_status', '查看 Harness MCP 桥接状态：开关、模式、锁定模型/供应商、默认工作区、自动批准', {}, async () => {
      try { return text(await status()) } catch (error) { return failure(String(error)) }
    })
    server.tool('list_models', '列出当前允许使用的模型和推理等级（单模型模式只有锁定的那一个）', {}, () => guarded(listModels))
    server.tool('list_workspaces', '列出 Harness 的全部工作区', {}, () => guarded(async () => {
      const preferred = config.defaultWorkspace.get()
      return registry().list().map(w => ({ id: w.id, title: w.title, path: w.path, sessions: w.sessionIds.length, isDefault: w.id === preferred }))
    }))
    server.tool('list_sessions', '列出某个工作区的会话', {
      workspace: z.string().describe('工作区 id、名称或路径'),
      includeArchived: z.boolean().optional(),
    }, ({ workspace, includeArchived }) => guarded(() => listSessions(workspace, includeArchived ?? false)))
    server.tool('run_task',
      '让 Harness 智能体执行任务，并一直等到它完成后返回结果（不会因为耗时长而被取消）。'
      + '调用会阻塞：Claude Code 超过 2 分钟会自动转为后台任务并在完成时通知你，不需要也不应该轮询。'
      + '期间每 30 秒发送进度（含是否在等待用户在 Harness 中审批）。若调用被中断，用返回或 list_tasks 中的 taskId 调 wait_task 继续等待。',
      taskShape,
      (args, extra) => guarded(async () => {
        const record = await launch(args)
        await waitFor(record, extra)
        return taskView(record)
      }))
    server.tool('start_task', '在后台启动 Harness 任务并立即返回 taskId。之后用 wait_task 等待结果（一次阻塞调用，不要用 get_task 反复轮询）', taskShape,
      args => guarded(async () => taskView(await launch(args))))
    server.tool('wait_task', '阻塞等待任务完成并返回结果；不会取消任务。timeoutSec 省略则一直等到完成', {
      taskId: z.string(),
      timeoutSec: z.number().optional().describe('最多等待秒数；到时返回当前进度，任务继续在 Harness 中运行'),
    }, ({ taskId, timeoutSec }, extra) => guarded(async () => {
      const record = findTask(taskId)
      await waitFor(record, extra, timeoutSec)
      return taskView(record)
    }))
    server.tool('get_task', '立即返回任务当前状态与进度（不等待）', { taskId: z.string() },
      ({ taskId }) => guarded(async () => taskView(findTask(taskId))))
    server.tool('list_tasks', '列出最近的 MCP 任务（用于连接中断后找回 taskId）', {
      activeOnly: z.boolean().optional().describe('只列出还在排队、运行或等待审批的任务'),
      limit: z.number().optional(),
    }, ({ activeOnly, limit }) => guarded(async () => [...taskStore.records.values()]
      .filter(r => !activeOnly || ACTIVE.includes(r.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit ?? 20)
      .map(r => ({
        taskId: r.id, status: r.status, task: r.task.slice(0, 80), sessionId: r.sessionId, workspace: r.workspace?.title,
        createdAt: new Date(r.createdAt).toISOString(), ...(ACTIVE.includes(r.status) ? { summary: describeProgress(r) } : {}),
      }))))
    server.tool('cancel_task', '取消任务（停止 Harness 中正在执行的智能体）', { taskId: z.string() }, ({ taskId }) => guarded(async () => {
      const record = findTask(taskId)
      if (ACTIVE.includes(record.status)) {
        runtimes.get(taskId)?.cancel?.()
        await durable(record)
      }
      return taskView(record)
    }))
    server.tool('delete_session', '永久删除一个会话（不可恢复；需要保留请用 manage_sessions 归档）', {
      sessionId: z.string(),
      confirm: z.boolean().describe('必须为 true 才会执行'),
    }, ({ sessionId, confirm }) => guarded(async () => {
      if (!confirm) return { dryRun: true, session: await describeSession(sessionId), hint: '确认后带 confirm: true 再调用' }
      return deleteSession(sessionId)
    }))
    server.tool('manage_sessions', '批量归档 / 取消归档 / 永久删除某工作区的会话；不带 confirm: true 时只预览', {
      workspace: z.string().describe('工作区 id、名称或路径'),
      action: z.enum(['archive', 'unarchive', 'delete']),
      mcpOnly: z.boolean().default(true).describe('默认 true，仅 MCP 会话；显式 false 包含个人会话，必须先预览并确认'),
      olderThanDays: z.number().optional().describe('只处理最后修改早于 N 天的会话'),
      includeArchived: z.boolean().optional().describe('删除时默认包含已归档会话'),
      confirm: z.boolean().optional(),
      previewToken: z.string().optional().describe('永久删除必须使用预览返回的短期令牌，绑定具体 ID 和版本'),
    }, ({ workspace, action, confirm, previewToken, ...filter }) => guarded(() => manageSessions(workspace, action, filter, confirm === true, previewToken)))
    return server
  }

  // ---- transports ------------------------------------------------------------

  const tokenReady = loadToken(config.authTokenFile, logger).then(value => Buffer.from(value))

  function tokenMatches(given: string, token: Buffer): boolean {
    const candidate = Buffer.from(given)
    return candidate.length === token.length && timingSafeEqual(candidate, token)
  }

  const endpointFile = join(dshHome(), 'mcp-bridge', 'endpoint.json')
  const endpoint: { pipe?: string; protocol: string; http?: string; pid: number } = { pid: process.pid, protocol: PIPE_PROTOCOL }
  const publishEndpoint = async () => {
    await mkdir(join(dshHome(), 'mcp-bridge'), { recursive: true })
    await writeFile(`${endpointFile}.tmp`, JSON.stringify(endpoint, null, 2))
    await rename(`${endpointFile}.tmp`, endpointFile)
  }

  // Standard TLS 1.3 with mutually pinned signing keys works in Electron's
  // BoringSSL too. Both pins derive from the token, which is never transmitted.
  ctx.effect(() => {
    const path = config.pipePath || defaultPipePath()
    const sockets = new Set<net.Socket>()
    let server: tls.Server | undefined
    let disposed = false
    const listen = async () => {
      const identity = createPipeIdentity(await tokenReady, 'server')
      if (disposed) return
      server = tls.createServer({ ...identity.options, handshakeTimeout: 10_000 }, socket => {
        socket.on('error', () => socket.destroy())
        if (!identity.verifyPeer(socket)) { socket.destroy(); return }
        socket.pause()
        const mcp = buildServer()
        socket.on('close', () => { void mcp.close() })
        void mcp.connect(new StdioServerTransport(socket, socket)).then(() => socket.resume()).catch(() => socket.destroy())
      })
      server.on('connection', raw => {
        sockets.add(raw)
        raw.on('close', () => sockets.delete(raw))
        raw.on('error', () => raw.destroy())
      })
      server.on('tlsClientError', (_error, socket) => socket.destroy())
      server.on('error', (error: NodeJS.ErrnoException) => {
        logger.error(error.code === 'EADDRINUSE'
          ? `管道 ${path} 已被占用（是否有另一个 Harness 实例在运行？）`
          : `pipe server error: ${String(error)}`)
      })
      if (process.platform !== 'win32') {
        await mkdir(join(path, '..'), { recursive: true })
        // A stale socket file from a crash would block listen(); a live owner still answers connect().
        const alive = await new Promise<boolean>(done => {
          const probe = net.connect(path, () => { probe.destroy(); done(true) })
          probe.on('error', () => done(false))
        })
        if (alive) {
          logger.error(`socket ${path} 已被另一个进程使用`)
          return
        }
        await rm(path, { force: true })
      }
      if (disposed) return
      server.listen(path, () => {
        logger.info(`MCP pipe listening on ${path}`)
        endpoint.pipe = path
        void publishEndpoint().catch(error => logger.warn(`write endpoint failed: ${String(error)}`))
      })
    }
    void listen().catch(() => logger.error('PIPE_START_FAILED'))
    return () => {
      disposed = true
      for (const socket of sockets) socket.destroy()
      server?.close(() => undefined)
    }
  }, 'mcp-bridge: pipe server')

  // Optional: Streamable HTTP for clients without stdio support. Off by default.
  ctx.effect(() => {
    if (!config.httpEnabled) return () => undefined
    const server = http.createServer(async (req, res) => {
      const reply = (code: number, message: string) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
      }
      try {
        const header = req.headers.authorization ?? ''
        if (!tokenMatches(header.startsWith('Bearer ') ? header.slice(7).trim() : '', await tokenReady)) return reply(401, 'unauthorized')
        if (!req.url?.startsWith('/mcp')) return reply(404, 'not found')
        if (req.method !== 'POST') return reply(405, 'method not allowed (stateless server)')
        const mcp = buildServer()
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => { void transport.close(); void mcp.close() })
        await mcp.connect(transport)
        await transport.handleRequest(req, res)
      } catch (error) {
        logger.warn('HTTP_REQUEST_FAILED')
        if (!res.headersSent) reply(500, 'HTTP_REQUEST_FAILED')
      }
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      logger.error(error.code === 'EADDRINUSE'
        ? `HTTP 端口 ${config.port} 已被占用，HTTP 端点未启动（本地管道不受影响）。可在配置里改 port。`
        : `HTTP server error: ${String(error)}`)
    })
    server.listen(config.port, config.host, () => {
      endpoint.http = `http://${config.host}:${config.port}/mcp`
      logger.info(`MCP HTTP listening on ${endpoint.http}`)
      void publishEndpoint().catch(() => undefined)
    })
    return () => {
      server.closeAllConnections?.()
      server.close()
      delete endpoint.http
    }
  }, 'mcp-bridge: http server')
}
