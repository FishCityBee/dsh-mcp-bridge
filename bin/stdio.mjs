#!/usr/bin/env node
// stdio <-> DeepSeek Harness pipe relay for MCP clients (Claude Code).
// Dependency-free: authenticates with the token file, then forwards bytes both ways.
//
// Env overrides: DSH_HOME, DSH_MCP_BRIDGE_PIPE, DSH_MCP_BRIDGE_TOKEN, DSH_MCP_BRIDGE_WAIT_MS.
import net from 'node:net'
import tls from 'node:tls'
import { createPipeIdentity } from './pipe-tls.mjs'
import { readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const waitMs = Number(process.env.DSH_MCP_BRIDGE_WAIT_MS ?? 15000)

function fail(message) {
  process.stderr.write(`[dsh-mcp-bridge] ${message}\n`)
  process.exit(1)
}

function pipePath() {
  if (process.env.DSH_MCP_BRIDGE_PIPE) return process.env.DSH_MCP_BRIDGE_PIPE
  try {
    const published = JSON.parse(readFileSync(join(home, 'mcp-bridge', 'endpoint.json'), 'utf8')).pipe
    if (typeof published === 'string' && published) return published
  } catch { /* fall back to the default name */ }
  if (process.platform === 'win32') {
    const user = (userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_')
    return `\\\\.\\pipe\\dsh-mcp-bridge-${user}`
  }
  return join(home, 'mcp-bridge', 'bridge.sock')
}

function token() {
  if (process.env.DSH_MCP_BRIDGE_TOKEN) return process.env.DSH_MCP_BRIDGE_TOKEN.trim()
  try {
    return readFileSync(join(home, 'harness-mcp-token.txt'), 'utf8').trim()
  } catch {
    return fail(`读不到 token 文件 ${join(home, 'harness-mcp-token.txt')}（Harness 启动并加载插件后会自动生成）`)
  }
}

function connect(path, deadline) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path)
    socket.once('connect', () => resolve(socket))
    socket.once('error', error => {
      socket.destroy()
      if (Date.now() >= deadline) return reject(error)
      setTimeout(() => connect(path, deadline).then(resolve, reject), 500)
    })
  })
}

const path = pipePath()
const secret = token()
let socket
try {
  socket = await connect(path, Date.now() + waitMs)
} catch (error) {
  fail(`连不上 DeepSeek Harness（${path}）：${error.code ?? error.message}。请确认 Harness 桌面端已启动且 dsh-mcp-bridge 插件已加载。`)
}

// Verify the token-derived server pin before forwarding any MCP bytes. Client
// and server signing keys are distinct; TLS proves possession of each key.
const raw = socket
const identity = createPipeIdentity(secret, 'client')
socket = tls.connect({
  ...identity.options, socket: raw,
})
let secure = false
const handshakeTimeout = setTimeout(() => fail('管道身份认证超时；请同时更新插件与中转脚本'), 10_000)
socket.once('secureConnect', () => {
  if (!identity.verifyPeer(socket)) return fail('PIPE_SERVER_AUTH_FAILED: 请同时更新插件和中转脚本')
  secure = true
  clearTimeout(handshakeTimeout)
  socket.pipe(process.stdout)
  process.stdin.pipe(socket)
})

socket.on('error', error => fail(`连接错误：${error.message}`))
socket.on('close', () => { clearTimeout(handshakeTimeout); process.exit(secure ? 0 : 1) })
process.stdin.on('end', () => socket.end())
