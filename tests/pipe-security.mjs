// Real Windows named pipes (Unix sockets on other platforms), synthetic secrets only.
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import {randomBytes, X509Certificate} from 'node:crypto'
import {createPipeIdentity} from '../dist-package/bin/pipe-tls.mjs'
import {spawn} from 'node:child_process'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const home=await mkdtemp(join(tmpdir(),'dmb-pipe-security-'))
const relay=fileURLToPath(new URL('../dist-package/bin/stdio.mjs',import.meta.url))
const secret='synthetic-'+randomBytes(24).toString('hex')
const pipe=n=>process.platform==='win32'?`\\\\.\\pipe\\dmb-pipe-security-${process.pid}-${n}`:join(home,n+'.sock')
const request='{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'
async function run(server,path){await new Promise(r=>server.listen(path,r));const child=spawn(process.env.DSH_TEST_RELAY_NODE||process.execPath,[relay],{env:{...process.env,DSH_HOME:home,DSH_MCP_BRIDGE_PIPE:path,DSH_MCP_BRIDGE_TOKEN:secret,DSH_MCP_BRIDGE_WAIT_MS:'1000'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.stdin.write(request);const timer=setTimeout(()=>child.kill(),5000);const code=await new Promise(r=>child.on('exit',r));clearTimeout(timer);await new Promise(r=>server.close(r));return {code,stdout,stderr}}
let captured=Buffer.alloc(0)
const imposter=net.createServer(socket=>{socket.once('data',chunk=>{captured=chunk;socket.end()});socket.on('error',()=>{})})
const first=await run(imposter,pipe('imposter'))
assert.ok(!captured.includes(Buffer.from(secret)),'relay leaked its long-term token to a preclaimed pipe')
assert.ok(!captured.includes(Buffer.from(request)),'relay forwarded MCP data before authenticating the server')
assert.equal(first.stdout,'');assert.notEqual(first.code,0)
console.log('PASS preclaimed Windows pipe cannot capture the synthetic long-term secret or MCP data')
let authenticated=false
// Keep the original wrong-key rejection regression. Only its fixture changes:
// the production transport now pins signing keys instead of using TLS-PSK.
const wrongIdentity=createPipeIdentity('wrong-fixture-secret','server')
let unauthorizedBytes=0
const wrongKey=tls.createServer(wrongIdentity.options,socket=>{authenticated=wrongIdentity.verifyPeer(socket);socket.on('data',d=>unauthorizedBytes+=d.length);socket.on('error',()=>{});socket.destroy()})
wrongKey.on('tlsClientError',(_error,socket)=>socket.destroy())
const second=await run(wrongKey,pipe('wrong-key'))
assert.equal(authenticated,false);assert.equal(second.stdout,'');assert.notEqual(second.code,0)
assert.equal(unauthorizedBytes,0);assert.ok(!second.stderr.includes(secret))
console.log('PASS wrong-key server fails authentication before MCP forwarding')

const identity=createPipeIdentity(secret,'server')
const clientIdentity=createPipeIdentity(secret,'client')
for(const own of [identity,clientIdentity]) {const cert=new X509Certificate(own.options.cert);assert.ok(cert.verify(cert.publicKey));tls.createSecureContext(own.options)}
assert.notEqual(new X509Certificate(identity.options.cert).publicKey.export({type:'spki',format:'pem'}),new X509Certificate(clientIdentity.options.cert).publicKey.export({type:'spki',format:'pem'}))
console.log(`PASS role-separated certificate identities load in ${process.versions.electron?'Electron '+process.versions.electron:'Node '+process.versions.node}`)

let received='',protocol
const valid=tls.createServer(identity.options,socket=>{socket.on('error',()=>{});if(!identity.verifyPeer(socket))return socket.destroy();protocol=socket.getProtocol();socket.on('data',d=>{received+=d;socket.end('MCP_FIXTURE_OK\n')})})
valid.on('tlsClientError',(_error,socket)=>socket.destroy())
const third=await run(valid,pipe('valid'))
assert.equal(protocol,'TLSv1.3');assert.equal(received,request);assert.equal(third.stdout,'MCP_FIXTURE_OK\n');assert.equal(third.code,0)
console.log('PASS authenticated TLS 1.3 forwards MCP bytes with the actual relay')

async function rejectsClient(label,options) {
 let accepted=false,bytes=0
 const server=tls.createServer(identity.options,socket=>{socket.on('error',()=>{});if(!identity.verifyPeer(socket))return socket.destroy();accepted=true;socket.on('data',d=>bytes+=d.length)})
 server.on('tlsClientError',(_error,socket)=>socket.destroy())
 const path=pipe(label)
 await new Promise(r=>server.listen(path,r))
 const raw=net.connect(path)
 const socket=tls.connect({...options,socket:raw,rejectUnauthorized:false})
 socket.on('error',()=>{})
 socket.on('secureConnect',()=>socket.write(request))
 const timeout=setTimeout(()=>socket.destroy(),2000)
 await new Promise(r=>socket.on('close',r));clearTimeout(timeout)
 await new Promise(r=>server.close(r))
 assert.equal(accepted,false);assert.equal(bytes,0)
 console.log('PASS '+label+' rejected before MCP admission')
}
await rejectsClient('wrong-client-key',createPipeIdentity('wrong-fixture-secret','client').options)
await rejectsClient('missing-client-certificate',{minVersion:'TLSv1.3'})
await rejectsClient('server-key-reflection',identity.options)
await rejectsClient('TLS-1.2-downgrade',{...clientIdentity.options,minVersion:'TLSv1.2',maxVersion:'TLSv1.2'})
