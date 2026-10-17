// Usage: node scripts/call.mjs <tool> [jsonArgs]  — calls the live Harness bridge through bin/stdio.mjs.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const shim = fileURLToPath(new URL('../dist-package/bin/stdio.mjs', import.meta.url))
const client = new Client({ name: 'cli', version: '0' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [shim], stderr: 'inherit' }))
const [tool, raw] = process.argv.slice(2)
const result = await client.callTool({ name: tool, arguments: raw ? JSON.parse(raw) : {} }, undefined, { timeout: 30 * 60 * 1000 })
console.log(result.isError ? 'ERROR:' : 'OK:', result.content?.[0]?.text)
await client.close()
