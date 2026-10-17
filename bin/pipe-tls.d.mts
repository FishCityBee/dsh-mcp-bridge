import type {ConnectionOptions, TLSSocket, TlsOptions} from 'node:tls'
export const PIPE_PROTOCOL: 'tls-pinned-v3'
export function createPipeIdentity(secret: string | Buffer, role: 'client' | 'server'): {
  options: ConnectionOptions & TlsOptions
  verifyPeer(socket: TLSSocket): boolean
}
