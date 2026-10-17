import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJson<T>(path: string, empty: () => T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
    throw new Error('STORAGE_READ_FAILED: 无法可靠读取桥接记录', { cause: error })
  }
}

/** Queue snapshots without poisoning future retries; every caller sees its own failure. */
export class JsonWriter {
  private writing: Promise<void> = Promise.resolve()
  error?: string
  constructor(private readonly path: string) {}
  write(value: unknown): Promise<void> {
    const data = JSON.stringify(value, null, 2)
    const operation = this.writing.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      const file = await open(temp, 'w', 0o600)
      try { await file.writeFile(data, 'utf8'); await file.sync() } finally { await file.close() }
      await rename(temp, this.path)
      this.error = undefined
    }).catch(error => {
      this.error = 'STORAGE_WRITE_FAILED: 桥接记录写入失败'
      throw new Error(this.error, { cause: error })
    })
    this.writing = operation
    return operation
  }
}
