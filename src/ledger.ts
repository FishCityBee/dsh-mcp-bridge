/** Small JSON ledger of sessions this bridge created, so batch tools can filter "MCP only". */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface LedgerEntry {
  title: string
  createdAt: number
  workspaceId?: string
}

export class SessionLedger {
  private cache: Record<string, LedgerEntry> | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, LedgerEntry>> {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(await readFile(this.path, 'utf8'))
    } catch {
      this.cache = {}
    }
    return this.cache!
  }

  private persist(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      await writeFile(temp, JSON.stringify(this.cache ?? {}, null, 2))
      await rename(temp, this.path)
    }).catch(() => undefined)
    return this.writing
  }

  async entries(): Promise<[string, LedgerEntry][]> {
    return Object.entries(await this.load())
  }

  async get(id: string): Promise<LedgerEntry | undefined> {
    return (await this.load())[id]
  }

  async add(id: string, entry: LedgerEntry): Promise<void> {
    (await this.load())[id] = entry
    await this.persist()
  }

  async remove(id: string): Promise<void> {
    const data = await this.load()
    if (!(id in data)) return
    delete data[id]
    await this.persist()
  }
}
