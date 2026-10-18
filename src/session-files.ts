/** Fail-closed filesystem boundary. Never trust ids or persisted absolute paths. */
import { lstat, readdir, realpath } from 'node:fs/promises'
import { refusePermanentDelete } from './deletion.ts'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export function validateSessionId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)) throw new Error('INVALID_SESSION_ID: 会话 ID 必须为合法单路径组件')
}
function child(root: string, path: string) {
  const rel = relative(root, path)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
async function info(path: string) {
  try { return await lstat(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}
export class SessionFiles {
  constructor(private readonly home: string) {}
  async safe(parts: string[]): Promise<string | undefined> {
    const root = await realpath(this.home)
    let path = root
    for (const part of parts) {
      if (!part || part === '.' || part === '..' || /[\\/:\0]/.test(part)) throw new Error('UNSAFE_SESSION_PATH')
      path = join(path, part)
      const entry = await info(path)
      if (!entry) return undefined
      if (entry.isSymbolicLink()) throw new Error('UNSAFE_SESSION_PATH: symbolic link / junction')
      const actual = await realpath(path)
      if (!child(root, actual) || relative(resolve(path), actual) !== '') throw new Error('UNSAFE_SESSION_PATH: 路径越界')
    }
    return path
  }
  async directory(id: string): Promise<string | undefined> {
    validateSessionId(id)
    const root = await this.safe(['sessions'])
    if (!root) return undefined
    const matches: string[] = []
    for (const bucket of await readdir(root)) {
      const parent = await this.safe(['sessions', bucket])
      if (!(parent && (await info(parent))?.isDirectory())) continue
      const path = await this.safe(['sessions', bucket, id])
      if (path && (await info(path))?.isDirectory()) matches.push(path)
    }
    if (matches.length > 1) throw new Error('AMBIGUOUS_SESSION: 多个存储分桶具有相同 ID')
    return matches[0]
  }
  async activity(id: string): Promise<{ updatedAt?: number; version: string }> {
    const directory = await this.directory(id)
    if (!directory) return { version: 'no-files' }
    const entries = (await readdir(directory)).flatMap(name => {
      const m = /^session\.v([1-9][0-9]*)\.jsonl(?:\.zstd)?$/.exec(name)
      return m ? [{ name, generation: Number(m[1]) }] : []
    })
    const latest = Math.max(...entries.map(e => e.generation))
    const current = entries.filter(e => e.generation === latest)
    // Ambiguous compression or an unrecognized log cannot justify automatic archiving.
    if (current.length !== 1) return { version: 'unknown-log' }
    const file = await this.safe(['sessions', relative(join(await realpath(this.home), 'sessions'), directory).split(sep)[0], id, current[0]!.name])
    const metadata = file ? await info(file) : undefined
    if (!metadata?.isFile()) return { version: 'unknown-log' }
    return { updatedAt: metadata.mtimeMs, version: `${current[0]!.name}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}` }
  }
  async remove(id: string): Promise<void> {
    validateSessionId(id)
    refusePermanentDelete()
  }
  async cache(id: string): Promise<string | undefined> {
    validateSessionId(id)
    return this.safe(['storages', 'session_projcache', 'sessions', `${id}.json`])
  }
}
