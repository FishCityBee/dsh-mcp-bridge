/** Small JSON ledger of sessions this bridge created, so batch tools can filter "MCP only". */
import { JsonWriter, readJson } from './persistence.ts'

export interface LedgerEntry {
  title: string
  createdAt: number
  workspaceId?: string
}

export class SessionLedger {
  private cache: Record<string, LedgerEntry> | undefined
  private loading?: Promise<Record<string, LedgerEntry>>
  private writer: JsonWriter
  private updating: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) { this.writer = new JsonWriter(path) }

  private async load(): Promise<Record<string, LedgerEntry>> {
    if (this.cache) return this.cache
    this.loading ??= readJson<Record<string, LedgerEntry>>(this.path, () => Object.create(null)).then(data => {
      if (!data || Array.isArray(data) || typeof data !== 'object' || Object.values(data).some(v => !v || typeof v.createdAt !== 'number')) throw new Error('STORAGE_READ_FAILED: invalid session ledger')
      this.cache = Object.assign(Object.create(null), data)
      return this.cache!
    })
    return this.loading
  }

  private persist(): Promise<void> {
    return this.writer.write(this.cache ?? {})
  }

  async entries(): Promise<[string, LedgerEntry][]> {
    await this.updating.catch(() => undefined)
    return Object.entries(await this.load())
  }

  async get(id: string): Promise<LedgerEntry | undefined> {
    await this.updating.catch(() => undefined)
    return (await this.load())[id]
  }

  async add(id: string, entry: LedgerEntry): Promise<void> {
    const operation = this.updating.catch(() => undefined).then(async () => {
      const data = await this.load(), previous = data[id]
      data[id] = entry
      try { await this.persist() } catch (error) {
        if (previous === undefined) delete data[id]
        else data[id] = previous
        throw error
      }
    })
    this.updating = operation
    return operation
  }

  async remove(id: string): Promise<void> {
    const operation = this.updating.catch(() => undefined).then(async () => {
      const data = await this.load(), previous = data[id]
      if (!(id in data)) return
      delete data[id]
      try { await this.persist() } catch (error) { data[id] = previous!; throw error }
    })
    this.updating = operation
    return operation
  }
}
