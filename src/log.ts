/** Mirror the plugin logger into $DSH_HOME/mcp-bridge/bridge.log; the desktop host keeps no log file of its own. */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BridgeLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const MAX_BYTES = 1024 * 1024

export function createFileLogger(base: BridgeLogger, path: string): BridgeLogger {
  let chain: Promise<void> = mkdir(dirname(path), { recursive: true }).then(() => undefined, () => undefined)
  const write = (level: string, message: string) => {
    const line = `${new Date().toISOString()} ${level} ${message}\n`
    chain = chain.then(async () => {
      const size = (await stat(path).catch(() => undefined))?.size ?? 0
      if (size > MAX_BYTES) await rename(path, `${path}.1`).catch(() => undefined)
      await appendFile(path, line)
    }).catch(() => undefined)
  }
  return {
    info(message) { base.info(message); write('INFO ', message) },
    warn(message) { base.warn(message); write('WARN ', message) },
    error(message) { base.error(message); write('ERROR', message) },
  }
}
