/**
 * Persistent task records. Every MCP task (sync or async) gets one, so a caller
 * that lost its connection can find the task again, and a Harness restart
 * leaves an honest "interrupted" record instead of silently forgetting work.
 */
import { JsonWriter, readJson } from './persistence.ts'
import type { RequestedSelection, Selection } from './selection.ts'

export type TaskStatus = 'queued' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export const ACTIVE: readonly TaskStatus[] = ['queued', 'running', 'waiting_approval']

export interface TaskProgress {
  /** Assistant messages produced so far. */
  steps: number
  toolCalls: number
  lastTool?: string
  /** Tail of the latest assistant text. */
  lastText?: string
  lastActivityAt: number
  /** Set while the agent waits for a human approval in Harness. */
  pendingApproval?: { toolName: string; reason?: string }
}

export interface TaskResultData {
  finalText: string
  toolCalls: { name: string; arguments: string }[]
}

export interface StoredTask {
  id: string
  status: TaskStatus
  task: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  sessionId?: string
  workspace?: { id: string; title: string; path: string }
  cwd?: string
  provider: string
  model: string
  reasoningEffort?: string
  requestedSelection?: RequestedSelection
  effectiveSelection?: Selection | null
  configVersion?: string
  configSource?: string
  selectionEvidence?: 'llm/stream'
  requestCount?: number
  eventBaseline?: number
  termination?: { kind: string; error?: { code: string; message: string }; reason?: { kind: string } }
  approval?: { mode: string; source: string; preset?: string; sandbox?: string; persistentGrants: false }
  approvalDiagnostics?: { tool: string; outcome?: string; reason: string }[]
  durability?: 'pending' | 'durable' | 'degraded'
  persistenceError?: string
  /** Message count before this task's prompt, for collecting its result after a reattach. */
  baseline?: number
  progress: TaskProgress
  result?: TaskResultData
  error?: string
}

const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const KEEP_COUNT = 200

export class TaskStore {
  readonly records = new Map<string, StoredTask>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private writer: JsonWriter
  private loading?: Promise<void>

  constructor(private readonly path: string, private readonly onError: (error: unknown) => void = () => {}) { this.writer = new JsonWriter(path) }

  get error() { return this.writer.error }

  async load(): Promise<void> {
    this.loading ??= (async () => {
      const list = await readJson<StoredTask[]>(this.path, () => [])
      if (!Array.isArray(list) || list.some(r => !r || typeof r.id !== 'string' || typeof r.status !== 'string')) throw new Error('STORAGE_READ_FAILED: invalid task records')
      for (const record of list) this.records.set(record.id, record)
    })()
    return this.loading
  }

  /** Coalesce writes; progress ticks call this often. */
  save(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(this.onError)
    }, 2000)
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const now = Date.now()
    const active = [...this.records.values()].filter(r => ACTIVE.includes(r.status))
    const history = [...this.records.values()]
      .filter(r => !ACTIVE.includes(r.status) && now - (r.finishedAt ?? r.createdAt) < KEEP_MS)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, KEEP_COUNT)
    const kept = [...active, ...history]
    this.records.clear()
    for (const record of kept) this.records.set(record.id, record)
    return this.writer.write(kept)
  }
}
