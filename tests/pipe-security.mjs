// Real Windows named pipes (Unix sockets on other platforms), synthetic secrets only.
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import {createHash,randomBytes} from 'node:crypto'
import {spawn} from 'node:child_process'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const home=await mkdtemp(join(tmpdir(),'dmb-pipe-security-'))
const relay=fileURLToPath(new URL('../dist-package/bin/stdio.mjs',import.meta.url))
const secret='synthetic-'+randomBytes(24).toString('hex')
const pipe=n=>process.platform==='win32'?`\\\\.\\pipe\\dmb-pipe-security-${process.pid}-${n}`:join(home,n+'.sock')
async function run(server,path){await new Promise(r=>server.listen(path,r));const child=spawn(process.execPath,[relay],{env:{...process.env,DSH_HOME:home,DSH_MCP_BRIDGE_PIPE:path,DSH_MCP_BRIDGE_TOKEN:secret,DSH_MCP_BRIDGE_WAIT_MS:'1000'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');const timer=setTimeout(()=>child.kill(),2500);const code=await new Promise(r=>child.on('exit',r));clearTimeout(timer);await new Promise(r=>server.close(r));return {code,stdout,stderr}}
let captured=Buffer.alloc(0)
const imposter=net.createServer(socket=>{socket.once('data',chunk=>{captured=chunk;socket.end()});socket.on('error',()=>{})})
const first=await run(imposter,pipe('imposter'))
assert.ok(!captured.includes(Buffer.from(secret)),'relay leaked its long-term token to a preclaimed pipe')
assert.equal(first.stdout,'');assert.notEqual(first.code,0)
console.log('PASS preclaimed Windows pipe cannot capture the synthetic long-term secret or MCP data')
let authenticated=false
const context=tls.createSecureContext({minVersion:'TLSv1.2',maxVersion:'TLSv1.2',ciphers:'PSK-AES256-GCM-SHA384'})
const wrongKey=net.createServer(raw=>{const socket=new tls.TLSSocket(raw,{isServer:true,secureContext:context,pskCallback:()=>createHash('sha256').update('wrong-fixture-secret').digest()});socket.on('secure',()=>{authenticated=true;socket.end()});socket.on('error',()=>socket.destroy())})
const second=await run(wrongKey,pipe('wrong-key'))
assert.equal(authenticated,false);assert.equal(second.stdout,'');assert.notEqual(second.code,0)
console.log('PASS wrong-PSK server fails authentication before MCP forwarding')
