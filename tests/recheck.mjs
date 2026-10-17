// Follow-up review regressions. All disk mutations stay inside new temporary homes.
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,utimes,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {fixture,sleep} from './harness.mjs'
const root=await mkdtemp(join(tmpdir(),'dmb-recheck-'))
async function load(name){const file=join(root,name+'.mjs');await build({entryPoints:['src/'+name+'.ts'],outfile:file,bundle:true,platform:'node',format:'esm',logLevel:'silent'});return import(pathToFileURL(file))}
const {TaskStore}=await load('tasks'),{SessionFiles}=await load('session-files'),{samePath}=await load('paths')
let count=0,failed=0
async function test(name,fn,seed){let f;try{f=await fixture(seed);await fn(f);console.log('PASS '+name);count++}catch(e){console.error('FAIL '+name+': '+e.message);failed++}finally{await f?.close()}}
await test('R1 manual and batch permanent deletion refuse an untracked stored session without side effects',async f=>{
 const id='session-foreign-writer',file=await f.sessionFile(id,{mcp:true})
 assert.equal(f.ctx.agents.get(id),undefined)
 const original=await readFile(file,'utf8')
 const single=await f.call('delete_session',{sessionId:id,confirm:true})
 assert.equal(single.error,true);assert.match(single.body,/PERMANENT_DELETE_UNSUPPORTED/)
 assert.equal(await readFile(file,'utf8'),original);assert.ok(f.workspace.sessionIds.includes(id));assert.ok(!f.archived.includes(id))
 const preview=await f.call('manage_sessions',{workspace:'ws',action:'delete'})
 const batch=await f.call('manage_sessions',{workspace:'ws',action:'delete',confirm:true,previewToken:preview.body.previewToken})
 assert.equal(batch.error,true);assert.match(batch.body,/PERMANENT_DELETE_UNSUPPORTED/);assert.equal(await readFile(file,'utf8'),original)
})
await test('R1 automatic, mailbox and pending deletion stay disabled even while MCP is off',async f=>{
 f.values.autoCleanupDays=7
 await f.ctx.settings.update('mcp-bridge',{command:JSON.stringify({id:'recheck-cleanup',at:Date.now(),action:'cleanup-now'})})
 await sleep(150)
 const reply=JSON.parse(f.values.commandResult);assert.equal(reply.ok,false);assert.match(reply.error,/PERMANENT_DELETE_UNSUPPORTED/)
 await sleep(5100)
 assert.ok(await stat(f.pendingFile));assert.equal(await readFile(join(f.home,'mcp-bridge','pending-deletes.json'),'utf8'),f.pendingOriginal)
 const status=await f.call('harness_status');assert.equal(status.body.permanentDeletion.supported,false);assert.equal(status.body.automaticCleanupActive,false)
},async f=>{
 f.values.enabled=false;const id='session-pending-external',file=await f.sessionFile(id,{mcp:true}),old=new Date(Date.now()-30*86400000);await utimes(file,old,old)
 const files=new SessionFiles(f.home),pending=JSON.stringify([{id,version:(await files.activity(id)).version}]);f.pendingFile=file;f.pendingOriginal=pending
 await writeFile(join(f.home,'mcp-bridge','pending-deletes.json'),pending)
})
async function injectedSuffix(f,events){const create=f.ctx.agents.create;f.ctx.agents.create=async opts=>{const handle=await create(opts);handle.agent.followup=()=>{for(const e of events)handle.agent.session.append(e.type,e.data)};return handle};return f.call('run_task',{task:'official inbox cancellation suffix'})}
const drop={type:'agent/inbox/spliced',data:{index:0,removedCount:1,inserted:[],outcome:'canceled'}}
const completion=[{type:'turn/start',data:{turn:1}},{type:'step/start',data:{turn:1,step:1}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]
await test('R2 external cancellation before a turn consumes input is cancelled, not interrupted',async f=>{
 const r=await injectedSuffix(f,[drop]);assert.equal(r.body.status,'cancelled');assert.equal(r.body.termination.droppedUnrun,true);assert.equal(f.requests.length,0)
})
await test('R2 completed accounting followed by dropped unrun input is not done',async f=>{
 const r=await injectedSuffix(f,[...completion,drop]);assert.equal(r.body.status,'cancelled');assert.equal(r.body.termination.droppedUnrun,true);assert.equal(r.body.termination.consumedEnd.kind,'completed')
})
await test('R2 later consumed completion supersedes an earlier inbox cancellation',async f=>{
 const r=await injectedSuffix(f,[drop,...completion]);assert.equal(r.body.status,'done');assert.equal(r.body.termination.kind,'completed')
})
await test('R3 disk snapshot records acknowledged durability without prematurely changing live state',async()=>{
 const path=join(root,'durable.json'),store=new TaskStore(path),record={id:'terminal',task:'fixture',status:'done',createdAt:Date.now(),finishedAt:Date.now(),provider:'p',model:'a',progress:{},durability:'pending'}
 store.records.set(record.id,record);await store.flush();const disk=JSON.parse(await readFile(path,'utf8'))[0]
 assert.equal(disk.status,'done');assert.equal(disk.durability,'durable');assert.equal(record.durability,'pending')
 const cold=new TaskStore(path);await cold.load();assert.equal(cold.records.get(record.id).durability,'durable')
})
await test('R3 legacy at-rest pending markers become durable on cold load',async()=>{
 const path=join(root,'legacy.json');await writeFile(path,JSON.stringify([{id:'legacy',status:'done',durability:'pending',persistenceError:'previous process failure'}]))
 const cold=new TaskStore(path);await cold.load();assert.equal(cold.records.get('legacy').durability,'durable');assert.equal(cold.records.get('legacy').persistenceError,undefined)
})
await test('C1 POSIX path identity remains case sensitive and Windows spelling remains compatible',async()=>{
 assert.equal(samePath('/home/fixture/Sessions','/home/fixture/sessions','linux'),false)
 assert.equal(samePath('/home/fixture/Sessions','/home/fixture/sessions','darwin'),false)
 assert.equal(samePath('C:\\Users\\Fixture\\sessions','c:\\users\\fixture\\sessions','win32'),true)
 assert.equal(samePath('/home/fixture/sessions','/home/fixture/sessions-other','linux'),false)
})
console.log(`RECHECK ${count} passed, ${failed} failed`);process.exitCode=failed?1:0
