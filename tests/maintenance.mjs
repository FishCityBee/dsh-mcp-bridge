// Isolated maintenance and snapshot-receipt regressions. No real models or homes.
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,utimes,stat,symlink} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {WorkspaceRegistry} from '@deepseek-ai/dsh-workspace'
import {fixture,sleep,gate} from './harness.mjs'
const root=await mkdtemp(join(tmpdir(),'dmb-maintenance-'))
async function load(name){const file=join(root,name.replaceAll('/','-')+'.mjs');await build({entryPoints:['src/'+name+'.ts'],outfile:file,bundle:true,platform:'node',format:'esm',logLevel:'silent'});return import(pathToFileURL(file))}
const {TaskStore}=await load('tasks'),{SessionFiles}=await load('session-files'),{parseArchiveStatus}=await load('client/cleanup-status')
let count=0,failed=0,sequence=0
async function test(name,fn,seed){let f;try{f=seed?await fixture(seed):undefined;await fn(f);console.log('PASS '+name);count++}catch(e){console.error('FAIL '+name+': '+e.stack);failed++}finally{await f?.close()}}
async function oldSession(f,id,options={mcp:true}){const file=await f.sessionFile(id,options),old=new Date(Date.now()-30*86400000);await utimes(file,old,old);return file}
async function mailbox(f,command){const id='maintenance-'+(++sequence);await f.ctx.settings.update('mcp-bridge',{command:JSON.stringify({id,at:Date.now(),...command})});for(let n=0;n<300;n++){const reply=f.values.commandResult?JSON.parse(f.values.commandResult):{};if(reply.id===id)return reply;await sleep(10)}throw new Error('mailbox response timed out')}
await test('legacy days archive only old MCP logs; retain files, cache, ledger and workspace; unarchive restores',async f=>{
 const ledger=await readFile(join(f.home,'mcp-bridge','sessions.json'),'utf8'),log=await readFile(f.oldLog,'utf8'),cache=await readFile(f.cache,'utf8')
 const reply=await mailbox(f,{action:'cleanup-now'});assert.equal(reply.ok,true)
 assert.equal(reply.result.kind,'auto-archive');assert.equal(reply.result.archived,1);assert.equal(reply.result.deleted,0)
 assert.deepEqual(f.archiveCalls,[{id:'old-mcp',options:{stopActivity:false}}]);assert.equal(f.cancels,0)
 for(const [id,reason] of [['recent-mcp','recent-activity'],['live-mcp','live-or-busy'],['archived-mcp','already-archived'],['ambiguous-mcp','unknown-activity']])assert.ok(reply.result.skipped.some(s=>s.sessionId===id&&s.reason===reason),id)
 assert.ok(reply.result.failed.some(s=>s.sessionId==='refused-mcp'));assert.ok(!f.archived.includes('personal'))
 assert.equal(await readFile(f.oldLog,'utf8'),log);assert.equal(await readFile(f.cache,'utf8'),cache);assert.equal(await readFile(join(f.home,'mcp-bridge','sessions.json'),'utf8'),ledger);assert.ok(f.workspace.sessionIds.includes('old-mcp'))
 const undo=await f.call('manage_sessions',{workspace:'ws',action:'unarchive',confirm:true});assert.ok(undo.body.done>=1);assert.ok(!f.archived.includes('old-mcp'));assert.equal(await readFile(f.oldLog,'utf8'),log)
 const status=await f.call('harness_status');assert.equal(status.body.automaticArchive.action,'archive');assert.equal(status.body.automaticArchive.stopActivity,false)
},async f=>{
 f.values.autoCleanupDays=7;f.oldLog=await oldSession(f,'old-mcp');await oldSession(f,'personal',{mcp:false})
 await f.sessionFile('recent-mcp',{mcp:true});await oldSession(f,'live-mcp');await oldSession(f,'archived-mcp');f.archived.push('archived-mcp')
 const ambiguous=await oldSession(f,'ambiguous-mcp');await writeFile(ambiguous+'.zstd','fixture ambiguous log')
 await oldSession(f,'refused-mcp');f.archiveRefusals.add('refused-mcp');f.cancels=0;f.live.set('live-mcp',{cancel(){f.cancels++}})
 f.cache=join(f.home,'storages','session_projcache','sessions','old-mcp.json');await mkdir(dirname(f.cache),{recursive:true});await writeFile(f.cache,'{"fixture":"preserved"}')
 // Filter refusal calls separately so we can prove the only successful archive.
 const archive=f.ctx.workspaceRegistry.archiveSession;f.ctx.workspaceRegistry.archiveSession=async(id,options)=>{if(id==='refused-mcp')throw new Error('WORKSPACE_ACTIVE_SESSION');return archive(id,options)}
})
await test('zero disables manual-compatible and periodic maintenance; periodic path otherwise archives with non-stop option',async f=>{
 let reply=await mailbox(f,{action:'cleanup-now'});assert.equal(reply.ok,false);assert.match(reply.error,/AUTO_ARCHIVE_DISABLED/)
 assert.equal(typeof f.runScheduledArchive,'function');f.runScheduledArchive();await sleep(80);assert.equal(f.archiveCalls.length,0)
 f.values.autoCleanupDays=7;f.runScheduledArchive();for(let n=0;n<200&&!f.values.cleanupStatus;n++)await sleep(10)
 const result=JSON.parse(f.values.cleanupStatus);assert.equal(result.archived,1);assert.equal(result.deleted,0);assert.deepEqual(f.archiveCalls,[{id:'periodic-mcp',options:{stopActivity:false}}])
},async f=>{await oldSession(f,'periodic-mcp')})
await test('a newly live agent or activity change during asynchronous reads prevents automatic archive',async f=>{
 const original=f.ctx.sessionPersistence.stat;f.ctx.sessionPersistence.stat=async id=>{const result=await original(id);if(id==='became-live')f.live.set(id,{cancel(){}});if(id==='became-recent')await utimes(join(f.home,'sessions','fixture',id,'session.v4.jsonl'),new Date(),new Date());return result}
 const reply=await mailbox(f,{action:'cleanup-now'});assert.equal(reply.ok,true);assert.equal(reply.result.archived,0);assert.equal(f.archiveCalls.length,0)
 assert.ok(reply.result.skipped.some(s=>s.sessionId==='became-live'&&s.reason==='live-or-busy'));assert.ok(reply.result.skipped.some(s=>s.sessionId==='became-recent'&&s.reason==='recent-activity'))
},async f=>{f.values.autoCleanupDays=7;await oldSession(f,'became-live');await oldSession(f,'became-recent')})
await test('queued and running tasks cannot be automatically archived and cancellation remains explicit',async f=>{
 const started=await f.call('start_task',{task:'slow:400',sessionId:'busy-mcp'});assert.equal(started.error,false)
 const reply=await mailbox(f,{action:'cleanup-now'});assert.equal(reply.result.archived,0);assert.ok(reply.result.skipped.some(s=>s.sessionId==='busy-mcp'&&s.reason==='live-or-busy'))
 await f.call('cancel_task',{taskId:started.body.taskId});await f.call('wait_task',{taskId:started.body.taskId})
},async f=>{f.values.autoCleanupDays=7;await oldSession(f,'busy-mcp')})
await test('permanent deletion always refuses valid, expired and absent tokens, legacy mailbox and low-level remove',async f=>{
 const before=await readFile(f.log,'utf8'),ledger=await readFile(join(f.home,'mcp-bridge','sessions.json'),'utf8'),membership=[...f.workspace.sessionIds]
 const preview=await f.call('manage_sessions',{workspace:'ws',action:'delete'});assert.equal(preview.body.supported,false)
 for(const token of [undefined,'expired-fixture',preview.body.previewToken]){const r=await f.call('manage_sessions',{workspace:'ws',action:'delete',confirm:true,...(token?{previewToken:token}:{})});assert.equal(r.error,true);assert.match(r.body,/PERMANENT_DELETE_UNSUPPORTED/)}
 const single=await f.call('delete_session',{sessionId:'delete-refused',confirm:true});assert.match(single.body,/PERMANENT_DELETE_UNSUPPORTED/)
 for(const command of [{action:'delete-session',sessionId:'delete-refused'},{action:'manage-sessions',workspace:'ws',manageAction:'delete',confirm:true}]){const reply=await mailbox(f,command);assert.equal(reply.ok,false);assert.match(reply.error,/PERMANENT_DELETE_UNSUPPORTED/)}
 await assert.rejects(new SessionFiles(f.home).remove('delete-refused'),/PERMANENT_DELETE_UNSUPPORTED/)
 assert.equal(await readFile(f.log,'utf8'),before);assert.equal(await readFile(join(f.home,'mcp-bridge','sessions.json'),'utf8'),ledger);assert.deepEqual(f.workspace.sessionIds,membership);assert.equal(f.disposed,0);assert.equal(f.archived.length,0)
},async f=>{f.log=await oldSession(f,'delete-refused');f.disposed=0;f.live.set('delete-refused',{cancel(){f.disposed++}})})
for(const enabled of [false,true])for(const days of [0,7])await test(`pending data stays byte-for-byte after startup delay (MCP ${enabled}, archive ${days})`,async f=>{
 await sleep(5100);assert.equal(await readFile(f.pendingPath,'utf8'),f.pendingOriginal);assert.ok(await stat(f.log))
 const status=await f.call('harness_status');assert.equal(status.body.permanentDeletion.pending.processing,false);assert.equal(status.body.permanentDeletion.pending.count,3)
},async f=>{f.values.enabled=enabled;f.values.autoCleanupDays=days;f.log=await oldSession(f,'pending-kept');f.pendingPath=join(f.home,'mcp-bridge','pending-deletes.json');f.pendingOriginal='[ {"id":"pending-kept"}, {"directory":"legacy-relative-path"}, null ]\n';await writeFile(f.pendingPath,f.pendingOriginal)})
for(const mode of ['malformed','non-array','unreadable'])await test(`pending ${mode} is reported and never overwritten`,async f=>{
 const status=await f.call('harness_status');assert.equal(status.body.permanentDeletion.pending.state,'unreadable');assert.equal(status.body.permanentDeletion.pending.count,null)
 const reply=await mailbox(f,{action:'cleanup-now'});assert.equal(reply.ok,true);assert.equal(reply.result.pendingDeletes.state,'unreadable')
 if(mode==='unreadable')assert.ok((await stat(f.pendingPath)).isDirectory());else assert.equal(await readFile(f.pendingPath,'utf8'),f.pendingOriginal)
},async f=>{f.values.autoCleanupDays=7;await oldSession(f,'pending-errors');f.pendingPath=join(f.home,'mcp-bridge','pending-deletes.json');f.pendingOriginal=mode==='malformed'?'{broken':'{"legacy":true}';if(mode==='unreadable')await mkdir(f.pendingPath);else await writeFile(f.pendingPath,f.pendingOriginal)})
await test('case-distinct real storage roots fail closed without confusing workspace path matching',async f=>{
 const alternate=join(f.home,'Sessions');await mkdir(alternate,{recursive:true});const [a,b]=await Promise.all([stat(alternate,{bigint:true}),stat(join(f.home,'sessions'),{bigint:true})])
 if(a.dev===b.dev&&a.ino===b.ino){console.log('SKIP case-distinct root assertion: filesystem aliases Sessions and sessions');return}
 f.ctx.sessionPersistence.root=alternate
 const preview=await f.call('delete_session',{sessionId:'case-mcp',confirm:false});assert.equal(preview.error,true);assert.match(preview.body,/UNSUPPORTED_SESSION_STORAGE/)
 const result=await mailbox(f,{action:'cleanup-now'});assert.equal(result.result.archived,0);assert.equal(result.result.failed.length,1);assert.equal(f.archiveCalls.length,0)
},async f=>{f.values.autoCleanupDays=7;await oldSession(f,'case-mcp')})
await test('archive retains session path and projection symlink protection',async f=>{
 const result=await mailbox(f,{action:'cleanup-now'});assert.equal(result.result.archived,0);assert.equal(result.result.failed.length,1);assert.equal(f.archiveCalls.length,0);assert.equal(await readFile(join(f.home,'outside','marker'),'utf8'),'keep')
},async f=>{f.values.autoCleanupDays=7;await oldSession(f,'link-mcp');const outside=join(f.home,'outside');await mkdir(outside);await writeFile(join(outside,'marker'),'keep');await mkdir(join(f.home,'storages','session_projcache'),{recursive:true});await symlink(outside,join(f.home,'storages','session_projcache','sessions'),process.platform==='win32'?'junction':'dir')})
await test('official archive implementation checks reported activity without requesting stops and supports unarchive',async()=>{
 const registry=Object.create(WorkspaceRegistry.prototype);let active=true,stops=0,writes=0,checks=0
 registry.state={workspaceIds:[],archivedSessionIds:[],pinnedSessionIds:['official-fixture']};registry.operationTail=Promise.resolve()
 registry.global={async set(){writes++}}
 Object.defineProperty(registry,'ctx',{value:{get:name=>name==='sessions'?{get:()=>({})}:undefined,async waterfall(name){assert.equal(name,'workspace/session-activity');checks++;return active?[{kind:'fixture',label:'active fixture'}]:[]},async parallel(){stops++}}})
 await assert.rejects(registry.archiveSession('official-fixture',{stopActivity:false}),e=>e.name==='WorkspaceActiveSessionError');assert.equal(writes,0);assert.equal(stops,0)
 active=false;await registry.archiveSession('official-fixture',{stopActivity:false});assert.deepEqual(registry.archivedSessionIds,['official-fixture']);assert.equal(stops,0);assert.equal(checks,2);assert.equal(writes,1)
 await registry.unarchiveSession('official-fixture');assert.deepEqual(registry.archivedSessionIds,[]);assert.equal(writes,2)
})
const task=()=>({id:'receipt',status:'running',task:'fixture',createdAt:Date.now(),provider:'p',model:'a',progress:{steps:0,toolCalls:0,lastActivityAt:Date.now()}})
function controlled(){const store=new TaskStore(join(root,'controlled-'+(++sequence)+'.json')),writes=[];store.writer={write(value){const g=gate();writes.push({value:structuredClone(value),...g});return g.promise}};const record=task();store.records.set(record.id,record);return{store,record,writes}}
await test('old success cannot mark a newer cancellation durable; failure and retry report their own receipt',async()=>{
 const {store,record,writes}=controlled();const a=store.flush();record.status='cancelled';const b=store.flush();assert.equal(record.durability,'pending');assert.equal(writes[0].value[0].status,'running')
 writes[0].resolve();await a;assert.equal(record.durability,'pending');assert.equal(record.status,'cancelled')
 writes[1].resolve(Promise.reject(new Error('STORAGE_WRITE_FAILED')));await assert.rejects(b,/STORAGE_WRITE_FAILED/);assert.equal(record.durability,'degraded');assert.equal(record.persistenceError,'STORAGE_WRITE_FAILED')
 const retry=store.flush();writes[2].resolve();await retry;assert.equal(record.durability,'durable');assert.equal(record.persistenceError,undefined);assert.equal(writes[2].value[0].status,'cancelled')
})
await test('old failure cannot overwrite a newer pending write or successful receipt',async()=>{
 const {store,record,writes}=controlled();const a=store.flush();record.status='done';const b=store.flush();writes[0].resolve(Promise.reject(new Error('old failure')));await assert.rejects(a,/old failure/);assert.equal(record.durability,'pending');assert.equal(record.persistenceError,undefined);writes[1].resolve();await b;assert.equal(record.durability,'durable')
})
await test('progress mutation invalidates old receipt before the coalesced save starts',async()=>{
 const {store,record,writes}=controlled();const a=store.flush();record.progress.steps=2;store.save(record);writes[0].resolve();await a;assert.equal(record.durability,'pending');const b=store.flush();writes[1].resolve();await b;assert.equal(record.durability,'durable');assert.equal(writes[1].value[0].progress.steps,2)
})
await test('an unscheduled nested mutation cannot inherit an old snapshot receipt',async()=>{
 const {store,record,writes}=controlled();const a=store.flush();record.progress.steps=3;writes[0].resolve();await a;assert.equal(record.durability,'pending')
})
await test('UI archive receipts never reinterpret historical deletion counts or malformed JSON',async()=>{
 const valid={kind:'auto-archive',schemaVersion:1,at:Date.now(),archived:2,deleted:0,skipped:[],failed:[]}
 assert.equal(parseArchiveStatus(JSON.stringify(valid)).archived,2)
 for(const value of ['', '{', '{}', 'null', JSON.stringify({at:Date.now(),deleted:4,failed:[]}),JSON.stringify({...valid,failed:undefined}),JSON.stringify({...valid,deleted:2}),JSON.stringify({...valid,pendingDeletes:{state:'retained',count:'oops'}})])assert.equal(parseArchiveStatus(value),undefined)
})
console.log(`MAINTENANCE ${count} passed, ${failed} failed`);process.exitCode=failed?1:0
