// Optional platform integration. No credentials, models, or existing sessions.
// DSH_DESKTOP_EXE points at an installed supported desktop build.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {fixture,sleep} from './harness.mjs'
const exe=process.env.DSH_DESKTOP_EXE
if(!exe)throw new Error('Set DSH_DESKTOP_EXE to the official desktop executable; this test is never a mock fallback.')
const runtime=process.env.DSH_DESKTOP_RUNTIME??join(dirname(exe),'resources','app.asar','dsh')
const temp=await mkdtemp(join(tmpdir(),'dmb-official-storage-'))
const modulePath=join(temp,'session-files.mjs')
await build({entryPoints:['src/session-files.ts'],outfile:modulePath,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
const {SessionFiles}=await import(pathToFileURL(modulePath))
async function worker(home,id,mode){
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',DSH_HOME:resolve(home)};delete env.DSH_MCP_BRIDGE_TOKEN
 const child=spawn(exe,['--expose-internals',fileURLToPath(new URL('./official-session-worker.mjs',import.meta.url)),runtime,resolve(home),id,mode],{env,windowsHide:true,stdio:['pipe','pipe','pipe']})
 let ticket=0,readyResolve,readyReject,stderr=''
 const pending=new Map(),ready=new Promise((r,j)=>{readyResolve=r;readyReject=j})
 child.stderr.on('data',b=>{stderr+=b.toString()})
 const closed=new Promise(r=>child.once('exit',r))
 child.on('error',e=>{readyReject(e);for(const p of pending.values())p.reject(e)})
 child.on('exit',()=>{const e=new Error('official worker exited: '+stderr.slice(0,800));readyReject(e);for(const p of pending.values())p.reject(e)})
 createInterface({input:child.stdout}).on('line',line=>{
  let msg;try{msg=JSON.parse(line)}catch{return}
  if(msg.ready)return readyResolve(msg)
  const p=pending.get(msg.ticket);if(!p)return
  pending.delete(msg.ticket);clearTimeout(p.timer);msg.error?p.reject(new Error(msg.error)):p.resolve(msg.value)
 })
 const readyTimer=setTimeout(()=>{readyReject(new Error('official worker ready timeout: '+stderr.slice(0,800)));child.kill()},10000)
 let metadata
 try{metadata=await ready}finally{clearTimeout(readyTimer)}
 const call=action=>new Promise((resolve,reject)=>{const key=++ticket,timer=setTimeout(()=>{pending.delete(key);reject(new Error('official worker timeout: '+action))},10000);pending.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify({ticket:key,action})+'\n')})
 return{call,pid:child.pid,metadata,async close(){
  if(child.exitCode!==null)return
  try{await call('stop');child.stdin.end();await Promise.race([closed,sleep(3000)])}finally{child.kill()}
 }}
}
let f,owner,observer
try{
 const id='session-official-foreign-owner'
 f=await fixture(async f=>{
  owner=await worker(f.home,id,'create');observer=await worker(f.home,id,'observe')
  console.log('RUNTIME '+JSON.stringify(owner.metadata))
  f.ctx.sessionPersistence.stat=()=>observer.call('stat');f.workspace.sessionIds.push(id);f.values.autoCleanupDays=7
  await mkdir(join(f.home,'mcp-bridge'),{recursive:true})
  await writeFile(join(f.home,'mcp-bridge','sessions.json'),JSON.stringify({[id]:{title:'isolated official fixture',createdAt:1}}))
  const version=(await new SessionFiles(f.home).activity(id)).version
  f.pending=JSON.stringify([{id,version}]);await writeFile(join(f.home,'mcp-bridge','pending-deletes.json'),f.pending)
 })
 assert.notEqual(owner.pid,observer.pid);assert.notEqual(owner.pid,process.pid);assert.equal(f.ctx.agents.get(id),undefined)
 const initial=await observer.call('stat')
 assert.deepEqual(await observer.call('try-write'),{opened:false,error:'SessionAlreadyOwnedError'})
 console.log('PASS official cross-process write lease rejects a second writer while stat remains readable')
 for(const action of ['archive','unarchive']){
  const p=await f.call('manage_sessions',{workspace:'ws',action})
  const r=await f.call('manage_sessions',{workspace:'ws',action,confirm:true,previewToken:p.body.previewToken})
  assert.equal(r.body.done,1)
  assert.deepEqual(await observer.call('try-write'),{opened:false,error:'SessionAlreadyOwnedError'})
 }
 console.log('PASS bridge archive/unarchive preserve the real external writer (registry UI is a fixture)')
 const files=new SessionFiles(f.home),directory=await files.directory(id),activity=await files.activity(id)
 const log=join(directory,activity.version.split(':')[0]),before=await readFile(log)
 const single=await f.call('delete_session',{sessionId:id,confirm:true});assert.equal(single.error,true);assert.match(single.body,/PERMANENT_DELETE_UNSUPPORTED/)
 const preview=await f.call('manage_sessions',{workspace:'ws',action:'delete'})
 const batch=await f.call('manage_sessions',{workspace:'ws',action:'delete',confirm:true,previewToken:preview.body.previewToken});assert.equal(batch.error,true);assert.match(batch.body,/PERMANENT_DELETE_UNSUPPORTED/)
 await f.ctx.settings.update('mcp-bridge',{command:JSON.stringify({id:'official-cleanup',at:Date.now(),action:'cleanup-now'})});await sleep(120)
 assert.match(JSON.parse(f.values.commandResult).error,/PERMANENT_DELETE_UNSUPPORTED/)
 await sleep(5100)
 assert.equal(await readFile(join(f.home,'mcp-bridge','pending-deletes.json'),'utf8'),f.pending)
 assert.deepEqual(await readFile(log),before)
 assert.ok(f.workspace.sessionIds.includes(id));assert.ok(!f.archived.includes(id))
 assert.deepEqual(await observer.call('try-write'),{opened:false,error:'SessionAlreadyOwnedError'})
 console.log('PASS manual, batch, automatic/mailbox and startup pending routes preserve official logs and ownership')
 await owner.call('close-writer');assert.equal((await observer.call('stat')).revision,initial.revision)
 await owner.call('open-writer');assert.equal((await observer.call('stat')).revision,initial.revision)
 // stat.eventCount is optional in the official interface. Read the log through
 // a real independent read handle to verify both appended events instead.
 assert.equal(await owner.call('append'),2);assert.equal(await observer.call('read-count'),2)
 await owner.call('close-writer');assert.deepEqual(await observer.call('try-write'),{opened:true})
 console.log('PASS owner churn leaves revision unchanged; retained writer can append, flush and release normally')
 console.log('OFFICIAL STORAGE 4 passed; real desktop JSONL/native Windows lease; no real user data or model request')
}finally{await f?.close();await observer?.close();await owner?.close()}
