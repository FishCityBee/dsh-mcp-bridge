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
import { SessionId } from '@deepseek-ai/dsh-session'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildCatalog, findModel, type Catalog } from './catalog.ts'
import { SessionLedger } from './ledger.ts'
import { createFileLogger, type BridgeLogger } from './log.ts'
import { ACTIVE, TaskStore, type StoredTask, type TaskProgress } from './tasks.ts'

export const name = 'mcp-bridge'
export const inject = ['llm', 'agents', 'agentPresets', 'workspaceRegistry']

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
  defaultWorkspace: Schema.string().default('').volatile(),
  autoApprove: Schema.boolean().default(false).volatile(),
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
  defaultWorkspace: Ref<string>
  autoApprove: Ref<boolean>
  autoCleanupDays: Ref<number>
  command: Ref<string>
  commandResult: Ref<string>
  cleanupStatus: Ref<string>
}

interface Selection { provider: string; model: string; reasoningEffort?: string }

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
  model?: string
  reasoningEffort?: string
  title?: string
}

/** In-memory companion of a stored task: completion promise and cancel hook. */
interface TaskRuntime {
  done: Promise<void>
  cancel?: () => void
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

/** First line a pipe client must send before MCP framing starts. */
const AUTH_KEY = 'dsh-mcp-bridge-auth'

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
  } catch { /* generated below */ }
  const token = randomBytes(24).toString('hex')
  await writeFile(path, token + '\n', { mode: 0o600 })
  logger.info(`generated MCP token at ${path}`)
  return token
}

/** Counting semaphore for concurrent agent runs. */
class Semaphore {
  private waiters: (() => void)[] = []
  private active = 0
  constructor(private readonly limit: () => number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= Math.max(1, this.limit())) await new Promise<void>(r => this.waiters.push(r))
    this.active++
    try { return await fn() } finally {
      this.active--
      this.waiters.shift()?.()
    }
  }
}

export function apply(ctx: Context, config: BridgeConfig): void {
  const c = ctx as any
  const logger = createFileLogger(ctx.logger, join(dshHome(), 'mcp-bridge', 'bridge.log'))
  const ledger = new SessionLedger(join(dshHome(), 'mcp-bridge', 'sessions.json'))
  const owned = new Map<string, { agent: any; dispose: () => Promise<void> }>()
  const sessionLocks = new Map<string, Promise<unknown>>()
  const taskStore = new TaskStore(join(dshHome(), 'mcp-bridge', 'tasks.json'))
  const runtimes = new Map<string, TaskRuntime>()
  const busySessions = () => new Set([...taskStore.records.values()].filter(r => ACTIVE.includes(r.status) && r.sessionId).map(r => r.sessionId!))
  const semaphore = new Semaphore(() => config.maxConcurrentTasks)

  // ---- model selection ---------------------------------------------------

  const catalog = (): Promise<Catalog> => buildCatalog(ctx)

  function defaultSelection(): Selection | undefined {
    return c.get('agentDefaultModel')?.currentSelection?.()
  }

  /** Resolve the effective provider/model/effort for one call, enforcing the toolbar mode. */
  async function resolveSelection(model?: string, effort?: string): Promise<Selection> {
    const cat = await catalog()
    const fallback = defaultSelection()
    if (config.mode.get() === 'single') {
      const provider = config.singleProvider.get() || fallback?.provider
      const locked = config.singleModel.get() || fallback?.model
      if (!provider || !locked) throw new Error('单模型模式下尚未选择模型，请在 Harness 右下角工具栏选择')
      if (model && model !== locked) {
        throw new Error(`当前为单模型模式，已锁定 ${provider}/${locked}，不能改用 ${model}。可在 Harness 工具栏切换到供应商模式。`)
      }
      const lockedEffort = config.singleEffort.get() || undefined
      if (effort && effort !== lockedEffort) {
        throw new Error(`当前为单模型模式，推理等级已锁定为 ${lockedEffort ?? '模型默认'}，不能改用 ${effort}`)
      }
      if (!findModel(cat, provider, locked)) throw new Error(`锁定的模型 ${provider}/${locked} 当前不可用（凭据缺失或供应商已移除）`)
      return { provider, model: locked, ...(lockedEffort ? { reasoningEffort: lockedEffort } : {}) }
    }
    const provider = config.providerId.get() || fallback?.provider
    if (!provider) throw new Error('供应商模式下尚未选择供应商，请在 Harness 右下角工具栏选择')
    const group = cat.groups.find(g => g.id === provider)
    if (!group) throw new Error(`供应商 ${provider} 当前不可用`)
    const chosen = model || config.providerDefaultModel.get() || group.models[0]?.id
    const entry = group.models.find(m => m.id === chosen)
    if (!entry) {
      throw new Error(`模型 ${chosen} 不属于供应商 ${provider}。可用：${group.models.map(m => m.id).join(', ')}`)
    }
    const efforts = entry.reasoning?.efforts.map(e => e.id) ?? []
    if (effort && !efforts.includes(effort)) {
      throw new Error(`模型 ${entry.id} 不支持推理等级 ${effort}。可用：${efforts.join(', ') || '（无）'}`)
    }
    // Caller's effort > toolbar default (when this model supports it) > the model's own default.
    const preferred = config.providerDefaultEffort.get()
    const reasoningEffort = effort
      || (preferred && efforts.includes(preferred) ? preferred : undefined)
      || entry.reasoning?.defaultEffort
    return { provider, model: entry.id, ...(reasoningEffort ? { reasoningEffort } : {}) }
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
  function remember(id: string, handle: { agent: any; dispose: () => Promise<void> }) {
    owned.set(id, handle)
    const busy = busySessions()
    for (const [candidate, old] of owned) {
      if (owned.size <= MAX_OWNED_AGENTS) break
      if (candidate === id || busy.has(candidate)) continue
      owned.delete(candidate)
      void old.dispose().catch(error => logger.warn(`dispose ${candidate} failed: ${String(error)}`))
    }
  }

  async function createAgent(args: TaskArgs, selection: Selection, target: { cwd: string; workspace?: WorkspaceLike }) {
    const { cwd, workspace } = target
    const preset = await presetId()
    const autoApprove = config.autoApprove.get()
    const sessionId = SessionId(`session-${randomUUID()}`)
    const handle = await c.agents.create({
      sessionId,
      meta: { cwd, agentPreset: preset },
      agentOptions: agentOptions(selection),
      setup: async (agentCtx: Context, agent: any) => {
        await c.agentPresets.mount(agentCtx, preset)
        if (autoApprove) setApprovalPolicy(agent.session, 'never')
      },
    })
    remember(sessionId, handle)
    if (workspace) {
      await workspace.attachSession(sessionId).catch(error => logger.warn(`attach ${sessionId} failed: ${String(error)}`))
    }
    const title = `[MCP] ${args.title || args.task.replace(/\s+/g, ' ').slice(0, 40)}`
    try { c.get('sessionTitle')?.rename(handle.agent.session, title) } catch (error) {
      logger.warn(`rename ${sessionId} failed: ${String(error)}`)
    }
    await ledger.add(sessionId, { title, createdAt: Date.now(), workspaceId: workspace?.id })
    return handle.agent
  }

  async function continueAgent(id: string, selection: Selection) {
    // An archived session's wakes are gated by the workspace registry; reopen it first.
    const reg = registry()
    if (reg.archivedSessionIds.map(String).includes(id)) await reg.unarchiveSession(SessionId(id))
    const known = owned.get(id)
    if (known) {
      owned.delete(id)
      owned.set(id, known)
      return known.agent
    }
    const live = c.agents.get(SessionId(id))
    if (live) return live
    const preset = await presetId()
    const handle = await c.agents.resume({
      resumeSessionId: SessionId(id),
      agentOptions: agentOptions(selection),
      setup: async (agentCtx: Context) => { await c.agentPresets.mount(agentCtx, preset) },
    })
    remember(id, handle)
    return handle.agent
  }

  async function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    sessionLocks.set(id, next.catch(() => undefined))
    return next
  }

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

  interface MonitorState { eventSeq: number; approvals: Map<string, { toolName: string; reason?: string }> }

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
        if (event.type === 'approval/asked') state.approvals.set(String(event.data.id), { toolName: event.data.toolName, ...(event.data.reason ? { reason: event.data.reason } : {}) })
        else if (event.type === 'approval/decided') state.approvals.delete(String(event.data.id))
      }
      state.eventSeq = Number(agent.session.seq)
    } catch { /* event reads are best-effort */ }
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

  /** Run the prompt on an agent and follow it to idle. Shared by fresh runs and reattached ones. */
  async function follow(record: StoredTask, agent: any, runtime: TaskRuntime, prompt?: string) {
    const state: MonitorState = { eventSeq: Number(agent.session.seq ?? 0), approvals: new Map() }
    let cancelled = false
    runtime.cancel = () => {
      cancelled = true
      agent.cancel({ kind: 'user' })
    }
    if (prompt !== undefined) {
      record.baseline = agent.session.deriveMessages().length
      record.status = 'running'
      record.startedAt = Date.now()
      taskStore.save()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } } as any))
    }
    const timer = setInterval(() => {
      try { sample(record, agent, state) } catch (error) { logger.warn(`monitor ${record.id}: ${String(error)}`) }
    }, MONITOR_INTERVAL_MS)
    try {
      await agent.whenIdle()
    } finally {
      clearInterval(timer)
    }
    sample(record, agent, state)
    record.result = summarize(agent.session.deriveMessages().slice(record.baseline ?? 0))
    record.status = cancelled ? 'cancelled' : 'done'
    delete record.progress.pendingApproval
    record.finishedAt = Date.now()
  }

  function track(record: StoredTask, work: (runtime: TaskRuntime) => Promise<void>): TaskRuntime {
    const runtime: TaskRuntime = { done: Promise.resolve() }
    runtimes.set(record.id, runtime)
    runtime.done = work(runtime).catch(error => {
      record.status = 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      logger.warn(`task ${record.id} failed: ${record.error}`)
    }).finally(() => {
      record.finishedAt ??= Date.now()
      runtime.cancel = undefined
      taskStore.save()
    })
    return runtime
  }

  /** Validate synchronously (bad model / workspace fail the call), then run in the background. */
  async function launch(args: TaskArgs): Promise<StoredTask> {
    const selection = await resolveSelection(args.model, args.reasoningEffort)
    const target = args.sessionId ? undefined : await resolveTarget(args)
    const now = Date.now()
    const record: StoredTask = {
      id: `task-${randomUUID()}`,
      status: 'queued',
      task: args.task.slice(0, 2000),
      createdAt: now,
      ...selection,
      ...(target ? { cwd: target.cwd } : {}),
      ...(target?.workspace ? { workspace: { id: target.workspace.id, title: target.workspace.title, path: target.workspace.path } } : {}),
      progress: { steps: 0, toolCalls: 0, lastActivityAt: now },
    }
    taskStore.records.set(record.id, record)
    taskStore.save()
    track(record, async runtime => {
      let cancelledEarly = false
      runtime.cancel = () => { cancelledEarly = true }
      await semaphore.run(async () => {
        if (cancelledEarly) {
          record.status = 'cancelled'
          return
        }
        const agent = args.sessionId
          ? await continueAgent(args.sessionId, selection)
          : await createAgent(args, selection, target!)
        record.sessionId = String(agent.session.header.id)
        record.cwd ??= agent.session.header.cwd
        await withSessionLock(record.sessionId, () => follow(record, agent, runtime, args.task))
      })
    })
    return record
  }

  /** After a restart, keep following tasks whose agent is still alive; mark the rest interrupted. */
  async function recoverTasks() {
    await taskStore.load()
    for (const record of taskStore.records.values()) {
      if (!ACTIVE.includes(record.status) || runtimes.has(record.id)) continue
      const agent = record.sessionId ? c.agents.get(SessionId(record.sessionId)) : undefined
      if (agent && record.baseline !== undefined) {
        logger.info(`reattaching task ${record.id} to live session ${record.sessionId}`)
        track(record, runtime => follow(record, agent, runtime))
        continue
      }
      record.status = 'interrupted'
      record.error = 'Harness 重启或插件重载导致任务中断。会话已保存，可用 run_task 带 sessionId 让它继续。'
      record.finishedAt = Date.now()
    }
    taskStore.save()
  }
  void recoverTasks().catch(error => logger.warn(`recover tasks failed: ${String(error)}`))

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
    if (!runtime || !ACTIVE.includes(record.status)) return
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
    if (signal) waits.push(new Promise(done => signal.addEventListener('abort', done, { once: true })))
    try {
      await Promise.race(waits)
    } finally {
      clearInterval(tick)
      clearTimeout(timer)
    }
  }

  function findTask(taskId: string): StoredTask {
    const record = taskStore.records.get(taskId)
    if (!record) throw new Error(`任务 ${taskId} 不存在或已过期（记录保留 7 天）`)
    return record
  }

  ctx.effect(() => () => {
    for (const record of taskStore.records.values()) {
      if (ACTIVE.includes(record.status)) logger.info(`plugin unloading; task ${record.id} keeps running in Harness`)
    }
    void taskStore.flush()
    // Agents still working are left alive; a reloaded instance reattaches to them.
    const handles = [...owned.entries()]
    owned.clear()
    for (const [id, handle] of handles) {
      if (!busySessions().has(id)) void handle.dispose().catch(() => undefined)
    }
  }, 'mcp-bridge: owned agents')

  // ---- workspaces & sessions ----------------------------------------------

  async function sessionDirectory(id: string): Promise<string | undefined> {
    const root = join(dshHome(), 'sessions')
    for (const bucket of await readdir(root).catch(() => [] as string[])) {
      const candidate = join(root, bucket, id)
      if ((await stat(candidate).catch(() => undefined))?.isDirectory()) return candidate
    }
    return undefined
  }

  async function sessionTitle(id: string): Promise<string | undefined> {
    const cache = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
    try {
      const value = JSON.parse(await readFile(cache, 'utf8'))?.record?.rows?.title?.val
      if (typeof value === 'string') return value
    } catch { /* not cached */ }
    return (await ledger.get(id))?.title
  }

  async function describeSession(id: string) {
    const reg = registry()
    const directory = await sessionDirectory(id)
    const modified = directory ? (await stat(directory).catch(() => undefined))?.mtimeMs : undefined
    return {
      sessionId: id,
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
  interface PendingDelete { id: string; directory?: string; unarchive?: boolean }

  async function readPending(): Promise<PendingDelete[]> {
    try { return JSON.parse(await readFile(pendingDeletesFile, 'utf8')) } catch { return [] }
  }
  async function writePending(list: PendingDelete[]) {
    await mkdir(join(dshHome(), 'mcp-bridge'), { recursive: true })
    await writeFile(pendingDeletesFile, JSON.stringify(list, null, 2))
  }

  async function removeTree(path: string): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(path, { recursive: true, force: true })
        return true
      } catch {
        await new Promise(done => setTimeout(done, 400))
      }
    }
    return false
  }

  async function deleteSession(id: string): Promise<{ deleted: string; note?: string }> {
    const reg = registry()
    const sid = SessionId(id)
    if (busySessions().has(id)) throw new Error(`会话 ${id} 还有正在执行的 MCP 任务，先用 cancel_task 取消再删除`)
    const handle = owned.get(id)
    if (handle) {
      owned.delete(id)
      await handle.dispose()
    }
    const resident = c.agents.get(sid)
    if (resident) {
      await reg.archiveSession(sid, { stopActivity: true })
      await Promise.race([resident.whenIdle?.(), new Promise(done => setTimeout(done, 10_000))]).catch(() => undefined)
    }
    const directory = await sessionDirectory(id)
    const holders = reg.list().filter(w => w.sessionIds.map(String).includes(id))
    if (!directory && holders.length === 0 && !resident) throw new Error(`找不到会话 ${id}`)
    for (const workspace of holders) await workspace.detachSession?.(sid)
    if (reg.pinnedSessionIds.map(String).includes(id)) await reg.unpinSession(sid)
    // A resident session stays archived (so it cannot wake) until the next start clears the id.
    if (!resident && reg.archivedSessionIds.map(String).includes(id)) await reg.unarchiveSession(sid)
    await rm(join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`), { force: true }).catch(() => undefined)
    const removed = directory ? await removeTree(directory) : true
    await ledger.remove(id)
    if (!removed || resident) {
      const pending = (await readPending()).filter(p => p.id !== id)
      pending.push({ id, ...(removed ? {} : { directory }), ...(resident ? { unarchive: true } : {}) })
      await writePending(pending)
    }
    logger.info(`deleted session ${id}${removed ? '' : ' (files queued)'}`)
    return removed
      ? { deleted: id }
      : { deleted: id, note: '会话已从列表移除；部分文件仍被 Harness 占用，下次启动 Harness 时自动清理' }
  }

  /** Finish deletions that a live file handle or a resident agent blocked last time. */
  async function finishPendingDeletes() {
    const pending = await readPending()
    if (!pending.length) return
    const reg = registry()
    const left: PendingDelete[] = []
    for (const item of pending) {
      if (c.agents.get(SessionId(item.id))) {
        left.push(item)
        continue
      }
      const removed = item.directory ? await removeTree(item.directory) : true
      if (item.unarchive && reg.archivedSessionIds.map(String).includes(item.id)) {
        await reg.unarchiveSession(SessionId(item.id)).catch(() => undefined)
      }
      if (!removed) left.push(item)
    }
    await writePending(left)
    logger.info(`pending deletes: finished ${pending.length - left.length}, remaining ${left.length}`)
  }
  ctx.effect(() => {
    const timer = setTimeout(() => { void finishPendingDeletes().catch(error => logger.warn(`pending deletes: ${String(error)}`)) }, 5_000)
    return () => clearTimeout(timer)
  }, 'mcp-bridge: pending deletes')

  type BatchAction = 'archive' | 'unarchive' | 'delete'
  interface BatchFilter { mcpOnly?: boolean; olderThanDays?: number; includeArchived?: boolean }

  async function manageSessions(query: string, action: BatchAction, filter: BatchFilter, confirm: boolean) {
    const includeArchived = action === 'unarchive' ? true : filter.includeArchived ?? action === 'delete'
    const { workspace, sessions } = await listSessions(query, includeArchived)
    const cutoff = filter.olderThanDays === undefined ? undefined : Date.now() - filter.olderThanDays * 86_400_000
    const targets = sessions.filter(s =>
      (!filter.mcpOnly || s.mcp)
      && (action !== 'unarchive' || s.archived)
      && (action !== 'archive' || !s.archived)
      && (cutoff === undefined || (s.updatedAt !== undefined && Date.parse(s.updatedAt) < cutoff)))
    if (!confirm) return { workspace, action, dryRun: true, count: targets.length, targets, hint: '确认无误后带 confirm: true 再调用一次' }
    const reg = registry()
    const results: { sessionId: string; ok: boolean; detail?: string }[] = []
    for (const target of targets) {
      try {
        if (action === 'archive') await reg.archiveSession(SessionId(target.sessionId), { stopActivity: true })
        else if (action === 'unarchive') await reg.unarchiveSession(SessionId(target.sessionId))
        else results.push({ sessionId: target.sessionId, ok: true, detail: (await deleteSession(target.sessionId)).note })
        if (action !== 'delete') results.push({ sessionId: target.sessionId, ok: true })
      } catch (error) {
        results.push({ sessionId: target.sessionId, ok: false, detail: error instanceof Error ? error.message : String(error) })
      }
    }
    return { workspace, action, done: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }
  }

  /** Delete MCP-created sessions whose files were last modified more than `days` days ago. */
  async function cleanupOldSessions(days: number) {
    const cutoff = Date.now() - days * 86_400_000
    const deleted: string[] = []
    const failed: { sessionId: string; detail: string }[] = []
    for (const [id] of await ledger.entries()) {
      if (c.agents.get(SessionId(id)) !== undefined) continue
      const directory = await sessionDirectory(id)
      if (!directory) {
        await ledger.remove(id)
        continue
      }
      const modified = (await stat(directory).catch(() => undefined))?.mtimeMs
      if (modified === undefined || modified >= cutoff) continue
      try {
        await deleteSession(id)
        deleted.push(id)
      } catch (error) {
        failed.push({ sessionId: id, detail: error instanceof Error ? error.message : String(error) })
      }
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
        return manageSessions(command.workspace, command.manageAction, command.filter ?? {}, command.confirm === true)
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
    await writeBack({ command: '', commandResult: JSON.stringify(reply) })
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
      autoApprove: config.autoApprove.get(),
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
    return { mode: 'provider', locked: false, provider, defaultModel: config.providerDefaultModel.get() || group?.models[0]?.id, models: group?.models ?? [] }
  }

  const taskShape = {
    task: z.string().describe('交给 Harness 智能体执行的完整任务描述'),
    workspace: z.string().optional().describe('仅当用户明确指定工作区或目录时才传（工作区 id、名称或目录路径）。不要用你自己的当前工作目录填充；不传则使用用户在 Harness 工具栏设置的默认工作区。'),
    sessionId: z.string().optional().describe('继续一个已有会话（来自之前结果的 sessionId）'),
    model: z.string().optional().describe('模型 id；单模型模式下不可更改，供应商模式下须属于所选供应商'),
    reasoningEffort: z.string().optional().describe('推理等级 id；单模型模式下不可更改'),
    title: z.string().optional().describe('新会话标题（自动加 [MCP] 前缀）'),
  }

  async function guarded<T>(fn: () => Promise<T>) {
    if (!config.enabled.get()) return failure('DeepSeek Harness MCP 已在 Harness 右下角工具栏关闭')
    try { return text(await fn()) } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
  }

  function buildServer(): McpServer {
    const server = new McpServer({ name: 'dsh-mcp-bridge', version: '0.1.0' })
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
        if (record.status === 'queued') record.status = 'cancelled'
        taskStore.save()
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
      mcpOnly: z.boolean().optional().describe('只处理 MCP 创建的会话'),
      olderThanDays: z.number().optional().describe('只处理最后修改早于 N 天的会话'),
      includeArchived: z.boolean().optional().describe('删除时默认包含已归档会话'),
      confirm: z.boolean().optional(),
    }, ({ workspace, action, confirm, ...filter }) => guarded(() => manageSessions(workspace, action, filter, confirm === true)))
    return server
  }

  // ---- transports ------------------------------------------------------------

  const tokenReady = loadToken(config.authTokenFile, logger).then(value => Buffer.from(value))

  function tokenMatches(given: string, token: Buffer): boolean {
    const candidate = Buffer.from(given)
    return candidate.length === token.length && timingSafeEqual(candidate, token)
  }

  const endpointFile = join(dshHome(), 'mcp-bridge', 'endpoint.json')
  const endpoint: { pipe?: string; http?: string; pid: number } = { pid: process.pid }
  const publishEndpoint = async () => {
    await mkdir(join(dshHome(), 'mcp-bridge'), { recursive: true })
    await writeFile(`${endpointFile}.tmp`, JSON.stringify(endpoint, null, 2))
    await rename(`${endpointFile}.tmp`, endpointFile)
  }

  // Primary: local pipe. A client sends one `{"dsh-mcp-bridge-auth": token}` line,
  // then the socket carries newline-delimited MCP JSON-RPC (stdio framing) for a
  // long-lived session — no TCP port, no request timeouts.
  ctx.effect(() => {
    const path = config.pipePath || defaultPipePath()
    const sockets = new Set<net.Socket>()
    const server = net.createServer(socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      let head = Buffer.alloc(0)
      const onData = (chunk: Buffer) => { void handshake(Buffer.from(chunk)) }
      const handshake = async (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        const newline = head.indexOf(0x0a)
        if (newline < 0) {
          if (head.length > 4096) socket.destroy()
          return
        }
        socket.off('data', onData)
        socket.pause()
        const rest = head.subarray(newline + 1)
        try {
          const given = JSON.parse(head.subarray(0, newline).toString('utf8'))?.[AUTH_KEY]
          if (typeof given !== 'string' || !tokenMatches(given, await tokenReady)) {
            socket.end(JSON.stringify({ [AUTH_KEY]: 'unauthorized' }) + '\n')
            return
          }
        } catch {
          socket.end(JSON.stringify({ [AUTH_KEY]: 'bad handshake' }) + '\n')
          return
        }
        socket.write(JSON.stringify({ [AUTH_KEY]: 'ok' }) + '\n')
        const mcp = buildServer()
        const transport = new StdioServerTransport(socket, socket)
        socket.on('close', () => { void mcp.close() })
        await mcp.connect(transport)
        if (rest.length) socket.unshift(rest)
        socket.resume()
      }
      socket.on('data', onData)
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      logger.error(error.code === 'EADDRINUSE'
        ? `管道 ${path} 已被占用（是否有另一个 Harness 实例在运行？）`
        : `pipe server error: ${String(error)}`)
    })
    const listen = async () => {
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
      server.listen(path, () => {
        logger.info(`MCP pipe listening on ${path}`)
        endpoint.pipe = path
        void publishEndpoint().catch(error => logger.warn(`write endpoint failed: ${String(error)}`))
      })
    }
    void listen()
    return () => {
      for (const socket of sockets) socket.destroy()
      server.close()
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
        logger.warn(`request failed: ${String(error)}`)
        if (!res.headersSent) reply(500, String(error))
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
