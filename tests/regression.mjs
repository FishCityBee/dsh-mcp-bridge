import assert from 'node:assert/strict'
import {appendFile,mkdir,readFile,rm,stat,symlink,utimes,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fixture,gate,sleep} from './harness.mjs'
let failures=0,passed=0
let caseIndex=0
const test=async(name,fn,seed)=>{if(++caseIndex>Number(process.env.DMB_REGRESSION_CASE_LIMIT??Infinity))return;let f;try{f=await fixture(seed);await fn(f);passed++;console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+': '+e.message)}finally{await f?.close()}}
await test('new MCP sessions apply official permission presets including sandbox and approval',async f=>{
 for(const preset of ['read-only','workspace-write','danger-full-access']){
  f.values.newSessionPermission=preset
  const r=await f.call('run_task',{task:'permission preset '+preset})
  assert.equal(r.body.status,'done');assert.equal(r.body.approval.preset,preset);assert.equal(r.body.approval.sandbox,preset)
  assert.equal(r.body.approval.mode,preset==='danger-full-access'?'never':'ask');assert.equal(r.body.approval.source,'toolbar-new-session-preset')
 }
})
await test('changing new-session permissions preserves an existing session and human tightening',async f=>{
 f.values.newSessionPermission='danger-full-access';const first=await f.call('run_task',{task:'new full access'}),id=first.body.sessionId
 f.ctx.permissionPresets.set(f.live.get(id).session,'read-only')
 const continued=await f.call('run_task',{task:'continue with human permission',sessionId:id})
 assert.equal(continued.body.approval.preset,'read-only');assert.equal(continued.body.approval.sandbox,'read-only');assert.equal(continued.body.approval.mode,'ask');assert.equal(continued.body.approval.source,'stored-session')
})
await test('cold resume preserves stored permission instead of the new-session default',async f=>{
 f.values.newSessionPermission='danger-full-access'
 const r=await f.call('run_task',{task:'resume read only',sessionId:'session-cold-permission'})
 assert.equal(r.body.status,'done');assert.equal(r.body.approval.preset,'read-only');assert.equal(r.body.approval.mode,'ask')
},async f=>{
 await f.sessionFile('session-cold-permission',{mcp:true})
 f.saved.set('session-cold-permission',{events:[{type:'permission/preset',data:{preset:'read-only'}},{type:'sandbox/mode',data:{mode:'read-only'}},{type:'approval/policy',data:{policy:'ask'}}],messages:[]})
})
await test('unavailable permission preset fails before a model request',async f=>{
 f.values.newSessionPermission='read-only';delete f.ctx.permissionPresets.presets['read-only']
 const r=await f.call('run_task',{task:'missing preset'});assert.equal(r.body.status,'failed');assert.match(r.body.error,/PERMISSION_PRESET_UNAVAILABLE/);assert.equal(f.requests.length,0)
})
await test('permission changes during creation reject stale setup before sending',async f=>{
 f.values.newSessionPermission='read-only';f.createGate=gate();const t=await f.call('start_task',{task:'permission changed during create'});await sleep(20);f.values.newSessionPermission='danger-full-access';f.createGate.resolve()
 const r=await f.call('wait_task',{taskId:t.body.taskId});assert.equal(r.body.status,'failed');assert.match(r.body.error,/CONFIG_CONFLICT/);assert.equal(f.requests.length,0)
})
await test('Harness future-session default is honored without changing the global default',async f=>{
 f.defaultPermission='read-only'
 const inherited=await f.call('run_task',{task:'inherit Harness future-session default'})
 assert.equal(inherited.body.approval.preset,'read-only');assert.equal(inherited.body.approval.source,'harness-new-session-default')
 f.values.newSessionPermission='danger-full-access';const explicit=await f.call('run_task',{task:'MCP only explicit full access'})
 assert.equal(explicit.body.approval.preset,'danger-full-access');assert.equal(f.ctx.permissionPresets.defaultPreset,'read-only')
})
await test('explicit new-session preset takes precedence over legacy approval-only configuration',async f=>{
 f.values.approvalMode='never'
 const legacy=await f.call('run_task',{task:'legacy deny approvals'});assert.equal(legacy.body.approval.mode,'never');assert.equal(legacy.body.approval.sandbox,'workspace-write')
 f.values.newSessionPermission='workspace-write'
 const current=await f.call('run_task',{task:'explicit complete permission preset'});assert.equal(current.body.approval.preset,'workspace-write');assert.equal(current.body.approval.mode,'ask')
})
await test('changed Harness default during creation cannot silently start with stale permissions',async f=>{
 f.createGate=gate();const t=await f.call('start_task',{task:'default changed during create'});await sleep(20);f.defaultPermission='read-only';f.createGate.resolve()
 const r=await f.call('wait_task',{taskId:t.body.taskId});assert.equal(r.body.status,'failed');assert.match(r.body.error,/CONFIG_CONFLICT/);assert.equal(f.requests.length,0)
})
await test('provider defaults are constraints until override is explicitly enabled',async f=>{
 f.values.mode='provider';let r=await f.call('run_task',{task:'no fee',model:'b'});assert.equal(r.error,true);assert.match(String(r.body),/CONFIG_CONFLICT/);assert.equal(f.requests.length,0)
 f.values.providerAllowOverrides=true;r=await f.call('run_task',{task:'explicit',model:'b',reasoningEffort:'high'});assert.equal(r.body.status,'done');assert.deepEqual(f.requests.at(-1).model,'b')
})
await test('owned continuation changes the actual persistent-header request',async f=>{
 let r=await f.call('run_task',{task:'initial'});const id=r.body.sessionId
 f.values.singleProvider='q';f.values.singleModel='c';f.values.singleEffort='low'
 r=await f.call('run_task',{task:'continued',sessionId:id});assert.equal(r.body.status,'done');assert.equal(f.requests.at(-1).provider,'q');assert.equal(f.requests.at(-1).model,'c');assert.equal(r.body.effectiveSelection.provider,'q')
})
await test('unowned live agents are not modified or disposed',async f=>{
 const id='session-external';const a=f.agent(id,{provider:'q',model:'c'});f.live.set(id,a)
 const r=await f.call('run_task',{task:'unowned',sessionId:id});assert.ok(r.error||r.body.status==='failed');assert.equal(f.requests.length,0);assert.equal(f.live.get(id),a)
})
await test('cancelled task waiting for the same session never sends',async f=>{
 const first=await f.call('run_task',{task:'initial'}),id=first.body.sessionId
 const a=await f.call('start_task',{task:'slow:180',sessionId:id});await sleep(25)
 const b=await f.call('start_task',{task:'must-not-send',sessionId:id});await sleep(25)
 await f.call('cancel_task',{taskId:b.body.taskId});await f.call('wait_task',{taskId:a.body.taskId});await sleep(50)
 const end=await f.call('wait_task',{taskId:b.body.taskId});assert.equal(end.body.status,'cancelled');assert.ok(!f.sent.some(s=>s.text==='must-not-send'))
})
await test('creation cancellation persists through async setup',async f=>{
 f.createGate=gate();const r=await f.call('start_task',{task:'no-create-prompt'});await f.call('cancel_task',{taskId:r.body.taskId});f.createGate.resolve();await sleep(60);assert.equal(f.requests.length,0);assert.equal((await f.call('get_task',{taskId:r.body.taskId})).body.status,'cancelled')
})
await test('queued tasks re-resolve current settings before dispatch',async f=>{
 f.config.maxConcurrentTasks=1;const a=await f.call('start_task',{task:'slow:130'});await sleep(25);const b=await f.call('start_task',{task:'queued'});assert.equal(b.body.effectiveSelection??null,null)
 f.values.singleProvider='q';f.values.singleModel='c';f.values.singleEffort='low';await f.call('wait_task',{taskId:a.body.taskId});const r=await f.call('wait_task',{taskId:b.body.taskId});assert.equal(r.body.status,'done');assert.equal(f.requests.find(x=>x.text==='queued').provider,'q');assert.equal(f.requests.find(x=>x.text==='slow:130').provider,'p')
})
await test('idle after a fatal error is failed; recoverable errors still succeed',async f=>{
 let r=await f.call('run_task',{task:'fatal'});assert.equal(r.body.status,'failed');assert.equal(r.body.termination.error.code,'AUTH')
 r=await f.call('run_task',{task:'retry'});assert.equal(r.body.status,'done')
 r=await f.call('run_task',{task:'external-stop'});assert.equal(r.body.status,'cancelled')
})
await test('deletion rejects traversal and preserves an outside marker',async f=>{
 await mkdir(join(f.home,'sessions','fixture'),{recursive:true})
 const outside=join(f.home,'outside');await mkdir(outside);await writeFile(join(outside,'marker'),'keep')
 for(const id of ['../../outside','..\\..\\outside',outside,'session/a','C:\\outside','CON']){const r=await f.call('delete_session',{sessionId:id,confirm:true});assert.equal(r.error,true)}
 assert.equal(await readFile(join(outside,'marker'),'utf8'),'keep')
})
await test('junction and projection-cache escape are refused',async f=>{
 const id='session-junction',outside=join(f.home,'outside');await mkdir(outside);await writeFile(join(outside,'marker'),'keep');await mkdir(join(f.home,'sessions','fixture'),{recursive:true});await symlink(outside,join(f.home,'sessions','fixture',id),process.platform==='win32'?'junction':'dir');f.workspace.sessionIds.push(id)
 const r=await f.call('delete_session',{sessionId:id,confirm:true});assert.equal(r.error,true);assert.equal(await readFile(join(outside,'marker'),'utf8'),'keep')
})
await test('default batch scope is MCP only and confirmation binds IDs',async f=>{
 await f.call('run_task',{task:'create managed'});await f.sessionFile('session-personal')
 const p=await f.call('manage_sessions',{workspace:'ws',action:'delete'});assert.equal(p.body.count,1);assert.ok(p.body.previewToken)
 await f.call('run_task',{task:'created after preview'})
 const r=await f.call('manage_sessions',{workspace:'ws',action:'delete',confirm:true,previewToken:p.body.previewToken});assert.equal(r.body.done,1);assert.ok(f.workspace.sessionIds.includes('session-personal'));assert.equal(f.workspace.sessionIds.length,2)
})
await test('old directory with freshly appended log is not expired',async f=>{
 const t=await f.call('run_task',{task:'create active history'}),id=t.body.sessionId;await f.live.get(id).whenIdle();f.live.delete(id)
 const file=join(f.home,'sessions','fixture',id,'session.v4.jsonl'),old=new Date(Date.now()-20*86400000);await utimes(join(file,'..'),old,old);await appendFile(file,'{}\n')
 const r=await f.call('manage_sessions',{workspace:'ws',action:'delete',olderThanDays:7});assert.equal(r.body.count,0)
})
await test('single-mode explicit provider and effort conflicts dispatch nothing',async f=>{
 for(const args of [{provider:'q'},{reasoningEffort:'low'},{model:'b'}]){const r=await f.call('run_task',{task:'conflict',...args});assert.equal(r.error,true);assert.match(r.body,/CONFIG_CONFLICT/)}assert.equal(f.requests.length,0)
})
await test('settings changed during create fail before a request',async f=>{
 f.createGate=gate();const t=await f.call('start_task',{task:'create-change'});await sleep(20);f.values.singleModel='b';f.createGate.resolve();const r=await f.call('wait_task',{taskId:t.body.taskId});assert.equal(r.body.status,'failed');assert.match(r.body.error,/CONFIG_CONFLICT/);assert.equal(r.body.effectiveSelection,null);assert.equal(f.requests.length,0)
})
await test('queued explicit selection conflicting with new config is refused',async f=>{
 f.config.maxConcurrentTasks=1;const a=await f.call('start_task',{task:'slow:120'});await sleep(25);const b=await f.call('start_task',{task:'queued-explicit',model:'a'});f.values.singleModel='b';await f.call('wait_task',{taskId:a.body.taskId});const r=await f.call('wait_task',{taskId:b.body.taskId});assert.equal(r.body.status,'failed');assert.match(r.body.error,/CONFIG_CONFLICT/);assert.ok(!f.requests.some(x=>x.text==='queued-explicit'))
})
await test('disk resume applies actual routing and the current managed approval mode',async f=>{
 const first=await f.call('run_task',{task:'initial'}),id=first.body.sessionId;f.live.delete(id)
 // Eviction by the bridge happens at eight idle handles. Exercise the actual resume branch.
 for(let i=0;i<9;i++)await f.call('run_task',{task:'evict '+i})
 f.values.singleModel='b';f.values.approvalMode='never';const r=await f.call('run_task',{task:'approval resumed',sessionId:id});assert.equal(r.body.status,'done');assert.equal(f.requests.at(-1).model,'b');assert.equal(r.body.approval.mode,'never');assert.equal(r.body.approvalDiagnostics.at(-1).outcome,'rejected')
})
await test('resume cancellation never sends its prompt',async f=>{
 const id='session-cold';f.resumeGate=gate();const t=await f.call('start_task',{task:'resume-cancel',sessionId:id});await sleep(15);await f.call('cancel_task',{taskId:t.body.taskId});f.resumeGate.resolve();const r=await f.call('wait_task',{taskId:t.body.taskId});assert.equal(r.body.status,'cancelled');assert.equal(f.requests.length,0)
},async f=>{await f.sessionFile('session-cold',{mcp:true})})
await test('resume auto-wakes are gated before its Promise resolves',async f=>{
 const original=f.ctx.agents.resume.bind(f.ctx.agents),returnGate=gate(),started=gate()
 f.ctx.agents.resume=async options=>{const handle=await original(options);handle.agent.followup({content:[{type:'text',text:'persisted inbox auto-wake'}]});started.resolve();await returnGate.promise;return handle}
 const t=await f.call('start_task',{task:'new resume prompt',sessionId:'session-cold'});await started.promise;await sleep(20);assert.equal(f.requests.length,0);await f.call('cancel_task',{taskId:t.body.taskId});returnGate.resolve();const r=await f.call('wait_task',{taskId:t.body.taskId});assert.equal(r.body.status,'cancelled');assert.equal(f.requests.length,0);assert.ok(!f.sent.some(x=>x.text==='new resume prompt'))
},async f=>{await f.sessionFile('session-cold',{mcp:true})})
await test('running cancellation and approval cancellation remain cancelled',async f=>{
 f.answer=()=>new Promise(()=>{});const t=await f.call('start_task',{task:'approval pending'});await sleep(30);await f.call('cancel_task',{taskId:t.body.taskId});const r=await f.call('wait_task',{taskId:t.body.taskId});assert.equal(r.body.status,'cancelled');assert.equal(r.body.termination.kind,'aborted');assert.equal(r.body.approvalDiagnostics.at(-1).outcome,'cancelled')
})
await test('real approval decisions repeat once grants and distinguish expanded operations',async f=>{
 const t=await f.call('run_task',{task:'approval first'}),id=t.body.sessionId
 await f.call('run_task',{task:'approval same',sessionId:id});await f.call('run_task',{task:'approval expanded',sessionId:id});assert.equal(f.asked,3)
 f.values.approvalMode='never';const r=await f.call('run_task',{task:'approval denied',sessionId:id});assert.equal(f.asked,3);assert.equal(r.body.approvalDiagnostics.at(-1).outcome,'rejected');assert.equal(r.body.approval.persistentGrants,false)
 f.values.approvalMode='ask';await f.call('run_task',{task:'approval ask again',sessionId:id});assert.equal(f.asked,4)
})
await test('changed session version invalidates a delete confirmation',async f=>{
 const t=await f.call('run_task',{task:'initial'});const p=await f.call('manage_sessions',{workspace:'ws',action:'delete'});await f.call('run_task',{task:'changed',sessionId:t.body.sessionId});const r=await f.call('manage_sessions',{workspace:'ws',action:'delete',confirm:true,previewToken:p.body.previewToken});assert.equal(r.error,true);assert.match(r.body,/SESSION_CHANGED/);assert.ok(f.workspace.sessionIds.includes(t.body.sessionId))
})
await test('batch delete without a preview token is refused',async f=>{
 await f.call('run_task',{task:'initial'});const r=await f.call('manage_sessions',{workspace:'ws',action:'delete',confirm:true});assert.equal(r.error,true);assert.match(r.body,/CONFIRMATION_REQUIRED/)
})
await test('owner flush after preview cannot add unconfirmed data to deletion',async f=>{
 const original=f.ctx.agents.create.bind(f.ctx.agents)
 f.ctx.agents.create=async options=>{const handle=await original(options),dispose=handle.dispose;handle.dispose=async()=>{await dispose();await appendFile(join(f.home,'sessions','fixture',options.sessionId,'session.v4.jsonl'),'{}\n')};return handle}
 const t=await f.call('run_task',{task:'fixture owner flush'}),id=t.body.sessionId,p=await f.call('manage_sessions',{workspace:'ws',action:'delete'});const r=await f.call('manage_sessions',{workspace:'ws',action:'delete',confirm:true,previewToken:p.body.previewToken});assert.equal(r.body.done,0);assert.equal(r.body.failed,1);assert.match(r.body.results[0].detail,/SESSION_CHANGED/);assert.ok(await stat(join(f.home,'sessions','fixture',id,'session.v4.jsonl')))
})
await test('projection cache junction is checked before removing session files',async f=>{
 const id='session-cache',file=await f.sessionFile(id),outside=join(f.home,'outside-cache');await mkdir(outside);await writeFile(join(outside,id+'.json'),'keep');await mkdir(join(f.home,'storages','session_projcache'),{recursive:true});await symlink(outside,join(f.home,'storages','session_projcache','sessions'),process.platform==='win32'?'junction':'dir');const r=await f.call('delete_session',{sessionId:id,confirm:true});assert.equal(r.error,true);assert.ok(await stat(file));assert.equal(await readFile(join(outside,id+'.json'),'utf8'),'keep')
})
await test('directory existence and workspace membership do not prove a real session',async f=>{
 const id='session-fake',dir=join(f.home,'sessions','fixture',id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'marker'),'keep');f.workspace.sessionIds.push(id);const r=await f.call('delete_session',{sessionId:id,confirm:true});assert.equal(r.error,true);assert.equal(await readFile(join(dir,'marker'),'utf8'),'keep')
})
await test('a different backend root cannot authorize deleting a same-ID local directory',async f=>{
 const id='session-other-root',file=await f.sessionFile(id);f.ctx.sessionPersistence.root=join(f.home,'other-sessions');const r=await f.call('delete_session',{sessionId:id,confirm:true});assert.equal(r.error,true);assert.match(r.body,/UNSUPPORTED_SESSION_STORAGE/);assert.ok(await stat(file))
})
await test('task acceptance failure starts no agent and is explicit',async f=>{
 const path=join(f.home,'mcp-bridge','tasks.json');await rm(path);await mkdir(path);try{const r=await f.call('start_task',{task:'must-not-start'});assert.equal(r.error,true);assert.match(r.body,/STORAGE_WRITE_FAILED/);assert.equal(f.sent.length,0);assert.equal(f.live.size,0)}finally{await rm(path,{recursive:true});await writeFile(path,'[]')}
})
await test('recovery reconstructs a pending approval and reserves the concurrency slot',async f=>{
 const r=await f.call('get_task',{taskId:'task-recovered'});assert.equal(r.body.status,'waiting_approval');assert.equal(r.body.progress.pendingApproval.toolName,'write')
 const t=await f.call('start_task',{task:'after-recovered'});await sleep(25);assert.ok(!f.sent.some(x=>x.text==='after-recovered'));f.recoveryAnswer.resolve('allowed-once');await f.call('wait_task',{taskId:'task-recovered'});const next=await f.call('wait_task',{taskId:t.body.taskId});assert.equal(next.body.status,'done')
},async f=>{
 f.config.maxConcurrentTasks=1;f.recoveryAnswer=gate();f.answer=()=>f.recoveryAnswer.promise
 const id='session-recovered';await f.sessionFile(id,{mcp:true});const agent=f.agent(id,{provider:'p',model:'a',reasoningEffort:'high'});f.live.set(id,agent);agent.followup({content:[{type:'text',text:'approval slow:100'}]});await sleep(10)
 await writeFile(join(f.home,'mcp-bridge','tasks.json'),JSON.stringify([{id:'task-recovered',sessionId:id,status:'waiting_approval',createdAt:Date.now(),provider:'p',model:'a',reasoningEffort:'high',task:'fixture recovery',baseline:0,eventBaseline:0,progress:{steps:0,toolCalls:0,lastActivityAt:Date.now()}}]))
})
await test('automatic cleanup uses the same fresh-log activity rule as batch filtering',async f=>{
 const a=await f.call('run_task',{task:'old directory, fresh log'}),b=await f.call('run_task',{task:'genuinely old log'})
 for(let i=0;i<9;i++)await f.call('run_task',{task:'evict '+i})
 const old=new Date(Date.now()-20*86400000),dir=id=>join(f.home,'sessions','fixture',id),file=id=>join(dir(id),'session.v4.jsonl')
 await utimes(dir(a.body.sessionId),old,old);await appendFile(file(a.body.sessionId),'{}\n');await utimes(file(b.body.sessionId),old,old);await utimes(dir(b.body.sessionId),old,old)
 await f.ctx.settings.update('mcp-bridge',{autoCleanupDays:7});for(let i=0;i<100&&!f.values.cleanupStatus;i++)await sleep(10)
 const result=JSON.parse(f.values.cleanupStatus);assert.equal(result.deleted,1);assert.ok(await stat(file(a.body.sessionId)));await assert.rejects(stat(file(b.body.sessionId)),{code:'ENOENT'})
})
await test('a terminal persistence failure is reported without falsifying the task result',async f=>{
 const t=await f.call('start_task',{task:'slow:120'});for(let i=0;i<100&&!f.requests.length;i++)await sleep(5)
 const path=join(f.home,'mcp-bridge','tasks.json');await rm(path);await mkdir(path)
 try{const r=await f.call('wait_task',{taskId:t.body.taskId});assert.equal(r.body.status,'done');assert.equal(r.body.durability,'degraded');assert.equal(r.body.persistenceError,'STORAGE_WRITE_FAILED')}finally{await rm(path,{recursive:true});await writeFile(path,'[]')}
})
await test('tampered and legacy pending-delete paths never remove an outside marker',async f=>{
 await sleep(5200);assert.equal(await readFile(join(f.home,'outside-pending','marker'),'utf8'),'keep');assert.ok(f.logs.some(l=>l.includes('pending delete refused')))
},async f=>{
 const outside=join(f.home,'outside-pending');await mkdir(outside);await writeFile(join(outside,'marker'),'keep');await mkdir(join(f.home,'mcp-bridge'),{recursive:true});await writeFile(join(f.home,'mcp-bridge','pending-deletes.json'),JSON.stringify([{id:'../../outside-pending',directory:outside},{id:'session-legacy',directory:outside,version:'forged'}]))
})
console.log(`REGRESSION ${passed} passed, ${failures} failed`)
process.exitCode=failures?1:0
