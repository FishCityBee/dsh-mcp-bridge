/**
 * Persistent task records. Every MCP task (sync or async) gets one, so a caller
 * that lost its connection can find the task again, and a Harness restart
 * leaves an honest "interrupted" record instead of silently forgetting work.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const list = JSON.parse(await readFile(this.path, 'utf8')) as StoredTask[]
      for (const record of list) this.records.set(record.id, record)
    } catch { /* first run */ }
  }

  /** Coalesce writes; progress ticks call this often. */
  save(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 2000)
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const now = Date.now()
    const kept = [...this.records.values()]
      .filter(r => ACTIVE.includes(r.status) || now - (r.finishedAt ?? r.createdAt) < KEEP_MS)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, KEEP_COUNT)
    this.records.clear()
    for (const record of kept) this.records.set(record.id, record)
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      await writeFile(temp, JSON.stringify(kept, null, 2))
      await rename(temp, this.path)
    }).catch(() => undefined)
    return this.writing
  }
}
