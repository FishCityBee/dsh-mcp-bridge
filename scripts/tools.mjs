// Prints the live bridge's tool list with run_task's input properties (quick "which build is loaded" check).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
const shim = fileURLToPath(new URL('../dist-package/bin/stdio.mjs', import.meta.url))
const client = new Client({ name: 'cli', version: '0' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [shim], stderr: 'inherit' }))
const { tools } = await client.listTools()
const run = tools.find(t => t.name === 'run_task')
console.log(tools.map(t => t.name).join(', '))
console.log('run_task params:', Object.keys(run?.inputSchema?.properties ?? {}).join(', '))
await client.close()
