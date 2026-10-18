import { posix, win32 } from 'node:path'

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = platform === 'win32' ? win32 : posix
  const norm = (value: string) => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return norm(a) === norm(b)
}
